import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import handler from '../api/index.js';
test('serverless rewrite preserves API route and serves config plus recorded report', async () => {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const config = await fetch(origin + '/api/index?route=config');
    assert.equal(config.status, 200);
    assert.equal((await config.json()).mode, 'MOCK');
    const archived = await fetch(origin + '/api/index?route=example');
    assert.equal(archived.status, 200);
    const data = await archived.json();
    assert.equal(data.archived, true);
    assert.equal(data.report.mode, 'LIVE');
    assert.ok(data.markdown.includes('FinePrint report'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
