// Global spend ledger: CAS reservation, concurrency, fail-closed storage errors, cap, restart persistence. Adapter stubs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, createBlobStore, costBound, ConflictError, BudgetError, DEFAULT_RATES } from '../src/budget.js';
import { makeLLM } from '../src/llm.js';
import { getConfig } from '../src/config.js';

// In-memory store with real ETag/CAS semantics; hooks let tests inject races and failures.
function memStore(hooks = {}) {
  let rec = null, v = 0;
  return {
    peek: () => rec,
    async get() { await hooks.beforeGet?.(); return rec ? { data: JSON.parse(JSON.stringify(rec.data)), etag: rec.etag } : null; },
    async create(d) { if (hooks.failWrite) throw new Error('disk'); if (rec) throw new ConflictError(); rec = { data: d, etag: 'e' + ++v }; },
    async update(d, etag) { if (hooks.failWrite) throw new Error('disk'); if (!rec || rec.etag !== etag) throw new ConflictError(); rec = { data: d, etag: 'e' + ++v }; },
  };
}
const micro = (usd) => Math.ceil(usd * 1e6 - 1e-9);

test('first reservation creates the ledger without overwrite; later ones use ifMatch', async () => {
  const calls = [];
  const sdk = {
    get: async () => { throw Object.assign(new Error('not found'), { name: 'BlobNotFoundError' }); },
    put: async (p, b, o) => { calls.push(o); return {}; },
  };
  const l = createLedger({ store: createBlobStore({ sdk }), capUsd: 0.75 });
  await l.reserve(0.01);
  assert.equal(calls[0].allowOverwrite, false); assert.equal(calls[0].access, 'private'); assert.equal(calls[0].addRandomSuffix, false); assert.equal('ifMatch' in calls[0], false);
  let stored;
  const sdk2 = {
    get: async (p, o) => { assert.equal(o.useCache, false); assert.equal(o.access, 'private'); return { stream: new Response(JSON.stringify({ reservedMicro: 5, calls: 1 })).body, blob: { etag: '"abc"' } }; },
    put: async (p, b, o) => { stored = { b: JSON.parse(b), o }; return {}; },
  };
  await createLedger({ store: createBlobStore({ sdk: sdk2 }) }).reserve(0.01);
  assert.equal(stored.o.ifMatch, '"abc"'); assert.equal(stored.o.allowOverwrite, true); assert.equal(stored.b.reservedMicro, 5 + 10000);
});

test('CAS conflict is retried against fresh state; reservations are not lost under concurrency', async () => {
  const store = memStore();
  const l = createLedger({ store, capUsd: 0.75, maxAttempts: 30 });
  await Promise.all(Array.from({ length: 20 }, () => l.reserve(0.01)));
  assert.equal(store.peek().data.reservedMicro, 20 * 10000); assert.equal(store.peek().data.calls, 20);
});

test('concurrent reservations can never exceed the cap', async () => {
  const store = memStore();
  const l = createLedger({ store, capUsd: 0.75, maxAttempts: 100 });
  const r = await Promise.allSettled(Array.from({ length: 40 }, () => l.reserve(0.05)));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 15);
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'exhausted' && x.reason.status === 429));
  assert.equal(store.peek().data.reservedMicro, micro(0.75));
});

test('persistent conflicts fail closed', async () => {
  const store = memStore(); await createLedger({ store }).reserve(0.01);
  store.update = async () => { throw new ConflictError(); };
  await assert.rejects(createLedger({ store, maxAttempts: 3 }).reserve(0.01), (e) => e instanceof BudgetError && /busy/.test(e.message));
});

test('storage read/write failures, missing etag and corrupt data fail closed', async () => {
  await assert.rejects(createLedger({ store: { get: async () => { throw new Error('down'); } } }).reserve(0.01), /unavailable/);
  await assert.rejects(createLedger({ store: memStore({ failWrite: true }) }).reserve(0.01), /write failed/);
  await assert.rejects(createLedger({ store: { get: async () => ({ data: { reservedMicro: 1, calls: 1 }, etag: undefined }) } }).reserve(0.01), /unreadable/);
  await assert.rejects(createLedger({ store: { get: async () => ({ data: { reservedMicro: -5, calls: 1 }, etag: 'x' }) } }).reserve(0.01), /unreadable/);
  await assert.rejects(createLedger({ store: memStore() }).reserve(NaN), /Invalid/);
});

test('reserved total survives a restart (new ledger object, same store)', async () => {
  const store = memStore();
  await createLedger({ store }).reserve(0.4);
  const after = createLedger({ store });
  await after.reserve(0.3);
  await assert.rejects(after.reserve(0.1), (e) => e.code === 'exhausted');
  assert.equal((await createLedger({ store }).status()).reservedMicro, micro(0.7));
});

test('cost bound uses UTF-8 bytes (Korean/emoji count more) and output max price', () => {
  const ascii = costBound({ messages: [{ content: 'a'.repeat(300) }], maxTokens: 1000, rate: DEFAULT_RATES.mid });
  const kor = costBound({ messages: [{ content: '가'.repeat(300) }], maxTokens: 1000, rate: DEFAULT_RATES.mid });
  assert.ok(kor > ascii);
  assert.ok(ascii >= 1000 * 0.9 / 1e6);
  assert.throws(() => costBound({ messages: [], maxTokens: 1, rate: undefined }), /No price/);
});

test('every LIVE model request (including the response_format retry) reserves first; refusal means no network call', async () => {
  const order = []; let n = 0;
  const fetchImpl = async (u, o) => { order.push('fetch'); const b = JSON.parse(o.body); return b.response_format ? new Response('bad', { status: 400 }) : new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }], usage: {} })); };
  const llm = makeLLM(getConfig({ NEBIUS_API_KEY: 'k' }), { fetchImpl, reserveBudget: async (usd) => { order.push('reserve'); assert.ok(usd > 0); n++; } });
  await llm.chat({ tier: 'fast', step: 't', system: 's', user: 'u' });
  assert.deepEqual(order, ['reserve', 'fetch', 'reserve', 'fetch']);
  const none = makeLLM(getConfig({ NEBIUS_API_KEY: 'k' }), { fetchImpl: () => { throw new Error('must not be called'); }, reserveBudget: async () => { throw new BudgetError('Global LIVE budget reached.', 'exhausted', 429); } });
  await assert.rejects(none.chat({ tier: 'deep', step: 't', system: 's', user: 'u' }), /budget reached/);
});

test('actual Blob conditional-conflict message is normalized for safe CAS retry', async () => {
  const sdk = { put: async () => { throw new Error('Vercel Blob: The conditional request cannot succeed due to a conflicting operation against this resource.'); } };
  const store = createBlobStore({ sdk });
  await assert.rejects(store.update({ reservedMicro: 1, calls: 1 }, 'old-etag'), error => error instanceof ConflictError);
});
