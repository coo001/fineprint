# FinePrint

**An agent that reads a contest's official rules and checks your entry against them, quoting the exact sentence behind every rule.**

Hackathon, grant and contest entries are often lost on technicalities: a repository without a detectable license, a video longer than the limit, a README that never says which model was used, a deadline read in the wrong time zone. The rules are spread over several pages (overview, official rules, resources, FAQ) that do not always agree.

FinePrint takes the URLs of the official pages and your entry (repository, video, demo URL, track, description, feedback) and returns:

- every rule it found, each with the **verbatim sentence** and the page it came from;
- a status per rule for your entry: `pass`, `fail`, `action` (still to do), `manual` (a human must check), `n/a`;
- the **submission deadline converted to your time zone** (computed by code, not by the model);
- **conflicts between official pages** (for example, one page tying a prize to attending an event, another saying attendance is not needed);
- the five fixes to make first, disqualification risks before score improvements;
- a Markdown export.

Built for the Nebius × NVIDIA Global AI Hackathon, Best Apps and Agents track.

## How it uses NVIDIA Nemotron on Nebius Token Factory

All model calls go to the Token Factory OpenAI-compatible endpoint (`/v1/chat/completions`). The app routes each step to a different Nemotron size, as the track description suggests:

| Step | Tier | Default model (configurable) | Why this size |
|---|---|---|---|
| Extract rules from each page chunk | fast | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | Many small calls in parallel (one per ~6k-character chunk); speed and cost matter most. |
| Judge each rule against the evidence | mid | `nvidia/nemotron-3-super-120b-a12b` | One call over all rules plus the evidence JSON; needs careful reading. |
| Cross-page conflicts, fix order, verdict | deep | `nvidia/Nemotron-3-Ultra-550b-a55b` | One call that reasons across sources; called once per run. |

The UI shows each call's tier, tokens and latency, and a per-model usage summary.

Guards around the models, enforced in code:

- **Quote check.** A rule is kept only if its quote is found verbatim (after whitespace/typography normalization) in the page it came from. Rules with an invented or paraphrased quote are set aside and never reach the judging step.
- **Deadline by code.** Dates such as "Friday, October 30, 2026 (10:00 am Pacific Time)" are parsed and converted with the correct PDT/PST offset, then shown in the user's time zone.
- **Evidence by code.** Facts about the entry come from plain HTTP calls: the GitHub REST API (public or not, detected license, README mentions of Nemotron / Token Factory / setup), YouTube oEmbed (is the video publicly embeddable), and the demo URL's HTTP status. The judge model may only cite these facts.
- **Conflicts must cite two real rules from two different pages**, otherwise they are dropped.

Tavily: when `TAVILY_API_KEY` is set, pages are read with the Tavily Extract API (`/extract`, advanced depth); otherwise they are fetched directly.

A real three-tier run completed on 21 Oct 2026 over two saved official excerpts. Nano extracted the rules, Super checked the entry and Ultra reviewed conflicts. Actual call-level tokens and latency are shown in the included recorded LIVE report. This validates the API pipeline, not a full benchmark or a full-site crawl.

## Run it

Requires Node.js 20 or newer. The optional public deployment uses @vercel/blob for an atomic global budget ledger.

```bash
cp .env.example .env      # add NEBIUS_API_KEY (and optionally TAVILY_API_KEY)
npm start                 # http://127.0.0.1:3456
npm test                  # 39 tests, no model calls needed
```

CLI:

```bash
node bin/check.js https://nebiusglobalaihackathon.devpost.com/rules https://nebiusglobalaihackathon.devpost.com/ \
  --repo https://github.com/you/project --video https://youtu.be/... --minutes 2.5 \
  --track "Best Apps and Agents" --tz Asia/Seoul --out report.md
```

### MOCK mode

Without `NEBIUS_API_KEY` the app runs in **MOCK mode**: the three model steps are answered by rule-based stand-ins in `src/mock.js` that return the same JSON shapes, the three Nebius × NVIDIA hackathon pages are read from `fixtures/pages/`, and the sample repositories `sample-builder/draft-agent` and `sample-builder/fixed-agent` come from `fixtures/github/` (sample data, not real repositories). The UI shows a yellow MOCK badge and labels token counts as estimates. MOCK mode exists so the app and its tests run offline; the results judges should look at are from LIVE mode.

## Public demo safety

