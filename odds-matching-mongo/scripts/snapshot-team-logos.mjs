// Snapshot team and player logos from gutsys_sport.entities into static files
// the Odds Library page (../../index.html) can read: assets/team-logos/<sport>.json.
//
//   MONGODB_FROM=~/odds-library/ node --env-file=../arb-tracker-mongo/.env scripts/snapshot-team-logos.mjs
//
// Same reason as assets/competition-logos.json: the public odds API has no
// entities endpoint, and crest URLs change rarely enough that a static file
// per sport beats standing a service up. One file per sport so a page only
// fetches the sport it is showing.
//
// File shape: { "p": [url prefixes], "l": { "<lowercased name>": "<prefix index>|<rest of url>" } }
// Needs MONGO_URI (gutsys_sport on the NAS). One indexed-free read of ~30k small
// docs; run it by hand when crests have been re-resolved, not on a schedule.

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This folder has no node_modules of its own on every machine; MONGODB_FROM
// points at any project that has the driver installed (e.g. ~/odds-library/).
const { MongoClient } = createRequire(process.env.MONGODB_FROM ?? import.meta.url)('mongodb');

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'team-logos');
const PREFIXES = [
  'https://upload.wikimedia.org/wikipedia/',
  'https://r2.thesportsdb.com/images/media/',
  'https://www.thesportsdb.com/images/media/',
  'https://a.espncdn.com/',
];
const key = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const client = new MongoClient(process.env.MONGO_URI, { appName: 'oddslib:logo-snapshot' });
await client.connect();
const rows = await client.db(process.env.MONGO_DB || 'gutsys_sport').collection('entities')
  .find({ logo_url: { $type: 'string', $ne: '' }, sport: { $ne: 'competition' } })
  .project({ _id: 0, sport: 1, name: 1, logo_url: 1 }).toArray();
await client.close();

const bySport = new Map();
const hosts = new Map();
for (const r of rows) {
  if (!r.sport || !r.name || !/^https:\/\//.test(r.logo_url)) continue;
  const url = r.logo_url.replace(/\?utm_source=[^#]*$/, '');
  const i = PREFIXES.findIndex((p) => url.startsWith(p));
  const packed = i >= 0 ? i + '|' + url.slice(PREFIXES[i].length) : url;
  if (i < 0) { const h = new URL(url).host; hosts.set(h, (hosts.get(h) ?? 0) + 1); }
  if (!bySport.has(r.sport)) bySport.set(r.sport, {});
  const k = key(r.name);
  if (k && !bySport.get(r.sport)[k]) bySport.get(r.sport)[k] = packed;
}
mkdirSync(OUT, { recursive: true });
for (const [sport, l] of bySport) {
  const body = JSON.stringify({ p: PREFIXES, l });
  writeFileSync(join(OUT, sport + '.json'), body);
  console.log(sport.padEnd(14), String(Object.keys(l).length).padStart(6), 'logos', (body.length / 1024).toFixed(0).padStart(5), 'KB');
}
console.log('other hosts:', [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, n]) => h + ' ' + n).join(', '));
