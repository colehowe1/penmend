// Reads the public Chrome Web Store pages for Penmend and a few competitors (no sign-in) and adds
// one row per extension to store/stats.csv: users, rating, number of ratings, version, last update.
// Run weekly (the "Penmend store stats" scheduled task does): `node tools/store-stats.mjs`.
// Prints the new rows next to the previous ones so a change is easy to see.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ITEMS = [
  ['Penmend', 'bfmabkejkkhhfiljngoimnhmeakdagmi'],
  ['Harper', 'lodbfhdipoipcjmlebjbgmmgekckhpfb'],
  ['LanguageTool', 'oldceeleldhonbafppcapldpdifcinji'],
  ['Grammarly', 'kbfnbcaeplbcioakkpcpgfkobkghlhen'],
  ['QuillBot', 'iidnbdjijdkbmajdffnidomddglmieko'],
  ['ProWritingAid', 'npnbdojkgkbcdfdjlfdmplppdphlhhcf'],
  ['Wordtune', 'nllcnknpjnininklegdoijpljgdjkijc'],
];
const CSV = fileURLToPath(new URL('../store/stats.csv', import.meta.url));
const HEADER = 'date,name,id,status,users,rating,ratings,version,updated';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

const text = (html) => html.replace(/<[^>]+>/g, '|').replace(/&amp;/g, '&');
const pick = (s, re) => (s.match(re) || [])[1] || '';

async function read(id) {
  const res = await fetch(`https://chromewebstore.google.com/detail/${id}`, { headers: { 'user-agent': UA } });
  // An item that isn't published (in review, rejected, taken down) redirects to an "empty-title" page.
  if (!res.ok || res.url.includes('/empty-title/')) return { status: res.ok ? 'not live' : `http ${res.status}` };
  const s = text(await res.text());
  return {
    status: 'live',
    users: pick(s, /\|([\d,]+\+?) users?\|/).replace(/,/g, ''),
    rating: pick(s, /([\d.]+) out of 5/),
    ratings: pick(s, /\|([\d.,]+K?M?) ratings?\|/),
    version: pick(s, /\|Version\|+([^|]+)\|/),
    updated: pick(s, /\|Updated\|+([^|]+)\|/),
  };
}

const date = new Date().toISOString().slice(0, 10);
const old = existsSync(CSV) ? readFileSync(CSV, 'utf8').trim().split('\n').slice(1) : [];
const last = new Map();
for (const line of old) last.set(line.split(',')[1], line);

const rows = [];
for (const [name, id] of ITEMS) {
  let r;
  try { r = await read(id); } catch (e) { r = { status: `error ${e.message}` }; }
  const cells = [date, name, id, r.status, r.users, r.rating, r.ratings, r.version, r.updated]
    .map((c) => String(c ?? '').replace(/,/g, ' '));
  rows.push(cells.join(','));
  console.log(`${name.padEnd(14)} now:  ${cells.slice(3).join(' · ')}`);
  if (last.has(name)) console.log(`${''.padEnd(14)} last: ${last.get(name).split(',').slice(3).join(' · ')} (${last.get(name).split(',')[0]})`);
}
writeFileSync(CSV, [HEADER, ...old, ...rows].join('\n') + '\n');
console.log(`\n${rows.length} rows added to store/stats.csv`);