- **Default OFF for LIVE on a public deployment.** When `VERCEL` or `FINEPRINT_PUBLIC=1` is set the app answers in **MOCK** (clearly badged, free, no model/Tavily call) unless a request carries the secret header `x-demo-token` AND the server has `NEBIUS_API_KEY`, `FINEPRINT_ENABLE_LIVE=1`, `FINEPRINT_DEMO_TOKEN` (16+ chars) and `BLOB_READ_WRITE_TOKEN` (global spend ledger). Anyone can use MOCK without logging in. Locally (not public) a key still means LIVE.
- **Global spend ledger (`src/budget.js`).** Before every LIVE model request the server reserves a conservative dollar cost (UTF-8 bytes of the prompt at the input price + max output tokens at the output price) in a Vercel Blob object using ETag compare-and-swap writes. Conflict, storage error, unreadable ledger or cap reached means no model call (fail closed). Reservations are not refunded. Cap: `FINEPRINT_LEDGER_CAP_USD` (default 0.75).
- **What is only per-instance.** The concurrency cap, per-IP rate limit and the daily run/token counters (`src/safety.js`) live in memory. On serverless they are per instance and reset on restart, so they are abuse dampers, not a spending guarantee. The dollar ledger is the only global cost limit.
- **SSRF.** User URLs must be http(s) on ports 80/443, no credentials, no localhost/internal names, and every DNS answer must be a public address (loopback, private, link-local incl. 169.254.169.254, CGNAT, mapped/NAT64/6to4 IPv6 are blocked). Redirects are followed manually and re-checked (max 3). Known gap: the name is resolved once for the check and again by `fetch`, so a DNS-rebinding host could still slip through; Node's built-in fetch cannot pin the address.
- **Caps.** Fetch: 8 s, 1.5 MB, text types only. Request body 20 KB, 4 URLs of at most 300 chars, entry fields at most 2000 chars, source text 60k chars each / 120k total. Per check: 26 model calls, 90k chars per call, 6000 output tokens per call, 200k estimated tokens, 110 s overall; each model call also times out after 60 s.
- All numbers can be overridden with `LIMIT_*` env vars (see `src/config.js`).

## Project layout

```
server.js            HTTP server, NDJSON progress stream at POST /api/check
public/index.html    single-page UI
src/pipeline.js      the agent: sources -> extract -> verify -> evidence -> judge -> deep -> report
src/llm.js           Token Factory client, usage tracking, tolerant JSON parsing
src/sources.js       Tavily Extract / direct fetch, HTML to text, chunking
src/verify.js        quote verification, de-duplication, Pacific-time deadline parsing
src/evidence.js      GitHub / YouTube / demo URL facts
src/mock.js          MOCK-mode stand-ins
src/safety.js        SSRF-safe fetch, input validation, in-memory guard
src/budget.js        global dollar ledger (CAS reservation, Vercel Blob adapter)
test/                unit, LIVE-path (stubbed network) and end-to-end HTTP tests
```

## How it was built

Written during the hackathon submission period with an AI coding agent (Claude), which wrote most of the code, tests and demo material under the entrant's direction.

## License

MIT, see [LICENSE](LICENSE).

## Public demo safety and modes

The hosted app defaults to a clearly labeled offline sample. Judges can enter the access code supplied in the submission testing instructions to run actual Nemotron calls. The API pre-reserves a conservative per-request upper bound in a private Vercel Blob object using ETag conditional writes. All instances share a USD 0.65 reservation cap. Storage errors, conflicts or exhausted budget fail closed. There are also per-instance rate, input, redirect, time and output limits. These limits are safety controls, not a promise of availability beyond the provider trial-credit expiry. The recorded LIVE run remains viewable without a key and is explicitly labeled as recorded.

Set VERCEL=1 or FINEPRINT_PUBLIC=1, NEBIUS_API_KEY, FINEPRINT_ENABLE_LIVE=1, FINEPRINT_DEMO_TOKEN (at least 16 characters), BLOB_READ_WRITE_TOKEN and LIMIT_REQUEST_TIMEOUT_MS=55000 for public hosting. Never commit these values. In-memory rate counters reset between instances; only the Blob budget cap is global and durable. DNS rebinding is not fully prevented by the built-in fetch prechecks; use only public official contest URLs.

## Verification

The 39-test suite includes the original pipeline tests plus SSRF rejection, input/time limits, gate enforcement, budget exhaustion, CAS conflicts, restart persistence and truncated-JSON handling. The actual private Blob store adapter was checked with no inference calls; create, get/stream/ETag, conditional updates, rejection of a stale ETag and restart persistence passed.
