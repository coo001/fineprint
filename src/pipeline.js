// FinePrint pipeline: sources -> extract (fast model, parallel) -> verify quotes (code) -> evidence (HTTP)
// -> judge (mid model) -> cross-source conflicts + fix list (deep model, one call) -> report.
import { getSources, chunkText } from './sources.js';
import { verifyRequirements, dedupe, parsePacific, formatInZone } from './verify.js';
import { collectEvidence } from './evidence.js';
import { makeLLM, Usage } from './llm.js';

export const CATEGORIES = ['eligibility', 'deadline', 'technology', 'repository', 'video', 'demo', 'description', 'language', 'track', 'feedback', 'judging', 'prize', 'ip', 'other'];
const STATUSES = ['pass', 'fail', 'action', 'manual', 'n/a'];

export const PROMPTS = {
  extract: `You read official contest rules. From the TEXT, list every rule an entrant must satisfy or should know (eligibility, deadlines, required technology, what to submit, video limits, language, judging, prize conditions).
Return JSON: {"requirements":[{"category":one of ${JSON.stringify(CATEGORIES)},"kind":"hard"|"soft"|"info","requirement":"short imperative in plain English","quote":"exact sentence copied character-for-character from TEXT"}]}
"hard" = entry can be disqualified or not judged; "soft" = recommended / affects score; "info" = dates, prizes, context.
Copy the quote exactly. Never paraphrase inside "quote". Skip navigation text. If nothing applies return {"requirements":[]}.`,
  judge: `You check a contest entry against its rules. For each requirement, decide using ONLY the EVIDENCE JSON (facts collected by code from GitHub, YouTube, the entry form).
Statuses: "pass" (evidence shows it is met), "fail" (evidence shows it is not met), "action" (not done yet / missing input), "manual" (needs a human; evidence cannot show it), "n/a" (does not apply to this entry or track).
Return JSON: {"results":[{"id":"R01","status":"...","reason":"one sentence citing the evidence field","fix":"one concrete step or empty"}]}. Include every id once.`,
  deep: `You are the final reviewer. You get requirements from several official pages of the same contest (each with source id and verbatim quote) and the per-requirement results.
1) Find CONFLICTS: pairs of requirements from DIFFERENT sources that say incompatible things about the same topic (e.g. one page says attendance is required for a prize, another says it is not). Only report real contradictions, citing both requirement ids.
2) Write the 5 most important fixes, most dangerous first (disqualification risks before score improvements).
3) One-sentence verdict.
Return JSON: {"conflicts":[{"a":"R..","b":"R..","topic":"...","explanation":"...","whatToDo":"..."}],"topFixes":["..."],"verdict":"..."}`,
};

// Keeps the JSON payload sent to a model under maxChars by dropping trailing items (never throws, never sends more).
function fit(items, maxChars) { const out = []; let n = 2; for (const it of items) { n += JSON.stringify(it).length + 1; if (n > maxChars) break; out.push(it); } return out; }

