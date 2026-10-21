// Public-demo safety: SSRF-safe fetching with byte/time caps, input validation, concurrency and daily budget guard.
// Limits are per server instance and held in memory (see README "Public demo safety" for what that means on serverless).
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';

export class SafetyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function v4ToInt(ip) { return ip.split('.').reduce((a, b) => a * 256 + Number(b), 0); }
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
].map(([b, n]) => [v4ToInt(b), n]);

function blockedV4(ip) {
  const x = v4ToInt(ip);
  return V4_BLOCKED.some(([b, n]) => Math.floor(x / 2 ** (32 - n)) === Math.floor(b / 2 ** (32 - n)));
}

function expandV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) { const n = v4ToInt(dotted[1]); s = s.slice(0, -dotted[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16); }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const mid = s.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...mid, ...t].map((g) => parseInt(g || '0', 16));
}

// True when the IP is loopback / private / link-local (cloud metadata 169.254.169.254) / reserved / embeds such an address.
export function isBlockedIp(ip) {
  const k = net.isIP(ip);
  if (k === 4) return blockedV4(ip);
  if (k !== 6) return true;
  const g = expandV6(ip);
  if (g.length !== 8 || g.some(Number.isNaN)) return true;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 && g[7] <= 1 ? true : blockedV4(v4(g[6], g[7])); // ::, ::1, ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if (g[0] === 0x2002) return true; // 6to4
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return true; // ULA, link-local, multicast
  if (g[0] === 0x2001 && (g[1] === 0xdb8 || g[1] === 0)) return true; // documentation, Teredo
  return false;
}

// Sync checks (no DNS): scheme, credentials, port, obvious local names, IP literals.
export function checkUrlSyntax(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new SafetyError('Not a valid URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SafetyError('Only http(s) URLs are allowed.');
  if (u.username || u.password) throw new SafetyError('URLs with credentials are not allowed.');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443') throw new SafetyError('Only ports 80 and 443 are allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new SafetyError('URL has no host.');
  if (net.isIP(host)) { if (isBlockedIp(host)) throw new SafetyError('Local and private network addresses are not allowed.'); }
  else if (host === 'localhost' || !host.includes('.') || /\.(localhost|local|internal|lan|home|corp|intranet|arpa)$/.test(host)) throw new SafetyError('Local and internal host names are not allowed.');
  return { url: u, host };
}

// Sync checks + DNS: every resolved address must be public.
export async function assertPublicUrl(raw, { lookup = (h) => dns.lookup(h, { all: true, verbatim: true }) } = {}) {
  const { url, host } = checkUrlSyntax(raw);
  if (!net.isIP(host)) {
    let addrs;
    try { addrs = await lookup(host); } catch { throw new SafetyError('Host name could not be resolved.'); }
    if (!addrs?.length || addrs.some((a) => isBlockedIp(a.address))) throw new SafetyError('Host resolves to a local or private network address.');
  }
  return url;
}

async function readCapped(res, maxBytes) {
  const len = Number(res.headers?.get?.('content-length'));
  if (len > maxBytes) { res.body?.cancel?.().catch(() => {}); throw new SafetyError(`Response larger than ${maxBytes} bytes.`, 413); }
  if (!res.body?.getReader) { const t = await res.text(); if (Buffer.byteLength(t) > maxBytes) throw new SafetyError(`Response larger than ${maxBytes} bytes.`, 413); return t; }
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) { reader.cancel().catch(() => {}); throw new SafetyError(`Response larger than ${maxBytes} bytes.`, 413); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Fetches a user-supplied URL: re-validates every redirect hop, caps time, redirects and bytes.
// readBody:false returns only the status (body is discarded).
export async function safeFetch(rawUrl, { fetchImpl = fetch, lookup, limits = {}, readBody = true, headers = {} } = {}) {
  const { fetchTimeoutMs = 8000, fetchMaxBytes = 1_500_000, maxRedirects = 3 } = limits;
  const signal = AbortSignal.timeout(fetchTimeoutMs);
  let current = String(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = await assertPublicUrl(current, { lookup });
    const res = await fetchImpl(u.href, { method: 'GET', redirect: 'manual', headers, signal });
    if (res.status >= 300 && res.status < 400 && res.headers?.get?.('location')) {
      res.body?.cancel?.().catch(() => {});
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    const ct = String(res.headers?.get?.('content-type') || '');
    if (readBody && ct && !/^(text\/|application\/(xhtml|xml|json))/i.test(ct)) { res.body?.cancel?.().catch(() => {}); throw new SafetyError(`Unsupported content type: ${ct.slice(0, 60)}`, 415); }
    const text = readBody && res.ok ? await readCapped(res, fetchMaxBytes) : (res.body?.cancel?.().catch(() => {}), '');
    return { ok: res.ok, status: res.status, text, finalUrl: u.href };
  }
  throw new SafetyError('Too many redirects.');
}

// Request input validation. Returns a cleaned copy; throws SafetyError(400/413).
export function validateInput(input, limits) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SafetyError('Body must be a JSON object.');
  if (!Array.isArray(input.urls)) throw new SafetyError('urls must be a list.');
  const urls = [...new Set(input.urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)))];
  if (!urls.length) throw new SafetyError('Give at least one http(s) URL of an official page.');
  if (urls.length > limits.maxUrls) throw new SafetyError(`At most ${limits.maxUrls} URLs per check.`, 413);
  for (const u of urls) { if (u.length > limits.maxUrlLength) throw new SafetyError(`URL longer than ${limits.maxUrlLength} characters.`, 413); checkUrlSyntax(u); }
  const entry = {};
  for (const [k, v] of Object.entries(input.entry && typeof input.entry === 'object' ? input.entry : {})) {
    if (typeof v === 'string') { if (v.length > limits.maxFieldChars) throw new SafetyError(`Entry field "${k}" is longer than ${limits.maxFieldChars} characters.`, 413); entry[k] = v; }
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) entry[k] = v;
  }
  const timeZone = typeof input.timeZone === 'string' && input.timeZone.length <= 64 ? input.timeZone : undefined;
  return { urls, entry, timeZone };
}

