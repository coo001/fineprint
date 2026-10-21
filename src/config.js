// Loads settings from environment (and an optional .env file). No dependencies.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function getConfig(env = { ...loadDotEnv(), ...process.env }) {
  const nebiusKey = env.NEBIUS_API_KEY || '';
  const forceMock = env.FINEPRINT_MOCK === '1';
  const num = (k, d) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  // Public deployments (Vercel or FINEPRINT_PUBLIC=1) default to MOCK. LIVE needs the key, FINEPRINT_ENABLE_LIVE=1
  // and a secret FINEPRINT_DEMO_TOKEN (>=16 chars) that each LIVE request must send in the x-demo-token header.
  const isPublic = env.FINEPRINT_PUBLIC === '1' || !!env.VERCEL;
  const demoToken = env.FINEPRINT_DEMO_TOKEN || '';
  const ledgerReady = !!env.BLOB_READ_WRITE_TOKEN; // global spend ledger (Vercel Blob); public LIVE is OFF without it
  const liveUnlockable = !!nebiusKey && !forceMock && env.FINEPRINT_ENABLE_LIVE === '1' && demoToken.length >= 16 && ledgerReady;
  const gatedOff = isPublic; // public => MOCK unless the request carries the demo token
  return {
    gate: { required: isPublic, liveUnlockable: isPublic ? liveUnlockable : !!nebiusKey && !forceMock, demoToken: isPublic ? demoToken : '' },
    ledger: { capUsd: Math.min(0.65, num('FINEPRINT_LEDGER_CAP_USD', 0.65)), required: isPublic },
    limits: {
      maxUrls: num('LIMIT_MAX_URLS', 4), maxUrlLength: num('LIMIT_MAX_URL_LENGTH', 300), maxBodyBytes: num('LIMIT_MAX_BODY_BYTES', 20_000), maxFieldChars: num('LIMIT_MAX_FIELD_CHARS', 2000),
      fetchTimeoutMs: num('LIMIT_FETCH_TIMEOUT_MS', 8000), fetchMaxBytes: num('LIMIT_FETCH_MAX_BYTES', 1_500_000), maxRedirects: 3,
      maxSourceChars: num('LIMIT_MAX_SOURCE_CHARS', 60_000), maxTotalSourceChars: num('LIMIT_MAX_TOTAL_SOURCE_CHARS', 120_000),
      modelTimeoutMs: num('LIMIT_MODEL_TIMEOUT_MS', 60_000), requestTimeoutMs: num('LIMIT_REQUEST_TIMEOUT_MS', 110_000),
      maxCalls: num('LIMIT_MAX_CALLS', 26), maxInputCharsPerCall: num('LIMIT_MAX_INPUT_CHARS', 90_000), maxOutputTokens: num('LIMIT_MAX_OUTPUT_TOKENS', 6000), maxTotalTokens: num('LIMIT_MAX_TOTAL_TOKENS', 200_000),
      maxConcurrent: num('LIMIT_MAX_CONCURRENT', 2), ipWindowMs: num('LIMIT_IP_WINDOW_MS', 600_000), ipMaxRuns: num('LIMIT_IP_MAX_RUNS', 8),
      dailyLiveRuns: num('LIMIT_DAILY_LIVE_RUNS', 10), dailyLiveTokens: num('LIMIT_DAILY_LIVE_TOKENS', 1_000_000),
    },
    root: ROOT,
    port: Number(env.PORT || 3456),
    mock: forceMock || !nebiusKey || gatedOff,
    nebius: {
      apiKey: nebiusKey,
      enableThinking: env.NEBIUS_ENABLE_THINKING === '1',
      baseUrl: (env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/$/, ''),
    },
    models: {
      fast: env.MODEL_FAST || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
      mid: env.MODEL_MID || 'nvidia/nemotron-3-super-120b-a12b',
      deep: env.MODEL_DEEP || 'nvidia/Nemotron-3-Ultra-550b-a55b',
    },
    tavily: { apiKey: env.TAVILY_API_KEY || '', mock: forceMock || !env.TAVILY_API_KEY || gatedOff },
    githubToken: env.GITHUB_TOKEN || '',
  };
}

export function publicConfig(cfg) {
  return {
    mode: cfg.mock ? 'MOCK' : 'LIVE',
    tavily: cfg.tavily.mock ? (cfg.mock ? 'MOCK' : 'off (direct fetch)') : 'LIVE',
    liveGate: cfg.gate.required ? (cfg.gate.liveUnlockable ? 'token-required' : 'disabled') : (cfg.gate.liveUnlockable ? 'open' : 'no-key'),
    baseUrl: cfg.nebius.baseUrl,
    models: cfg.models,
  };
}
