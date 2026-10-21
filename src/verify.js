// Deterministic guards around model output: every requirement must carry a quote that really exists in the source.

export function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-')
    .replace(/\\([*_#\[\]()-])/g, '$1').replace(/[*_`#>|"]/g, ' ').replace(/'/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// Returns { ok, score } — exact normalized substring, or >= 90% of the quote's words found in order in one window.
export function verifyQuote(quote, sourceText) {
  const q = norm(quote), s = norm(sourceText);
  if (q.length < 12) return { ok: false, score: 0, why: 'quote too short' };
  if (s.includes(q)) return { ok: true, score: 1 };
  const qw = q.split(' '), sw = s.split(' ');
  let best = 0;
  const first = new Set(qw.slice(0, 3));
  for (let i = 0; i < sw.length; i++) {
    if (!first.has(sw[i])) continue;
    let j = i, hit = 0;
    for (const w of qw) {
      const lim = Math.min(sw.length, j + 4);
      for (let k = j; k < lim; k++) if (sw[k] === w) { hit++; j = k + 1; break; }
    }
    best = Math.max(best, hit / qw.length);
    if (best === 1) break;
  }
  return { ok: best >= 0.9, score: Number(best.toFixed(2)) };
}

export function verifyRequirements(reqs, sources) {
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
  return reqs.map((r) => {
    const src = byId[r.source] || sources.find((s) => verifyQuote(r.quote, s.text).ok);
    const v = src ? verifyQuote(r.quote, src.text) : { ok: false, score: 0 };
    return { ...r, source: src?.id ?? r.source, sourceUrl: src?.url, quoteVerified: v.ok, quoteScore: v.score };
  });
}

// Drops near-duplicate requirements produced by overlapping chunks.
export function dedupe(reqs) {
  const seen = new Map();
  for (const r of reqs) {
    const key = norm(r.quote).slice(0, 80);
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()].map((r, i) => ({ ...r, id: `R${String(i + 1).padStart(2, '0')}` }));
}

// "Friday, October 30, 2026 (10:00 am Pacific Time)" or "Oct 30, 2026 @ 10:00am PDT" -> Date (PDT/PST handled).
// For a range ("Aug 26 ... – Oct 30 ...") the LAST date is returned, i.e. the end of the period.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_RE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})[^\d]{0,6}(\d{1,2}):(\d{2})\s*(am|pm)\s*\(?(Pacific|PT|PDT|PST)/gi;
export function parsePacific(text) {
  const all = [...String(text).matchAll(DATE_RE)];
  if (!all.length) return null;
  const [, mon, d, y, hh, mm, ap] = all[all.length - 1];
  const h = (Number(hh) % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0);
  for (const off of [7, 8]) { // try PDT then PST, keep the one Intl agrees with
    const dt = new Date(Date.UTC(+y, MONTHS.indexOf(mon.slice(0, 3).toLowerCase()), +d, h + off, +mm));
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'short' }).formatToParts(dt).find((p) => p.type === 'timeZoneName').value;
    if ((off === 7 && name === 'PDT') || (off === 8 && name === 'PST')) return dt;
  }
  return null;
}

export function formatInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(date);
}