export async function readBodyCapped(req, maxBytes) {
  if (Number(req.headers['content-length']) > maxBytes) throw new SafetyError('Request body too large.', 413);
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > maxBytes) throw new SafetyError('Request body too large.', 413); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

// In-memory guard: concurrency cap, per-IP window, daily LIVE run and token budget. Resets on restart / differs per instance.
export function createGuard(limits, now = () => Date.now()) {
  let running = 0, day = '', liveRuns = 0, liveTokens = 0;
  const ips = new Map();
  const roll = () => { const d = new Date(now()).toISOString().slice(0, 10); if (d !== day) { day = d; liveRuns = 0; liveTokens = 0; } };
  return {
    acquire({ ip = 'unknown', live = false }) {
      roll();
      if (running >= limits.maxConcurrent) throw new SafetyError('Server is busy. Try again in a minute.', 429);
      const t = now(); const hits = (ips.get(ip) || []).filter((x) => t - x < limits.ipWindowMs);
      if (hits.length >= limits.ipMaxRuns) throw new SafetyError('Too many checks from this address. Try again later.', 429);
      if (live) {
        if (liveRuns >= limits.dailyLiveRuns) throw new SafetyError('Daily LIVE demo budget is used up. MOCK mode is still available.', 429);
        if (liveTokens + limits.maxTotalTokens > limits.dailyLiveTokens) throw new SafetyError('Daily LIVE token budget is used up. MOCK mode is still available.', 429);
        liveRuns++; liveTokens += limits.maxTotalTokens; // reserve worst case, settle after the run
      }
      hits.push(t); ips.set(ip, hits); if (ips.size > 5000) ips.clear();
      running++;
      let done = false;
      return { release(actualTokens) { if (done) return; done = true; running--; if (live && Number.isFinite(actualTokens)) liveTokens -= Math.max(0, limits.maxTotalTokens - actualTokens); } };
    },
    stats: () => ({ running, liveRuns, liveTokens, day }),
  };
}
