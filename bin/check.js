#!/usr/bin/env node
// CLI: node bin/check.js <rules-url> [more urls] --repo URL --video URL --minutes 2.5 --track "..." --tz Asia/Seoul
import { getConfig, publicConfig } from '../src/config.js';
import { runCheck, toMarkdown } from '../src/pipeline.js';
import { writeFile } from 'node:fs/promises';

const a = process.argv.slice(2); const urls = []; const o = {};
for (let i = 0; i < a.length; i++) a[i].startsWith('--') ? (o[a[i].slice(2)] = a[++i]) : urls.push(a[i]);
const cfg = getConfig();
console.error(`mode=${publicConfig(cfg).mode}`);
const rep = await runCheck({ urls, timeZone: o.tz || 'UTC', entry: { repoUrl: o.repo, videoUrl: o.video, videoMinutes: o.minutes ? Number(o.minutes) : undefined, demoUrl: o.demo, track: o.track, description: o.description || '', feedback: o.feedback || '' } }, cfg, { emit: (e) => e.type === 'step' && console.error(`- ${e.msg}`) });
const md = toMarkdown(rep);
if (o.out) await writeFile(o.out, md); else console.log(md);
