// Nebius Token Factory client (OpenAI-compatible /chat/completions) with per-call usage tracking.
// In MOCK mode the same interface is served by src/mock.js so the pipeline code path is identical.
import { mockChat } from './mock.js';
import { costBound, DEFAULT_RATES } from './budget.js';

export class Usage {
  constructor() { this.calls = []; }
  add(c) { this.calls.push(c); }
  summary() {
    const by = {};
    for (const c of this.calls) {
      const k = c.model;
      by[k] ??= { model: k, tier: c.tier, calls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
      by[k].calls++; by[k].promptTokens += c.promptTokens; by[k].completionTokens += c.completionTokens; by[k].ms += c.ms;
    }
    return Object.values(by);
  }
}

// Strip reasoning blocks / code fences and parse the first JSON object or array.
export function parseJsonLoose(text) {
  if (typeof text !== 'string') throw new Error('empty model output');
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in model output');
  const open = t[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error('unterminated JSON in model output');
}

export function makeLLM(cfg, { fetchImpl = fetch, usage = new Usage(), onCall, reserveBudget } = {}) {
  const L = { maxCalls: 26, maxInputCharsPerCall: 90_000, maxOutputTokens: 6000, maxTotalTokens: 200_000, modelTimeoutMs: 60_000, ...cfg.limits };
  let nCalls = 0, reserved = 0;
  // Reserve worst-case cost before every outbound model request (including the response_format retry).
  function reserve(inputChars, outTokens) {
    const cost = Math.ceil(inputChars / 3) + outTokens;
    if (nCalls + 1 > L.maxCalls) throw new Error(`Request limit reached: more than ${L.maxCalls} model calls in one check`);
    if (reserved + cost > L.maxTotalTokens) throw new Error(`Request limit reached: more than ${L.maxTotalTokens} estimated tokens in one check`);
    nCalls++; reserved += cost;
  }
  // Dollar reservation (global ledger) before every outbound LIVE request; no refund on failure.
  async function reserveMoney(body, tier) {
    if (!reserveBudget || cfg.mock) return;
    const rate = (cfg.rates || DEFAULT_RATES)[tier];
    await reserveBudget(costBound({ messages: body.messages, maxTokens: body.max_tokens, rate }), `${tier}`);
  }
  async function chat({ tier, step, system, user, maxTokens = 4000, temperature = 0.1, json = true }) {
    const model = cfg.models[tier];
    const inChars = String(system).length + String(user).length;
    if (inChars > L.maxInputCharsPerCall) throw new Error(`Input limit: ${inChars} characters exceeds ${L.maxInputCharsPerCall} for one model call`);
    maxTokens = Math.min(maxTokens, L.maxOutputTokens);
    reserve(inChars, maxTokens);
    const t0 = Date.now();
    let content, promptTokens = 0, completionTokens = 0;
    if (cfg.mock) {
      const r = await mockChat({ step, system, user });
      content = r.content; promptTokens = r.promptTokens; completionTokens = r.completionTokens;
    } else {
      const body = { model, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], extra_body: { chat_template_kwargs: { enable_thinking: cfg.nebius.enableThinking === true } } };
      if (json) body.response_format = { type: 'json_object' };
      await reserveMoney(body, tier);
      let res = await fetchImpl(`${cfg.nebius.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.nebius.apiKey}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(L.modelTimeoutMs),
      });
      if (res.status === 400 && json) { // some endpoints reject response_format; retry without it
        delete body.response_format;
        reserve(inChars, maxTokens);
        await reserveMoney(body, tier);
        res = await fetchImpl(`${cfg.nebius.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.nebius.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(L.modelTimeoutMs) });
      }
      if (!res.ok) throw new Error(`Token Factory ${res.status} for ${model}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      if (data.choices?.[0]?.finish_reason === 'length') throw new Error(`Token Factory output limit reached for ${model}; JSON was not accepted`);
      content = data.choices?.[0]?.message?.content ?? '';
      promptTokens = data.usage?.prompt_tokens ?? 0; completionTokens = data.usage?.completion_tokens ?? 0;
    }
    const call = { tier, step, model, promptTokens, completionTokens, ms: Date.now() - t0, mock: cfg.mock };
    usage.add(call); onCall?.(call);
    return json ? parseJsonLoose(content) : content;
  }

  async function listModels() {
    if (cfg.mock) return Object.values(cfg.models);
    const res = await fetchImpl(`${cfg.nebius.baseUrl}/models`, { headers: { authorization: `Bearer ${cfg.nebius.apiKey}` } });
    if (!res.ok) throw new Error(`Token Factory /models ${res.status}`);
    return (await res.json()).data.map((m) => m.id);
  }

  return { chat, listModels, usage };
}
