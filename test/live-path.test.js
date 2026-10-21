// Exercises the LIVE code path (Token Factory + Tavily + GitHub) against a stubbed fetch: no network, no keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { makeLLM } from '../src/llm.js';
import { runCheck } from '../src/pipeline.js';

const RULES = 'Submission Period: Wednesday, August 26, 2026 (9:00 am Pacific Time) – Friday, October 30, 2026 (10:00 am Pacific Time).\nThe repository must be public and open source by including an open source license file.\nCity Winner Awards go to Entrants attending one of the participating IRL city events.';
const RES = 'You don’t need to attend an event to enter the hackathon or qualify for a $500 City Winner Award.';

function stub(log) {
  return async (url, opt = {}) => {
    const body = opt.body ? JSON.parse(opt.body) : null;
    log.push({ url, auth: opt.headers?.authorization, model: body?.model, body });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.tavily.com/extract') return json({ results: body.urls.map((u) => ({ url: u, raw_content: u.endsWith('/rules') ? RULES : RES })), failed_results: [] });
    if (url.startsWith('https://api.github.com/repos/me/app/readme')) return new Response('# App\nUses NVIDIA Nemotron on Nebius Token Factory. npm install');
    if (url.startsWith('https://api.github.com/repos/me/app')) return json({ private: false, full_name: 'me/app', license: null });
    if (url.startsWith('https://www.youtube.com/oembed')) return json({ title: 'v' });
    if (url.endsWith('/chat/completions')) {
      const sys = body.messages[0].content, user = body.messages[1].content;
      let out;
      if (sys.startsWith('You read official')) {
        out = user.includes('Submission Period')
          ? { requirements: [
            { category: 'deadline', kind: 'info', requirement: 'Submit by Oct 30', quote: 'Friday, October 30, 2026 (10:00 am Pacific Time)' },
            { category: 'repository', kind: 'hard', requirement: 'Public repo with license', quote: 'The repository must be public and open source by including an open source license file.' },
            { category: 'prize', kind: 'info', requirement: 'City award needs attendance', quote: 'City Winner Awards go to Entrants attending one of the participating IRL city events.' },
            { category: 'video', kind: 'hard', requirement: 'Video under 10 min', quote: 'Videos may be up to ten minutes long.' } ] } // fabricated: not in source
          : { requirements: [{ category: 'prize', kind: 'info', requirement: 'No attendance needed', quote: 'You don’t need to attend an event to enter the hackathon or qualify for a $500 City Winner Award.' }] };
      } else if (sys.startsWith('You check')) {
        const ids = [...user.matchAll(/"id":"(R\d+)"/g)].map((m) => m[1]);
        out = { results: ids.map((id) => ({ id, status: 'fail', reason: 'evidence.repo.license is null', fix: 'Add LICENSE' })) };
      } else {
        out = { conflicts: [{ a: 'R03', b: 'R05', topic: 'City award', explanation: 'x', whatToDo: 'ask' }, { a: 'R03', b: 'R99', topic: 'bogus', explanation: 'y', whatToDo: 'z' }], topFixes: ['Add LICENSE'], verdict: 'Not ready.' };
      }
      return json({ choices: [{ message: { content: '<think>ok</think>' + JSON.stringify(out) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }
    throw new Error('unexpected url ' + url);
  };
}

test('LIVE path: right endpoint, key, model per tier; fabricated quotes never reach the judge; bogus conflicts dropped', async () => {
  const log = [];
  const cfg = getConfig({ NEBIUS_API_KEY: 'test-key', TAVILY_API_KEY: 'tvly-test' });
  const rep = await runCheck({ urls: ['https://x.devpost.com/rules', 'https://x.devpost.com/resources'], timeZone: 'Asia/Seoul', entry: { repoUrl: 'https://github.com/me/app', videoUrl: 'https://youtu.be/abc', videoMinutes: 2.5, track: 'Best Apps and Agents' } }, cfg, { fetchImpl: stub(log) });
  const llmCalls = log.filter((l) => l.url.endsWith('/chat/completions'));
  assert.ok(llmCalls.every((c) => c.url === 'https://api.tokenfactory.nebius.com/v1/chat/completions' && c.auth === 'Bearer test-key'));
  assert.deepEqual(llmCalls.map((c) => c.model), [cfg.models.fast, cfg.models.fast, cfg.models.mid, cfg.models.deep]);
  assert.ok(log.some((l) => l.url === 'https://api.tavily.com/extract' && l.auth === 'Bearer tvly-test'));
  assert.equal(rep.sources[0].via, 'tavily-extract');
  const fake = rep.requirements.find((r) => r.quote.startsWith('Videos may'));
  assert.equal(fake.quoteVerified, false); assert.equal(fake.result, null);
  const judgeUser = llmCalls[2].body.messages[1].content;
  assert.ok(!judgeUser.includes('ten minutes'));
  assert.equal(rep.deadline.utc, '2026-10-30T17:00:00.000Z'); assert.match(rep.deadline.local, /2026-10-31, 02:00/);
  assert.equal(rep.evidence.repo.license, null); assert.equal(rep.evidence.repo.readmeMentions.nemotron, true); assert.equal(rep.evidence.video.embeddable, true);
  assert.equal(rep.conflicts.length, 1); assert.equal(rep.conflicts[0].topic, 'City award');
  assert.equal(rep.usage.length, 3);
});

test('LIVE path retries without response_format when the endpoint rejects it', async () => {
  let n = 0;
  const cfg = getConfig({ NEBIUS_API_KEY: 'k' });
  const llm = makeLLM(cfg, { fetchImpl: async (u, o) => { n++; const b = JSON.parse(o.body); return b.response_format ? new Response('bad', { status: 400 }) : new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} })); } });
  assert.deepEqual(await llm.chat({ tier: 'fast', step: 't', system: 's', user: 'u' }), { ok: true });
  assert.equal(n, 2);
});
