import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../bin/preflight.js';
import { getConfig } from '../src/config.js';
const cfg = () => getConfig({ NEBIUS_API_KEY: 'test-only-not-real' });
const json = obj => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });

test('preflight default makes no network request and never returns the key', async () => {
  const output = await preflight(cfg(), { fetchImpl: () => { throw Error('unexpected network'); } });
  assert.equal(output.networkCalled, false);
  assert.equal(output.liveStatus, 'NOT_RUN');
  assert.ok(!JSON.stringify(output).includes('test-only-not-real'));
});
test('preflight requires explicit live approval before any network', async () => {
  await assert.rejects(preflight(cfg(), { live: true }), /Explicit approval/);
});
test('preflight rejects unofficial endpoint and mock mode', async () => {
  await assert.rejects(preflight(getConfig({ NEBIUS_BASE_URL: 'https://example.com/v1' })), /non-official/);
  await assert.rejects(preflight(getConfig({}), { live: true, approved: true }), /real API key/);
});
test('missing catalog model blocks completions', async () => {
  let n = 0;
  const output = await preflight(cfg(), { live: true, approved: true, fetchImpl: async () => { n++; return json({ data: [] }); } });
  assert.equal(n, 1);
  assert.equal(output.liveStatus, 'BLOCKED_MODEL_MISMATCH');
});
test('approved smoke performs only one capped completion, does not claim full pipeline', async () => {
  const config = cfg(); const calls = [];
  const output = await preflight(config, { live: true, approved: true, fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/models')) return json({ data: Object.values(config.models).map(id => ({ id })) });
    assert.equal(JSON.parse(opts.body).max_tokens, 64);
    return json({ choices: [{ message: { content: 'READY' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
  } });
  assert.equal(calls.length, 2);
  assert.equal(output.liveStatus, 'SINGLE_MODEL_RESPONSE_RECEIVED');
  assert.equal(output.pipelineVerified, false);
});

// Regression: a truncated JSON response from the real endpoint must not look like a valid report.
import { makeLLM } from '../src/llm.js';
test('LIVE requests disable thinking by default for bounded JSON output', async () => {
  const llm = makeLLM(cfg(), { fetchImpl: async (url, opts) => {
    assert.equal(JSON.parse(opts.body).extra_body.chat_template_kwargs.enable_thinking, false);
    return json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: {} });
  } });
  assert.deepEqual(await llm.chat({ tier: 'fast', system: 's', user: 'u' }), { ok: true });
});
test('LIVE requests reject length-truncated output explicitly', async () => {
  const llm = makeLLM(cfg(), { fetchImpl: async () => json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'length' }], usage: {} }) });
  await assert.rejects(llm.chat({ tier: 'fast', system: 's', user: 'u' }), /output limit reached/);
});
