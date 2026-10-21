// Actual paid-model calls using saved official excerpts, not a full-site or public deployment test.
import { readFile, writeFile } from 'node:fs/promises';
import { getConfig } from '../src/config.js';
import { runCheck, toMarkdown } from '../src/pipeline.js';
const cfg = getConfig();
if (process.env.FINEPRINT_LIVE_APPROVED !== '1' || cfg.mock) throw Error('Explicit LIVE approval and API key required');
const rulesUrl = 'https://nebiusglobalaihackathon.devpost.com/rules';
const resourcesUrl = 'https://nebiusglobalaihackathon.devpost.com/resources';
const rules = await readFile('fixtures/pages/nebiusglobalaihackathon_devpost_com_rules.txt', 'utf8');
const resources = await readFile('fixtures/pages/nebiusglobalaihackathon_devpost_com_resources.txt', 'utf8');
const selectedRules = rules.split('\n').filter(l => /^Submission Period:|^The repository must be public/.test(l)).join('\n');
const selectedResources = resources.split('\n').filter(l => /You don.t need to attend an event/.test(l)).join('\n');
if (!selectedRules || !selectedResources || selectedRules.length + selectedResources.length > 4000) throw Error('Unexpected excerpt shape');
const excerpts = new Map([[rulesUrl, selectedRules], [resourcesUrl, selectedResources]]);
const rates = {
  [cfg.models.fast]: { input: .06, output: .24 },
  [cfg.models.mid]: { input: .3, output: .9 },
  [cfg.models.deep]: { input: 1, output: 3 },
};
// Prices confirmed in the account's official Prices UI on 2026-10-21. Reserve on UTF-8 bytes,
// much more conservative than actual English token count. Prior smoke reserve + VAT headroom included.
let reserved = .003; const ledger = []; const maxBudget = .04; let calls = 0;
async function guardedFetch(url, opts = {}) {
  if (excerpts.has(String(url))) return new Response(excerpts.get(String(url)), { headers: { 'content-type': 'text/plain' } });
  if (String(url) !== 'https://api.tokenfactory.nebius.com/v1/chat/completions') throw Error('Unexpected outbound endpoint');
  if (++calls > 4) throw Error('Maximum model requests reached; no retries beyond four');
  const body = JSON.parse(opts.body); const rate = rates[body.model];
  if (!rate || body.max_tokens > 6000) throw Error('Unapproved model or output limit');
  const bound = ((Buffer.byteLength(JSON.stringify(body.messages), 'utf8') + 2048) * rate.input + body.max_tokens * rate.output) / 1e6;
  if (reserved + bound > maxBudget) throw Error('Conservative cost reservation exceeds approved test budget');
  reserved += bound;
  const started = Date.now();
  const response = await fetch(String(url), { ...opts, signal: AbortSignal.timeout(120000) });
  const item = { model: body.model, reservationUsd: bound, status: response.status, ms: Date.now() - started };
  if (response.ok) {
    const data = await response.clone().json(); item.usage = data.usage; item.finishReason = data.choices?.[0]?.finish_reason;
    item.estimatedUsd = ((data.usage?.prompt_tokens || 0) * rate.input + (data.usage?.completion_tokens || 0) * rate.output) / 1e6;
  }
  ledger.push(item);
  await writeFile('../live-cost-ledger.json', JSON.stringify({ maxBudgetUsd: maxBudget, conservativeReservedUsd: reserved, pricingBasis: 'Official account Prices UI 2026-10-21, before VAT', ledger }, null, 2));
  return response;
}
try {
  const report = await runCheck({ urls: [rulesUrl, resourcesUrl], timeZone: 'Asia/Seoul', entry: { track: 'Best Apps and Agents' } }, cfg, { fetchImpl: guardedFetch });
  report.validationScope = 'Actual three-tier API pipeline over saved official excerpts (captured 2026-10-20), not a current full-site fetch or deployed demo';
  for (const source of report.sources) source.via = 'saved-official-excerpt';
  await writeFile('../live-excerpt-report.json', JSON.stringify(report, null, 2));
  await writeFile('../live-excerpt-report.md', `Scope: ${report.validationScope}\n\n${toMarkdown(report)}`);
  console.log(JSON.stringify({ scope: report.validationScope, mode: report.mode, calls: ledger.length, estimatedUsdBeforeTax: ledger.reduce((n, x) => n + (x.estimatedUsd || 0), 0), quoteVerified: report.requirements.filter(r => r.quoteVerified).length, requirements: report.requirements.length, counts: report.counts, deadline: report.deadline, pipelineCompleted: true }, null, 2));
} catch (error) {
  await writeFile('../live-excerpt-error.json', JSON.stringify({ status: 'FAILED', error: error.message, calls: ledger.length, ledger }, null, 2));
  console.error(JSON.stringify({ status: 'FAILED', error: error.message, calls: ledger.length })); process.exitCode = 1;
}
