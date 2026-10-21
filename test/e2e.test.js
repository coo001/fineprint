// End to end over real HTTP in MOCK mode with the saved Nebius × NVIDIA pages as fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { getConfig } from '../src/config.js';

const URLS = ['https://nebiusglobalaihackathon.devpost.com/rules', 'https://nebiusglobalaihackathon.devpost.com/', 'https://nebiusglobalaihackathon.devpost.com/resources'];

async function run(entry) {
  const srv = createServer(getConfig({ FINEPRINT_MOCK: '1' }), { fetchImpl: () => { throw new Error('network disabled in test'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await (await fetch(base + '/api/config')).json()).mode, 'MOCK');
    assert.match(await (await fetch(base + '/')).text(), /FinePrint/);
    const res = await fetch(base + '/api/check', { method: 'POST', body: JSON.stringify({ urls: URLS, timeZone: 'Asia/Seoul', entry }) });
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    return events;
  } finally { srv.close(); }
}

test('draft entry: license, README and video length fail; deadline 10/31 02:00 KST; city-award conflict found', async () => {
  const ev = await run({ repoUrl: 'https://github.com/sample-builder/draft-agent', videoUrl: 'https://youtu.be/x', videoMinutes: 3.6, track: 'Best Apps and Agents', city: 'Seoul' });
  assert.deepEqual([...new Set(ev.filter((e) => e.type === 'step').map((e) => e.step))], ['sources', 'extract', 'verify', 'evidence', 'judge', 'deep']);
  const done = ev.find((e) => e.type === 'done'); assert.ok(done, JSON.stringify(ev.find((e) => e.type === 'error')));
  const rep = done.report;
  assert.equal(rep.deadline.utc, '2026-10-30T17:00:00.000Z'); assert.match(rep.deadline.local, /2026-10-31, 02:00/);
  const failed = rep.requirements.filter((r) => r.result?.status === 'fail').map((r) => r.quote).join(' ');
  assert.match(failed, /license/i); assert.match(failed, /README/); assert.match(failed, /three \(3\) minutes|3-minute/);
  assert.equal(rep.conflicts.length >= 1, true); assert.match(rep.conflicts.map((c) => c.explanation).join(), /attend/);
  assert.ok(rep.requirements.every((r) => r.quoteVerified));
  assert.match(done.markdown, /# FinePrint report \(MOCK\)/);
  assert.equal(ev.filter((e) => e.type === 'call').length > 5, true);
});

test('fixed entry: no failing or open items', async () => {
  const ev = await run({ repoUrl: 'https://github.com/sample-builder/fixed-agent', videoUrl: 'https://youtu.be/x', videoMinutes: 2.7, demoUrl: 'https://example.com', track: 'Best Apps and Agents', description: 'FinePrint reads the official rules and checks an entry.', feedback: 'Token Factory feedback that is long enough to count as written feedback.' });
  const rep = ev.find((e) => e.type === 'done').report;
  assert.equal(rep.counts.fail, 0); assert.equal(rep.counts.action, 0);
});

test('rejects a request without URLs', async () => {
  const srv = createServer(getConfig({ FINEPRINT_MOCK: '1' }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/check`, { method: 'POST', body: '{"urls":["ftp://x"]}' }); assert.equal(r.status, 400); }
  finally { srv.close(); }
});
