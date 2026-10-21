// Verifies the actual private Blob adapter without making a model/API inference call.
import * as sdk from '@vercel/blob';
import { createBlobStore, createLedger } from '../src/budget.js';
const pathname = 'fineprint/adapter-check-' + Date.now() + '.json';
const store = createBlobStore({ sdk, pathname });
const ledger = createLedger({ store, capUsd: .01, maxAttempts: 12 });
try {
  await ledger.reserve(.001, 'initial actual-store check');
  const afterCreate = await store.get();
  if (!afterCreate?.etag || afterCreate.data.reservedMicro !== 1000) throw Error('Actual get/stream/etag check failed');
  await ledger.reserve(.001, 'conditional update check');
  let conflictRejected = false;
  try { await store.update({ ...afterCreate.data, reservedMicro: 9000 }, afterCreate.etag); }
  catch (error) { conflictRejected = error.name === 'ConflictError'; }
  if (!conflictRejected) throw Error('Stale ETag update did not fail closed');
  const restarted = createLedger({ store: createBlobStore({ sdk, pathname }), capUsd: .01 });
  const persisted = await restarted.status();
  if (persisted.reservedMicro !== 2000 || persisted.calls !== 2) throw Error('Persisted state did not survive new ledger object');
  let exhausted = false;
  try { await restarted.reserve(.02, 'must be blocked'); } catch (error) { exhausted = error.code === 'exhausted'; }
  if (!exhausted) throw Error('Budget was not enforced');
  console.log(JSON.stringify({ actualPrivateStore: 'PASS', createReadStreamETag: 'PASS', conditionalWrite: 'PASS', staleETagRejected: true, restartPersistence: true, overBudgetRejected: true, inferenceCalls: 0 }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAILED', error: error.message })); process.exitCode = 1;
} finally {
  await sdk.del(pathname).catch(() => {});
}