export async function runCheck(input, cfg, { fetchImpl = fetch, emit = () => {}, reserveBudget } = {}) {
  const usage = new Usage();
  const llm = makeLLM(cfg, { fetchImpl, usage, reserveBudget, onCall: (c) => emit({ type: 'call', call: c }) });
  const tz = input.timeZone || 'UTC';

  emit({ type: 'step', step: 'sources', msg: `Reading ${input.urls.length} official page(s)` });
  const sources = await getSources(input.urls, cfg, { fetchImpl, log: (m) => emit({ type: 'log', msg: m }) });
  emit({ type: 'sources', sources: sources.map(({ id, url, via, text }) => ({ id, url, via, chars: text.length })) });

  emit({ type: 'step', step: 'extract', msg: `Extracting rules with ${cfg.models.fast} (parallel chunks)` });
  const jobs = sources.flatMap((s) => chunkText(s.text).map((chunk, i) => ({ s, chunk, i })));
  const extracted = await Promise.all(jobs.map(async ({ s, chunk, i }) => {
    const out = await llm.chat({ tier: 'fast', step: 'extract', system: PROMPTS.extract, user: `SOURCE ${s.id} (${s.url}) part ${i + 1}\nTEXT:\n${chunk}`, maxTokens: 3000 });
    return (out.requirements || []).map((r) => ({ ...r, source: s.id }));
  }));
  const clean = extracted.flat().filter((r) => r && r.quote && r.requirement).map((r) => ({ ...r, category: CATEGORIES.includes(r.category) ? r.category : 'other', kind: ['hard', 'soft', 'info'].includes(r.kind) ? r.kind : 'info' }));
  const requirements = dedupe(verifyRequirements(clean, sources));
  const verified = requirements.filter((r) => r.quoteVerified);
  emit({ type: 'step', step: 'verify', msg: `${verified.length}/${requirements.length} quotes found verbatim in the source; unverified ones are set aside` });

  // Submission deadline = latest date in a rule that talks about the submission deadline/period (computed by code, not the model).
  const isDeadline = (r) => /deadline|submission period/i.test(r.quote) || (r.category === 'deadline' && /submi|deadline/i.test(r.requirement));
  const deadlines = verified.filter(isDeadline).map((r) => ({ id: r.id, date: parsePacific(r.quote) })).filter((d) => d.date);
  const deadline = deadlines.sort((a, b) => b.date - a.date)[0] || null;

  emit({ type: 'step', step: 'evidence', msg: 'Collecting evidence from GitHub / YouTube / the entry form' });
  const evidence = await collectEvidence(input.entry || {}, cfg, { fetchImpl });

  const toJudge = verified.filter((r) => r.kind !== 'info');
  emit({ type: 'step', step: 'judge', msg: `Judging ${toJudge.length} requirements with ${cfg.models.mid}` });
  const j = await llm.chat({ tier: 'mid', step: 'judge', system: PROMPTS.judge, user: `REQUIREMENTS:\n${JSON.stringify(fit(toJudge.map(({ id, category, kind, requirement, quote }) => ({ id, category, kind, requirement, quote })), 45_000))}\nEVIDENCE:\n${JSON.stringify(evidence)}`, maxTokens: 6000 });
  const results = Object.fromEntries((j.results || []).filter((r) => STATUSES.includes(r.status)).map((r) => [r.id, r]));
  for (const r of toJudge) results[r.id] ??= { id: r.id, status: 'manual', reason: 'Model returned no result for this item.', fix: '' };

  emit({ type: 'step', step: 'deep', msg: `Cross-checking sources for conflicts with ${cfg.models.deep}` });
  const d = await llm.chat({ tier: 'deep', step: 'deep', system: PROMPTS.deep, user: `REQUIREMENTS:\n${JSON.stringify(fit(verified.map(({ id, source, category, kind, quote }) => ({ id, source, category, kind, quote })), 45_000))}\nRESULTS:\n${JSON.stringify(Object.values(results))}`, maxTokens: 4000 });
  const ids = new Map(verified.map((r) => [r.id, r]));
  const conflicts = (d.conflicts || []).filter((c) => ids.has(c.a) && ids.has(c.b) && ids.get(c.a).source !== ids.get(c.b).source);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, Object.values(results).filter((r) => r.status === s).length]));
  const report = {
    generatedAt: new Date().toISOString(), mode: cfg.mock ? 'MOCK' : 'LIVE', models: cfg.models,
    sources: sources.map(({ id, url, via, text }) => ({ id, url, via, chars: text.length })),
    deadline: deadline ? { id: deadline.id, utc: deadline.date.toISOString(), local: formatInZone(deadline.date, tz), timeZone: tz } : null,
    requirements: requirements.map((r) => ({ ...r, result: results[r.id] || null })),
    evidence, counts, conflicts, topFixes: d.topFixes || [], verdict: d.verdict || '', usage: usage.summary(),
  };
  emit({ type: 'done', report });
  return report;
}

export function toMarkdown(rep) {
  const L = [`# FinePrint report (${rep.mode})`, '', `Verdict: ${rep.verdict}`, ''];
  if (rep.deadline) L.push(`Deadline: ${rep.deadline.local} (${rep.deadline.utc} UTC), from ${rep.deadline.id}`, '');
  L.push(`Counts: ${Object.entries(rep.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`, '', '## Top fixes', ...rep.topFixes.map((f, i) => `${i + 1}. ${f}`), '');
  if (rep.conflicts.length) L.push('## Conflicts between official pages', ...rep.conflicts.map((c) => `- ${c.topic}: ${c.a} vs ${c.b}. ${c.explanation} -> ${c.whatToDo}`), '');
  L.push('## Requirements', '| id | status | kind | requirement | quote (source) |', '|---|---|---|---|---|');
  for (const r of rep.requirements) L.push(`| ${r.id} | ${r.quoteVerified ? (r.result?.status || 'info') : 'unverified'} | ${r.kind} | ${r.requirement} | "${r.quote.replace(/\|/g, '/')}" (${r.source}) |`);
  return L.join('\n');
}
