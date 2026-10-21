// Safety regressions for the public demo: SSRF, size/time caps, input limits, LIVE gating, cost guards. No network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { getConfig, publicConfig } from '../src/config.js';
import { makeLLM } from '../src/llm.js';
import { isBlockedIp, checkUrlSyntax, assertPublicUrl, safeFetch, validateInput, createGuard } from '../src/safety.js';

const pub = (a = '93.184.216.34') => async () => [{ address: a, family: 4 }];
const html = (body, headers = {}) => new Response(body, { headers: { 'content-type': 'text/html', ...headers } });

test('blocks loopback, private, link-local/metadata, mapped and odd IP forms', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::'])
    assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
});

test('URL syntax: scheme, credentials, ports, local names and IP literal spellings', () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'http://user:pw@example.com/', 'http://example.com:8080/', 'http://localhost/', 'http://foo.internal/', 'http://metadata.google.internal/', 'http://intranet/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/'])
    assert.throws(() => checkUrlSyntax(u), /allowed|valid/i, u);
  assert.doesNotThrow(() => checkUrlSyntax('https://nebiusglobalaihackathon.devpost.com/rules'));
});

test('DNS result pointing at a private address is rejected', async () => {
  await assert.rejects(assertPublicUrl('https://evil.example.com/', { lookup: pub('169.254.169.254') }), /private/);
  await assert.rejects(assertPublicUrl('https://evil.example.com/', { lookup: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.5' }] }), /private/);
  await assert.doesNotReject(assertPublicUrl('https://ok.example.com/', { lookup: pub() }));
});

test('safeFetch re-validates redirects (public host redirecting to metadata is blocked)', async () => {
  const seen = [];
  const fetchImpl = async (u) => { seen.push(u); return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }); };
  await assert.rejects(safeFetch('https://ok.example.com/', { fetchImpl, lookup: pub() }), /allowed|private/i);
  assert.deepEqual(seen, ['https://ok.example.com/']);
  const loop = async () => new Response(null, { status: 302, headers: { location: 'https://ok.example.com/' } });
  await assert.rejects(safeFetch('https://ok.example.com/', { fetchImpl: loop, lookup: pub() }), /redirects/);
});

test('safeFetch caps response bytes (header and streamed) and content type', async () => {
  const limits = { fetchMaxBytes: 1000 };
  await assert.rejects(safeFetch('https://ok.example.com/', { fetchImpl: async () => html('x', { 'content-length': '999999' }), lookup: pub(), limits }), /larger/);
  await assert.rejects(safeFetch('https://ok.example.com/', { fetchImpl: async () => html('x'.repeat(5000)), lookup: pub(), limits }), /larger/);
  await assert.rejects(safeFetch('https://ok.example.com/', { fetchImpl: async () => new Response('x', { headers: { 'content-type': 'application/zip' } }), lookup: pub(), limits }), /content type/);
  assert.equal((await safeFetch('https://ok.example.com/', { fetchImpl: async () => html('hello'), lookup: pub(), limits })).text, 'hello');
});

test('safeFetch passes an abort signal (time limit)', async () => {
  let sig;
  await safeFetch('https://ok.example.com/', { fetchImpl: async (u, o) => { sig = o.signal; return html('a'); }, lookup: pub(), limits: { fetchTimeoutMs: 50 } });
  assert.ok(sig instanceof AbortSignal);
  await assert.rejects(safeFetch('https://ok.example.com/', { fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))), lookup: pub(), limits: { fetchTimeoutMs: 30 } }), /abort/);
});

test('input limits: URL count, URL length, entry field size, bad shapes', () => {
  const L = getConfig({}).limits;
  assert.throws(() => validateInput({ urls: Array.from({ length: L.maxUrls + 1 }, (_, i) => `https://e.com/${i}`) }, L), /At most/);
  assert.throws(() => validateInput({ urls: ['https://e.com/' + 'a'.repeat(L.maxUrlLength)] }, L), /longer/);
  assert.throws(() => validateInput({ urls: ['https://e.com/'], entry: { description: 'x'.repeat(L.maxFieldChars + 1) } }, L), /longer/);
  assert.throws(() => validateInput({ urls: ['http://127.0.0.1/'] }, L), /allowed/);
  assert.throws(() => validateInput({ urls: 'https://e.com' }, L), /list/);
  assert.deepEqual(validateInput({ urls: ['https://e.com/', 'https://e.com/'], entry: { a: 'b', bad: { x: 1 } } }, L).entry, { a: 'b' });
});

