import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyQuote, verifyRequirements, parsePacific, formatInZone, dedupe } from '../src/verify.js';
import { parseJsonLoose } from '../src/llm.js';
import { getConfig } from '../src/config.js';
import { chunkText, htmlToText } from '../src/sources.js';

const SRC = 'All Submission materials must be in English or, if not in English, the Entrant must provide an English translation of the demonstration video.';

test('quote check: exact, formatting-insensitive, and fabricated quotes', () => {
  assert.equal(verifyQuote('All Submission materials must be in English', SRC).ok, true);
  assert.equal(verifyQuote('all  submission **materials** must be in “English”', SRC).ok, true);
  assert.equal(verifyQuote('Submissions may be written in any language you like', SRC).ok, false);
  const r = verifyRequirements([{ quote: 'must provide an English translation of the demonstration video', source: 'S1' }, { quote: 'Videos may be up to ten minutes long', source: 'S1' }], [{ id: 'S1', url: 'u', text: SRC }]);
  assert.deepEqual(r.map((x) => x.quoteVerified), [true, false]);
});

test('deadline: Pacific time to UTC with PDT/PST, range end, Korean time', () => {
  const d = parsePacific('Submission Period: Wednesday, August 26, 2026 (9:00 am Pacific Time) – Friday, October 30, 2026 (10:00 am Pacific Time)');
  assert.equal(d.toISOString(), '2026-10-30T17:00:00.000Z');
  assert.equal(parsePacific('Deadline: Oct 30, 2026 @ 10:00am PDT').toISOString(), '2026-10-30T17:00:00.000Z');
  assert.equal(parsePacific('Tuesday, December 15, 2026 (12:00 pm Pacific Time)').toISOString(), '2026-12-15T20:00:00.000Z');
  assert.match(formatInZone(d, 'Asia/Seoul'), /2026-10-31, 02:00/);
  assert.equal(parsePacific('no date here'), null);
});

test('model output parsing tolerates reasoning blocks, fences and trailing text', () => {
  assert.deepEqual(parseJsonLoose('<think>hmm {"x":1}</think>\n```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(parseJsonLoose('Sure! {"a":"}"} done'), { a: '}' });
  assert.throws(() => parseJsonLoose('no json'));
});

test('config: MOCK without key, LIVE with key, model ids overridable', () => {
  assert.equal(getConfig({}).mock, true);
  const c = getConfig({ NEBIUS_API_KEY: 'k', MODEL_FAST: 'nvidia/x' });
  assert.equal(c.mock, false); assert.equal(c.models.fast, 'nvidia/x'); assert.equal(c.tavily.mock, true);
});

test('chunking, html to text and dedupe', () => {
  const t = Array.from({ length: 50 }, (_, i) => `line ${i} `.repeat(30)).join('\n');
  const ch = chunkText(t, 2000);
  assert.ok(ch.length > 3 && ch.every((c) => c.length <= 2000)); assert.equal(ch.join('\n'), t);
  assert.equal(htmlToText('<body><nav>x</nav><p>A &amp; B</p><script>1</script></body>'), 'A & B');
  assert.equal(dedupe([{ quote: 'Same sentence here ok.' }, { quote: 'same  sentence here ok.' }]).length, 1);
});
