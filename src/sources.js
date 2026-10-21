// Gets the text of each official page. Order: Tavily Extract (if key) -> local fixture (MOCK only) -> direct fetch.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { safeFetch, checkUrlSyntax } from './safety.js';

export function htmlToText(html) {
  let h = html.replace(/<(script|style|noscript|svg|nav|header|footer)[\s\S]*?<\/\1>/gi, ' ');
  const main = h.match(/<main[\s\S]*<\/main>/i) || h.match(/<article[\s\S]*<\/article>/i);
  const body = h.match(/<body[\s\S]*<\/body>/i);
  if (main && (!body || main[0].length > body[0].length * 0.3)) h = main[0]; else if (body) h = body[0];
  h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|table|ul|ol)>/gi, '\n').replace(/<li[^>]*>/gi, '- ');
  h = h.replace(/<[^>]+>/g, ' ');
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–' };
  h = h.replace(/&(#?\w+);/g, (m, e) => ent[e] ?? (e.startsWith('#') ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/, '0x'))) : m));
  return h.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function fixtureName(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/_+$/, '') + '.txt';
}

export async function tavilyExtract(urls, apiKey, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ urls, extract_depth: 'advanced' }),
  });
  if (!res.ok) throw new Error(`Tavily extract ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return { results: data.results || [], failed: data.failed_results || [] };
}

// Looks for official pages the user did not paste (FAQ, rules, updates) on the same site.
export async function tavilySearch(query, apiKey, fetchImpl = fetch, includeDomains) {
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 5, include_domains: includeDomains }),
  });
  if (!res.ok) throw new Error(`Tavily search ${res.status}`);
  return (await res.json()).results || [];
}

export async function getSources(urls, cfg, { fetchImpl = fetch, log = () => {} } = {}) {
  const out = [];
  let rest = [...urls];
  rest.forEach(checkUrlSyntax);
  if (!cfg.tavily.mock) {
    const { results, failed } = await tavilyExtract(rest, cfg.tavily.apiKey, fetchImpl);
    for (const r of results) out.push({ url: r.url, text: r.raw_content, via: 'tavily-extract' });
    log(`Tavily Extract: ${results.length} page(s)${failed.length ? `, ${failed.length} failed` : ''}`);
    rest = rest.filter((u) => !out.some((o) => o.url === u));
  }
  for (const url of rest) {
    const fx = path.join(cfg.root, 'fixtures', 'pages', fixtureName(url));
    if (cfg.mock && existsSync(fx)) { out.push({ url, text: readFileSync(fx, 'utf8'), via: 'fixture' }); continue; }
    const res = await safeFetch(url, { fetchImpl, lookup: cfg.lookup, limits: cfg.limits, headers: { 'user-agent': 'Mozilla/5.0 FinePrint' } });
    if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
    out.push({ url, text: htmlToText(res.text), via: 'direct-fetch' });
  }
  // Cap text sent to models: per source and in total (code truncates, models never see the rest).
  const perSrc = cfg.limits?.maxSourceChars ?? 60_000; let budget = cfg.limits?.maxTotalSourceChars ?? 120_000;
  for (const s of out) {
    const keep = Math.max(0, Math.min(String(s.text || '').length, perSrc, budget));
    if (keep < String(s.text || '').length) log(`Source text truncated to ${keep} characters (limit)`);
    s.text = String(s.text || '').slice(0, keep); budget -= keep;
  }
  return out.map((s, i) => ({ ...s, id: `S${i + 1}` }));
}

// Splits a page into ~maxChars chunks on line boundaries so the fast model can run them in parallel.
export function chunkText(text, maxChars = 6000) {
  const lines = text.split('\n'); const chunks = []; let cur = '';
  for (const l of lines) {
    if (cur.length + l.length + 1 > maxChars && cur) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
