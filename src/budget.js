// Global LIVE spend ledger: pre-reserves a conservative dollar cost before EVERY model request, using
// compare-and-swap (ETag) writes to a storage adapter so concurrent serverless instances cannot overspend.
// Fail closed: any storage/conflict/parse problem means "no model call". Reserved money is never refunded.

export class BudgetError extends Error {
  constructor(message, code = 'unavailable', status = 503) { super(message); this.code = code; this.status = status; }
}
export class ConflictError extends Error { constructor(m = 'conflict') { super(m); this.name = 'ConflictError'; } }

// $ per 1M tokens, confirmed in the account's Prices UI on 2026-10-21 (same table as bin/live-excerpt-check.js).
export const DEFAULT_RATES = { fast: { input: 0.06, output: 0.24 }, mid: { input: 0.3, output: 0.9 }, deep: { input: 1, output: 3 } };

// Upper bound in USD for one request: UTF-8 bytes >= tokens (+2048 template slack) at the input rate, max_tokens at the output rate.
export function costBound({ messages, maxTokens, rate }) {
  if (!rate) throw new BudgetError('No price known for this model; refusing to call it.', 'no-rate');
  const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 2048;
  return (bytes * rate.input + maxTokens * rate.output) / 1e6;
}

const MICRO = 1e6; // ledger stores integer micro-dollars to avoid float drift
const toMicro = (usd) => Math.ceil(usd * MICRO - 1e-9);

// store: { get() -> null | { data, etag }, create(data) -> void (throws ConflictError if it exists), update(data, etag) -> void (throws ConflictError on etag mismatch) }
export function createLedger({ store, capUsd = 0.75, maxAttempts = 8 }) {
  const cap = toMicro(capUsd);
  async function reserveOnce(usd, note = '') {
    const cost = toMicro(usd);
    if (!(cost > 0) || !Number.isFinite(cost)) throw new BudgetError('Invalid cost reservation.', 'invalid');
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let cur;
      try { cur = await store.get(); } catch { throw new BudgetError('Budget ledger unavailable; LIVE call refused.'); }
      let reserved = 0, calls = 0;
      if (cur) {
        const d = cur.data;
        if (!cur.etag || !d || !Number.isSafeInteger(d.reservedMicro) || d.reservedMicro < 0 || !Number.isSafeInteger(d.calls)) throw new BudgetError('Budget ledger unreadable (missing etag or bad data); LIVE call refused.');
        reserved = d.reservedMicro; calls = d.calls;
      }
      if (reserved + cost > cap) throw new BudgetError('Global LIVE budget reached.', 'exhausted', 429);
      const next = { v: 1, capMicro: cap, reservedMicro: reserved + cost, calls: calls + 1, updatedAt: new Date().toISOString(), last: String(note).slice(0, 80) };
      try {
        if (cur) await store.update(next, cur.etag); else await store.create(next);
        return { reservedMicro: next.reservedMicro, remainingMicro: cap - next.reservedMicro };
      } catch (e) {
        if (e instanceof ConflictError || e?.name === 'ConflictError') continue; // someone else wrote first: re-read and retry
        throw new BudgetError('Budget ledger write failed; LIVE call refused.');
      }
    }
    throw new BudgetError('Budget ledger is busy (too many write conflicts); LIVE call refused.');
  }
  // Serialize this instance's reservations; CAS still protects writes across different instances.
  let pending = Promise.resolve();
  function reserve(usd, note = '') {
    const run = pending.then(() => reserveOnce(usd, note));
    pending = run.catch(() => {});
    return run;
  }
  async function status() {
    const cur = await store.get();
    return { capMicro: cap, reservedMicro: cur?.data?.reservedMicro ?? 0, calls: cur?.data?.calls ?? 0 };
  }
  return { reserve, status };
}

// Vercel Blob adapter (private store). The SDK is injected so tests need no dependency/network:
//   sdk = { get(pathname, { access:'private', useCache:false }), put(pathname, body, { access:'private', addRandomSuffix:false, allowOverwrite, ifMatch, contentType }) }
// UNVERIFIED against the live SDK: result shapes of get() (stream/etag field names) and error names; checked only by stubs.
export function createBlobStore({ sdk, pathname = 'fineprint/budget-ledger.json' }) {
  const isConflict = (e) => /BlobPreconditionFailed|BlobAlreadyExists/i.test(e?.name || '') || /precondition|already exists|412|conditional request.*conflicting operation/i.test(e?.message || '');
  const base = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };
  return {
    async get() {
      let r;
      try { r = await sdk.get(pathname, { access: 'private', useCache: false }); }
      catch (e) { if (/BlobNotFound/i.test(e?.name || '') || /not found|404/i.test(e?.message || '')) return null; throw e; }
      if (!r || r.statusCode === 404) return null;
      const etag = r.blob?.etag ?? r.etag;
      const stream = r.stream ?? r.blob?.stream;
      const text = stream ? await new Response(stream).text() : typeof r.text === 'function' ? await r.text() : null;
      if (text == null) throw new Error('unreadable ledger');
      return { data: JSON.parse(text), etag };
    },
    async create(data) {
      try { await sdk.put(pathname, JSON.stringify(data), { ...base, allowOverwrite: false }); }
      catch (e) { throw isConflict(e) ? new ConflictError() : e; }
    },
    async update(data, etag) {
      try { await sdk.put(pathname, JSON.stringify(data), { ...base, allowOverwrite: true, ifMatch: etag }); }
      catch (e) { throw isConflict(e) ? new ConflictError() : e; }
    },
  };
}

export async function createBlobLedger(cfg, importer = () => import('@vercel/blob')) {
  const sdk = await importer();
  return createLedger({ store: createBlobStore({ sdk }), capUsd: cfg.ledger.capUsd });
}