test('model call limits: input size, output clamp, call count, total token estimate, timeout signal', async () => {
  const reqs = [];
  const fetchImpl = async (u, o) => { reqs.push(JSON.parse(o.body)); assert.ok(o.signal); return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }], usage: {} })); };
  const mk = (limits) => makeLLM({ ...getConfig({ NEBIUS_API_KEY: 'k' }), limits: { ...getConfig({}).limits, ...limits } }, { fetchImpl });
  await assert.rejects(mk({ maxInputCharsPerCall: 100 }).chat({ tier: 'fast', step: 't', system: 's', user: 'u'.repeat(200) }), /Input limit/);
  await mk({ maxOutputTokens: 500 }).chat({ tier: 'fast', step: 't', system: 's', user: 'u', maxTokens: 6000 });
  assert.equal(reqs.at(-1).max_tokens, 500);
  const few = mk({ maxCalls: 2 });
  await few.chat({ tier: 'fast', step: 't', system: 's', user: 'u' }); await few.chat({ tier: 'fast', step: 't', system: 's', user: 'u' });
  await assert.rejects(few.chat({ tier: 'fast', step: 't', system: 's', user: 'u' }), /Request limit/);
  await assert.rejects(mk({ maxTotalTokens: 3000 }).chat({ tier: 'fast', step: 't', system: 's', user: 'u', maxTokens: 4000 }), /estimated tokens/);
});

test('guard: concurrency cap, per-IP window, daily LIVE runs and token reservation with settle', () => {
  let t = Date.UTC(2026, 9, 21, 10);
  const L = { ...getConfig({}).limits, maxConcurrent: 2, ipMaxRuns: 3, ipWindowMs: 1000, dailyLiveRuns: 2, dailyLiveTokens: 300_000, maxTotalTokens: 200_000 };
  const g = createGuard(L, () => t);
  const a = g.acquire({ ip: '1' }), b = g.acquire({ ip: '2' });
  assert.throws(() => g.acquire({ ip: '3' }), /busy/);
  a.release(); b.release();
  g.acquire({ ip: '1' }).release(); g.acquire({ ip: '1' }).release();
  assert.throws(() => g.acquire({ ip: '1' }), /Too many/);
  t += 2000;
  g.acquire({ ip: '1', live: true }).release(10_000); // settles: only 10k of 200k used
  g.acquire({ ip: '1', live: true }).release(10_000);
  assert.throws(() => g.acquire({ ip: '1', live: true }), /Daily LIVE/);
  t += 24 * 3600 * 1000;
  g.acquire({ ip: '1', live: true }).release(0);
});

