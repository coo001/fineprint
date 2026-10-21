// MOCK provider: rule-based stand-ins for the three model steps, used when no NEBIUS_API_KEY is set.
// They return the same JSON shapes as the real prompts so the whole pipeline, UI and tests run offline.
// Results in MOCK mode are produced by these heuristics, NOT by Nemotron. The UI labels every run with its mode.

const est = (s) => Math.ceil(String(s).length / 4);

function sentences(text) {
  return text.split('\n').flatMap((line) => line.replace(/^[-*\s]+/, '').split(/(?<=[.!?])\s+(?=[A-Z(])/)).map((s) => s.trim()).filter((s) => s.length >= 25 && s.length <= 600);
}

const CAT_RULES = [
  ['deadline', /submission period|deadline|\b(am|pm) pacific/i],
  ['eligibility', /eligib|age of majority|is not open|residents of|employees/i],
  ['video', /video|youtube|\bminutes?\b/i],
  ['repository', /repositor|open source license|readme/i],
  ['demo', /working demo|hosted application|test build|login credentials/i],
  ['language', /english/i],
  ['technology', /token factory|nebius ai cloud|nvidia open source model|nemotron|tavily api/i],
  ['track', /track/i],
  ['feedback', /feedback/i],
  ['judging', /judg|criteria|stage one|stage two/i],
  ['prize', /prize|award|winner|\$\d/i],
  ['ip', /intellectual property|original work|license to use/i],
];

function classify(s) {
  const cat = (CAT_RULES.find(([, re]) => re.test(s)) || ['other'])[0];
  const kind = /\b(must|required|requirement|shall|is not open|not eligible|need to|needs to)\b/i.test(s) ? 'hard'
    : /\b(should|encourage|recommend|make sure|include|provide|be sure)\b/i.test(s) || /^(Upload|Provide|Include|Submit|Create|Pick|Tell|Identify|Review)\b/.test(s) ? 'soft' : 'info';
  return { cat, kind };
}

function mockExtract(user) {
  const text = user.split('\nTEXT:\n')[1] || '';
  const reqs = [];
  for (const s of sentences(text)) {
    const { cat, kind } = classify(s);
    if (cat === 'other' && kind === 'info') continue;
    reqs.push({ category: cat, kind, requirement: s.length > 110 ? s.slice(0, 107).replace(/\s+\S*$/, '') + '...' : s, quote: s });
  }
  return { requirements: reqs.slice(0, 60) };
}

function section(user, name, next) {
  const a = user.indexOf(`${name}:\n`) + name.length + 2;
  const b = next ? user.indexOf(`\n${next}:\n`) : user.length;
  return JSON.parse(user.slice(a, b));
}

function judgeOne(r, ev) {
  const q = (r.quote + ' ' + r.requirement).toLowerCase();
  const res = (status, reason, fix = '') => ({ id: r.id, status, reason, fix });
  const repo = ev.repo || {};
  const TRACKS = ['physical ai', 'personal ai', 'coding and agentic', 'best apps'];
  const mentioned = TRACKS.filter((t) => q.includes(t));
  if (mentioned.length === 1 && !/not required for/.test(q) && !String(ev.track || '').toLowerCase().includes(mentioned[0])) return res('n/a', `Applies to the ${mentioned[0]} track only; entry track = ${ev.track || 'none'}.`);
  if (r.category === 'repository' || /repositor/.test(q)) {
    if (!repo.provided) return res('action', 'evidence.repo.provided is false: no repository URL yet.', 'Create the public GitHub repository and paste its URL.');
    if (repo.reachable === false) return res('fail', 'evidence.repo.reachable is false: GitHub returns 404 (private or missing).', 'Make the repository public.');
    if (/license/.test(q)) return repo.license ? res('pass', `evidence.repo.license = ${repo.license}.`) : res('fail', 'evidence.repo.license is null: GitHub does not detect a license.', 'Add a LICENSE file (MIT/Apache-2.0) at the repository root.');
    if (/readme|highlight|nemotron/.test(q)) {
      const m = repo.readmeMentions || {};
      return m.nemotron && m.tokenFactory && m.setup ? res('pass', 'README mentions Nemotron, Token Factory and setup steps.') : res('fail', `README mentions: nemotron=${!!m.nemotron}, tokenFactory=${!!m.tokenFactory}, setup=${!!m.setup}.`, 'Add a "How we use Nemotron on Token Factory" section and setup steps to the README.');
    }
    return repo.public ? res('pass', 'evidence.repo.public is true.') : res('manual', 'Repository visibility unknown.');
  }
  if (r.category === 'video' || /video/.test(q)) {
    const v = ev.video || {};
    if (!v.provided) return res('action', 'evidence.video.provided is false: no video URL yet.', 'Upload the demo to YouTube as Public and paste the link.');
    if (/three|3-minute|3 minutes|minute/.test(q) && !/one minute|1-minute/.test(q) && v.durationMin != null) return v.durationMin < 3 ? res('pass', `durationMin = ${v.durationMin}.`) : res('fail', `durationMin = ${v.durationMin}, judges may stop at 3:00.`, 'Cut the video under 3 minutes.');
    if (/youtube|public/.test(q) && v.youtube === false) return res('fail', 'Video is not on YouTube.', 'Upload to YouTube as Public.');
    return res('manual', 'Content of the video cannot be checked automatically.', 'Watch the video once against this rule.');
  }
  if (r.category === 'demo') return ev.demo?.provided ? res('pass', `evidence.demo.status = ${ev.demo.status}.`) : res('action', 'No demo URL in the entry.', 'Deploy the app and paste a URL judges can open.');
  if (r.category === 'language') return ev.description.englishShare == null ? res('action', 'No description yet.') : ev.description.englishShare > 0.9 ? res('pass', `englishShare = ${ev.description.englishShare}.`) : res('fail', `englishShare = ${ev.description.englishShare}.`, 'Provide English text or a translation.');
  if (r.category === 'technology') {
    const m = { ...(ev.repo?.readmeMentions || {}) };
    if (/tavily/.test(q)) return m.tavily ? res('pass', 'README mentions Tavily.') : res('n/a', 'Tavily is optional (bonus award only).');
    return m.nemotron && m.tokenFactory ? res('pass', 'README documents Nemotron on Token Factory.') : res('manual', 'Cannot confirm model use from evidence.', 'Show the Token Factory calls and model ids in README and video.');
  }
  if (r.category === 'track') return ev.track ? res('pass', `track = ${ev.track}.`) : res('action', 'No track selected.', 'Pick one track.');
  if (r.category === 'feedback') return ev.feedbackProvided ? res('pass', 'Feedback text provided.') : res('action', 'feedbackProvided is false.', 'Write feedback on Token Factory and Nemotron (also eligible for Most Valuable Feedback).');
  if (r.category === 'prize' && /city|irl|attend/.test(q)) return ev.city ? res('manual', `city = ${ev.city}; attendance must be true.`) : res('n/a', 'No city selected.');
  if (r.category === 'eligibility') return res('manual', 'Eligibility depends on the entrant; confirm once.');
  return res('manual', 'Needs a human read.');
}

function mockJudge(user) {
  const reqs = section(user, 'REQUIREMENTS', 'EVIDENCE');
  const ev = section(user, 'EVIDENCE');
  return { results: reqs.map((r) => judgeOne(r, ev)) };
}

const STOP = new Set('the a an to of and or for in on is are be you your this that with as by at from will any one all not no do does can may if it its their they'.split(' '));
const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

function mockDeep(user) {
  const reqs = section(user, 'REQUIREMENTS', 'RESULTS');
  const results = section(user, 'RESULTS');
  const conflicts = [];
  const neg = (q) => /(don.t|do not|does not|not required|no need|without)\b.{0,60}(attend|need|require|qualify)/i.test(q);
  for (const a of reqs) for (const b of reqs) {
    if (a.source === b.source || !neg(a.quote) || neg(b.quote) || a.category !== b.category) continue;
    const wa = words(a.quote), shared = [...words(b.quote)].filter((w) => wa.has(w));
    if (shared.length >= 3 && /attend/i.test(b.quote)) conflicts.push({ a: b.id, b: a.id, topic: `Who qualifies for the ${(a.quote.match(/(?:[A-Z][a-z]+ ){1,3}Awards?/) || [shared.slice(0, 3).join(' ')])[0].replace(/Awards$/, 'Award')}`, explanation: `${b.id} (${b.source}) ties this to attending, while ${a.id} (${a.source}) says attending is not needed.`, whatToDo: 'Treat the Official Rules as binding and ask the organizer before relying on the looser page.' });
  }
  const byId = Object.fromEntries(reqs.map((r) => [r.id, r]));
  const rank = { fail: 0, action: 1 };
  const fixes = results.filter((r) => r.fix && r.status in rank)
    .sort((x, y) => rank[x.status] - rank[y.status] || (byId[x.id]?.kind === 'hard' ? -1 : 1))
  ;
  const grouped = new Map();
  for (const r of fixes) grouped.set(r.fix, [...(grouped.get(r.fix) || []), r.id]);
  const uniq = [...grouped].slice(0, 5).map(([fix, ids]) => `${fix} (${ids.join(', ')})`);
  const fails = results.filter((r) => r.status === 'fail').length, acts = results.filter((r) => r.status === 'action').length;
  return { conflicts: conflicts.slice(0, 3), topFixes: uniq, verdict: fails ? `Not ready: ${fails} requirement(s) fail and ${acts} still need action.` : acts ? `Almost ready: ${acts} item(s) still need action.` : 'Ready to submit, pending the manual checks.' };
}

export async function mockChat({ step, system, user }) {
  const out = step === 'extract' ? mockExtract(user) : step === 'judge' ? mockJudge(user) : mockDeep(user);
  const content = JSON.stringify(out);
  await new Promise((r) => setTimeout(r, 40));
  return { content, promptTokens: est(system) + est(user), completionTokens: est(content) };
}
