import { safeFetch } from './safety.js';
// Collects facts about the entry with plain HTTP calls (no model involved), so judgments rest on observed evidence.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function parseRepo(url) {
  const m = String(url || '').match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

async function githubFacts(repoUrl, cfg, fetchImpl) {
  const p = parseRepo(repoUrl);
  if (!p) return { provided: !!repoUrl, host: repoUrl ? 'not-github' : null };
  if (cfg.mock) { // offline fixture so the demo and tests never depend on GitHub being reachable
    const fx = path.join(cfg.root, 'fixtures', 'github', `${p.owner}__${p.repo}.json`);
    if (existsSync(fx)) return { provided: true, ...JSON.parse(readFileSync(fx, 'utf8')) };
  }
  const h = { 'user-agent': 'FinePrint', accept: 'application/vnd.github+json' };
  if (cfg.githubToken) h.authorization = `Bearer ${cfg.githubToken}`;
  const r = await fetchImpl(`https://api.github.com/repos/${p.owner}/${p.repo}`, { headers: h, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return { provided: true, reachable: false, note: 'Repository not found or private (GitHub API 404 without auth).' };
  if (!r.ok) return { provided: true, reachable: null, note: `GitHub API ${r.status}` };
  const j = await r.json();
  let readme = '';
  const rr = await fetchImpl(`https://api.github.com/repos/${p.owner}/${p.repo}/readme`, { headers: { ...h, accept: 'application/vnd.github.raw' }, signal: AbortSignal.timeout(8000) });
  if (rr.ok) readme = (await rr.text()).slice(0, 500_000);
  return {
    provided: true, reachable: true, public: !j.private, fullName: j.full_name,
    license: j.license?.spdx_id || null, description: j.description || '', pushedAt: j.pushed_at, createdAt: j.created_at,
    readmeChars: readme.length, readmeMentions: mentions(readme),
  };
}

export function mentions(text) {
  const t = String(text || '').toLowerCase();
  return {
    nemotron: /nemotron/.test(t), nvidia: /nvidia/.test(t), tokenFactory: /token factory|tokenfactory/.test(t),
    nebius: /nebius/.test(t), tavily: /tavily/.test(t), setup: /install|npm |pip |docker|run /.test(t), license: /license/.test(t),
  };
}

async function youtubeFacts(videoUrl, minutes, cfg, fetchImpl) {
  if (!videoUrl) return { provided: false, durationMin: minutes ?? null };
  const isYT = /youtube\.com|youtu\.be/.test(videoUrl);
  let publicOk = null;
  if (isYT && !cfg.mock) {
    const r = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(videoUrl)}`, { signal: AbortSignal.timeout(8000) });
    publicOk = r.ok; // 401/403/404 when private or removed
  }
  return { provided: true, youtube: isYT, embeddable: publicOk, durationMin: minutes ?? null };
}

async function demoFacts(url, cfg, fetchImpl) {
  if (!url) return { provided: false };
  if (cfg.mock) return { provided: true, status: 'not-checked (mock)' };
  try { const r = await safeFetch(url, { fetchImpl, lookup: cfg.lookup, limits: cfg.limits, readBody: false }); return { provided: true, status: r.status }; }
  catch (e) { return { provided: true, status: 'unreachable', note: e.message }; }
}

export function textFacts(desc = '') {
  const letters = desc.replace(/[^\p{L}]/gu, '');
  const latin = letters.replace(/[^A-Za-z]/g, '');
  return { chars: desc.length, englishShare: letters.length ? Number((latin.length / letters.length).toFixed(2)) : null, mentions: mentions(desc) };
}

export async function collectEvidence(entry, cfg, { fetchImpl = fetch } = {}) {
  const [repo, video, demo] = await Promise.all([
    githubFacts(entry.repoUrl, cfg, fetchImpl),
    youtubeFacts(entry.videoUrl, entry.videoMinutes, cfg, fetchImpl),
    demoFacts(entry.demoUrl, cfg, fetchImpl),
  ]);
  return {
    track: entry.track || null,
    repo, video, demo,
    description: textFacts(entry.description),
    feedbackProvided: !!(entry.feedback && entry.feedback.trim().length > 40),
    existedBefore: entry.existedBefore ?? null,
    city: entry.city || null,
  };
}
