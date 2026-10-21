// No network by default. Explicit approval is required before an actual API call.
import { pathToFileURL } from 'node:url';
import { getConfig } from '../src/config.js';

export async function preflight(cfg, { live = false, approved = false, fetchImpl = fetch } = {}) {
  const base = new URL(cfg.nebius.baseUrl);
  if (base.protocol !== 'https:' || !['api.tokenfactory.nebius.com', 'api.tokenfactory.us-central1.nebius.com'].includes(base.hostname) || base.username || base.password || base.port || base.pathname !== '/v1' || base.search || base.hash) {
    throw new Error('Refusing a non-official API endpoint');
  }
  const result = { checkedAt: new Date().toISOString(), keyPresent: Boolean(cfg.nebius.apiKey), networkCalled: false, localChecks: 'PASS', configuredModels: cfg.models, liveStatus: 'NOT_RUN', approvalRequired: true };
  if (!live) return result;
  if (!approved) throw new Error('Explicit approval required: set FINEPRINT_LIVE_APPROVED=1');
  if (cfg.mock || !cfg.nebius.apiKey) throw new Error('A real API key is required; MOCK is not a LIVE check');
  const headers = { authorization: `Bearer ${cfg.nebius.apiKey}` };
  const catalog = await fetchImpl(`${base.href}/models`, { headers, signal: AbortSignal.timeout(15000) });
  if (!catalog.ok) throw new Error(`Model catalog returned HTTP ${catalog.status}`);
  const ids = new Set((await catalog.json()).data.map(m => m.id));
  result.networkCalled = true;
  result.modelAvailability = Object.fromEntries(Object.entries(cfg.models).map(([tier, id]) => [tier, ids.has(id)]));
  if (!Object.values(result.modelAvailability).every(Boolean)) {
    result.liveStatus = 'BLOCKED_MODEL_MISMATCH';
    result.availableNemotronModels = [...ids].filter(id => /nemotron/i.test(id));
    return result;
  }
  const response = await fetchImpl(`${base.href}/chat/completions`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ model: cfg.models.fast, max_tokens: 64, temperature: 0, messages: [{ role: 'user', content: 'Reply with only the word READY.' }] }),
  });
  if (!response.ok) throw new Error(`Smoke check returned HTTP ${response.status}`);
  const data = await response.json();
  result.usage = data.usage || null;
  result.responsePresent = Boolean(data.choices?.[0]?.message?.content?.trim());
  result.liveStatus = result.responsePresent ? 'SINGLE_MODEL_RESPONSE_RECEIVED' : 'EMPTY_RESPONSE';
  result.pipelineVerified = false;
  result.approvalRequired = false;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await preflight(getConfig(), { live: process.argv.includes('--live'), approved: process.env.FINEPRINT_LIVE_APPROVED === '1' });
    console.log(JSON.stringify(result, null, 2));
    if (result.liveStatus.startsWith('BLOCKED') || result.liveStatus === 'EMPTY_RESPONSE') process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', error: error.message }));
    process.exitCode = 1;
  }
}
