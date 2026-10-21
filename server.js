// FinePrint web server: static UI + POST /api/check streaming NDJSON progress events.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfig, publicConfig } from './src/config.js';
import { runCheck, toMarkdown } from './src/pipeline.js';
import { createBlobLedger, BudgetError } from './src/budget.js';
import { SafetyError, validateInput, readBodyCapped, tokenMatches, createGuard } from './src/safety.js';

const json = (res, status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

export function createServer(cfg = getConfig(), { fetchImpl = fetch, guard = createGuard(cfg.limits), ledger } = {}) {
  let ledgerP; // created lazily so MOCK / local runs never load the Blob SDK
  const getLedger = () => (ledger ? Promise.resolve(ledger) : (ledgerP ??= createBlobLedger(cfg)));
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(await readFile(path.join(cfg.root, 'public', 'index.html')));
      }
      if (req.method === 'GET' && req.url === '/api/config') return json(res, 200, publicConfig(cfg));
      if (req.method === 'GET' && req.url === '/api/example') {
        const report = JSON.parse(await readFile(path.join(cfg.root, 'public', 'live-example.json'), 'utf8'));
        return json(res, 200, { archived: true, report, markdown: toMarkdown(report) });
      }
      if (req.method === 'POST' && req.url === '/api/check') {
        let raw = await readBodyCapped(req, cfg.limits.maxBodyBytes);
        let parsed;
        try { parsed = JSON.parse(raw || '{}'); } catch { throw new SafetyError('Body is not valid JSON.'); }
        const clean = validateInput(parsed, cfg.limits);

        // MOCK unless LIVE is allowed for this request. Public deployments need the secret demo token.
        const given = req.headers['x-demo-token'];
        let live = !cfg.gate.required && !cfg.mock;
        if (cfg.gate.required && given) {
          if (!cfg.gate.liveUnlockable || !tokenMatches(given, cfg.gate.demoToken)) throw new SafetyError('LIVE demo is not available.', 403);
          live = true;
        }
        const eff = live ? { ...cfg, mock: false, tavily: { ...cfg.tavily, mock: !cfg.tavily.apiKey } } : { ...cfg, mock: true, tavily: { ...cfg.tavily, mock: true } };
        const ip = (cfg.gate.required ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
        let reserveBudget;
        if (live && cfg.ledger.required) {
          let l; try { l = await getLedger(); } catch { throw new BudgetError('Budget ledger unavailable; LIVE is off.'); }
          reserveBudget = (usd, note) => l.reserve(usd, note);
        }
        const slot = guard.acquire({ ip, live });

        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), cfg.limits.requestTimeoutMs);
        res.on('close', () => ctl.abort());
        const guardedFetch = (u, o = {}) => fetchImpl(u, { ...o, signal: o.signal ? AbortSignal.any([o.signal, ctl.signal]) : ctl.signal });
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
        const emit = (e) => { if (!res.writableEnded) res.write(JSON.stringify(e.type === 'done' ? { ...e, markdown: toMarkdown(e.report) } : e) + '\n'); };
        let tokens = live ? cfg.limits.maxTotalTokens : 0;
        try {
          const report = await runCheck(clean, eff, { fetchImpl: guardedFetch, emit, reserveBudget });
          tokens = report.usage.reduce((a, u) => a + u.promptTokens + u.completionTokens, 0);
        } catch (e) { emit({ type: 'error', msg: ctl.signal.aborted ? 'Check stopped: time limit reached.' : e.message }); }
        finally { clearTimeout(timer); slot.release(tokens); }
        return res.end();
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof BudgetError) return json(res, e.status, { error: e.message, code: e.code });
      if (e instanceof SafetyError) {
        if (e.status === 429) res.setHeader('retry-after', '60');
        return json(res, e.status, { error: e.message });
      }
      json(res, 500, { error: 'Internal error' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  const cfg = getConfig();
  createServer(cfg).listen(cfg.port, '127.0.0.1', () => {
    const p = publicConfig(cfg);
    console.log(`FinePrint on http://127.0.0.1:${cfg.port}  mode=${p.mode}  tavily=${p.tavily}  liveGate=${p.liveGate}`);
    console.log(`models: fast=${cfg.models.fast} mid=${cfg.models.mid} deep=${cfg.models.deep}`);
  });
}