async function serve(env, opts) {
  const cfg = getConfig(env); cfg.lookup = pub();
  const srv = createServer(cfg, opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { cfg, srv, base: `http://127.0.0.1:${srv.address().port}` };
}
const post = (base, body, headers = {}) => fetch(base + '/api/check', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const PUBLIC = { VERCEL: '1', NEBIUS_API_KEY: 'sk-test', TAVILY_API_KEY: 'tv-test' };

test('public deployment defaults to MOCK even with keys; no model/Tavily call is made', async () => {
  const calls = [];
  const { srv, base, cfg } = await serve(PUBLIC, { fetchImpl: async (u) => { calls.push(u); throw new Error('network disabled'); } });
  try {
    const c = await (await fetch(base + '/api/config')).json();
    assert.equal(c.mode, 'MOCK'); assert.equal(c.liveGate, 'disabled'); assert.equal(c.tavily, 'MOCK');
    assert.equal(JSON.stringify(c).includes('sk-test'), false);
    const r = await post(base, { urls: ['https://nebiusglobalaihackathon.devpost.com/rules'] }, { 'x-demo-token': 'whatever' });
    assert.equal(r.status, 403); // token supplied but LIVE not enabled
    const ok = await post(base, { urls: ['https://nebiusglobalaihackathon.devpost.com/rules'] });
    const ev = (await ok.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(ev.find((e) => e.type === 'done').report.mode, 'MOCK');
    assert.deepEqual(calls, []);
    assert.equal(cfg.mock, true);
  } finally { srv.close(); }
});

test('LIVE on a public deployment needs key + ENABLE_LIVE + secret token; wrong token is refused', async () => {
  const env = { ...PUBLIC, BLOB_READ_WRITE_TOKEN: 'blob-test', FINEPRINT_ENABLE_LIVE: '1', FINEPRINT_DEMO_TOKEN: 'a-long-secret-token-123' };
  const seen = [];
  const fetchImpl = async (u, o = {}) => {
    seen.push({ u, auth: o.headers?.authorization });
    if (u.endsWith('/chat/completions')) return new Response('stop', { status: 500 });
    if (u.includes('tavily')) return new Response(JSON.stringify({ results: [{ url: 'https://a.example.com/', raw_content: 'Rules text here.' }], failed_results: [] }));
    return html('<body><p>Rules text here.</p></body>');
  };
  const ledger = { reserve: async () => ({}) };
  const { srv, base } = await serve(env, { fetchImpl, ledger });
  try {
    assert.equal((await (await fetch(base + '/api/config')).json()).liveGate, 'token-required');
    assert.equal((await post(base, { urls: ['https://a.example.com/'] }, { 'x-demo-token': 'nope' })).status, 403);
    assert.equal(seen.length, 0);
    const noTok = (await (await post(base, { urls: ['https://a.example.com/'] })).text());
    assert.equal(seen.some((s) => s.u.includes('tokenfactory')), false); assert.match(noTok, /done|error/);
    const live = await (await post(base, { urls: ['https://a.example.com/'] }, { 'x-demo-token': 'a-long-secret-token-123' })).text();
    assert.ok(seen.some((s) => s.u.endsWith('/chat/completions') && s.auth === 'Bearer sk-test'), live);
  } finally { srv.close(); }
});

test('server rejects oversized bodies, bad JSON, SSRF URLs; returns 429 when busy or over IP rate', async () => {
  const { srv, base, cfg } = await serve({ FINEPRINT_MOCK: '1', LIMIT_IP_MAX_RUNS: '2' });
  try {
    assert.equal((await post(base, JSON.stringify({ urls: ['https://e.com/'], pad: 'x'.repeat(cfg.limits.maxBodyBytes) }))).status, 413);
    assert.equal((await post(base, '{nope')).status, 400);
    for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:3456/', 'http://[::1]/', 'file:///etc/passwd']) assert.equal((await post(base, { urls: [u] })).status, 400, u);
    const U = { urls: ['https://nebiusglobalaihackathon.devpost.com/rules'] };
    assert.equal((await post(base, U)).status, 200); assert.equal((await post(base, U)).status, 200);
    assert.equal((await post(base, U)).status, 429);
  } finally { srv.close(); }
});

test('server returns 429 while the concurrency slots are taken', async () => {
  const cfg = getConfig({ FINEPRINT_MOCK: '1' });
  const guard = createGuard({ ...cfg.limits, maxConcurrent: 1 });
  const held = guard.acquire({ ip: 'x' });
  const srv = createServer(cfg, { guard }); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { assert.equal((await post(`http://127.0.0.1:${srv.address().port}`, { urls: ['https://e.com/'] })).status, 429); } finally { held.release(); srv.close(); }
});

test('local (non-public) config keeps LIVE open when a key is present, and public config reports the gate', () => {
  assert.equal(publicConfig(getConfig({ NEBIUS_API_KEY: 'k' })).mode, 'LIVE');
  assert.equal(getConfig({ VERCEL: '1', NEBIUS_API_KEY: 'k', FINEPRINT_ENABLE_LIVE: '1', FINEPRINT_DEMO_TOKEN: 'short' }).gate.liveUnlockable, false);
  assert.equal(getConfig({ FINEPRINT_PUBLIC: '1', NEBIUS_API_KEY: 'k', FINEPRINT_ENABLE_LIVE: '1', FINEPRINT_DEMO_TOKEN: 'x'.repeat(16) }).gate.liveUnlockable, false); // no BLOB_READ_WRITE_TOKEN => LIVE stays OFF
  assert.equal(getConfig({ FINEPRINT_PUBLIC: '1', BLOB_READ_WRITE_TOKEN: 'b', NEBIUS_API_KEY: 'k', FINEPRINT_ENABLE_LIVE: '1', FINEPRINT_DEMO_TOKEN: 'x'.repeat(16) }).gate.liveUnlockable, true);
  assert.equal(getConfig({}).ledger.capUsd, 0.65);
  assert.equal(getConfig({ FINEPRINT_LEDGER_CAP_USD: '100' }).ledger.capUsd, 0.65);
});
