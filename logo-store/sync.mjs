// logo-store sync — keep our own copy of every logo `entities` points at.
//
//   node --env-file=.env sync.mjs            copy new logos, upload, record
//   node --env-file=.env sync.mjs --no-fetch upload and record what is already in img/
//   node --env-file=.env sync.mjs --dry-run  report only
//
// Why: `entities.logo_url` is a link to someone else's image (Wikipedia mostly).
// Those rot — 596 of 16,588 were dead on 23 Nov 2026, the Buffalo Bills among
// them — and every site that reads `entities` loses the logo at once. This job
// copies each image once into the `sports-logos` Vercel Blob store, shrunk to
// 160px, and writes the copy's address to `entities.logo_store_url`. Sites
// read that field first; the original link stays as the record of where the
// image came from.
//
// A logo is keyed by its source file, so teams that share one image share one
// copy, and a link that changes to a different file gets a new copy.
// Country flags (flagcdn) are left where they are: small, stable, and 4,101
// rows share about 200 of them.
//
// Idempotent. Fetches one image at a time, about one a second, because
// Wikipedia answers 429 above that; anything refused is simply picked up on
// the next run.
import { MongoClient } from 'mongodb';
import { put, list } from '@vercel/blob';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMG = join(HERE, 'img'), WORK = join(HERE, 'work');
mkdirSync(IMG, { recursive: true }); mkdirSync(WORK, { recursive: true });
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run'), NO_FETCH = argv.includes('--no-fetch');
const MAX_FETCH = Number((argv.find((a) => a.startsWith('--max-fetch=')) ?? '').split('=')[1] ?? 4000);
const PREFIX = 'v1/';
const UA = 'logo-store-sync/1.0 (keeps one copy of each team crest; 1 request per second)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** The key a logo link is stored under, or null for links we do not copy. */
export function keyOf(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.host === 'flagcdn.com') return null;
  if (u.host.endsWith('wikimedia.org')) {
    const seg = u.pathname.split('/').map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
    const file = u.pathname.includes('Special:FilePath') ? seg.at(-1) : seg.includes('thumb') ? seg[seg.indexOf('thumb') + 3] : seg.at(-1);
    return 'w-' + sha(String(file).replace(/_/g, ' '));
  }
  return 't-' + sha(url);
}

const client = new MongoClient(process.env.MONGO_URI, { appName: 'logo-store:sync' });
await client.connect();
const col = client.db(process.env.MONGO_DB || 'gutsys_sport').collection('entities');
const rows = await col.find({ logo_url: { $type: 'string', $ne: '' } }).project({ sport: 1, name: 1, logo_url: 1, logo_store_url: 1 }).toArray();
const want = new Map();                       // key -> one source url
for (const r of rows) { const k = keyOf(r.logo_url); if (k && !want.has(k)) want.set(k, r.logo_url); }
console.log(`${stamp()} ${rows.length} records with a logo, ${want.size} distinct images to hold`);

// 1. copy what we do not have yet
let fetched = 0, refused = 0, failed = 0;
if (!NO_FETCH && !DRY) {
  const todo = [...want].filter(([k]) => !existsSync(join(IMG, k + '.png'))).slice(0, MAX_FETCH);
  if (todo.length) console.log(`  fetching ${todo.length}`);
  for (const [k, url] of todo) {
    try {
      const r = await fetch(url.replace(/\?utm_[^]*$/, ''), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(40000) });
      if (r.status === 429) { refused++; await sleep(1100); continue; }
      if (!r.ok) { failed++; continue; }
      const raw = join(WORK, k + '.raw');
      writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
      try { execFileSync('sips', ['-s', 'format', 'png', '-Z', '160', raw, '--out', join(IMG, k + '.png')], { stdio: 'ignore' }); fetched++; }
      catch { failed++; }
      rmSync(raw, { force: true });
    } catch { failed++; }
    await sleep(1100);
  }
  console.log(`  fetched ${fetched}, refused for now ${refused}, failed ${failed}`);
}

// 2. upload what the store does not have
const have = new Map();                       // key -> public url
let cursor;
do {
  const page = await list({ prefix: PREFIX, limit: 1000, cursor });
  for (const b of page.blobs) have.set(b.pathname.slice(PREFIX.length).replace(/\.png$/, ''), b.url);
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);
const up = [...want.keys()].filter((k) => !have.has(k) && existsSync(join(IMG, k + '.png')));
console.log(`  store holds ${have.size}; ${up.length} to upload`);
let uploaded = 0;
if (!DRY) {
  let i = 0;
  const worker = async () => {
    while (i < up.length) {
      const k = up[i++];
      for (let a = 0; a < 4; a++) {
        try {
          const b = await put(PREFIX + k + '.png', readFileSync(join(IMG, k + '.png')), {
            access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'image/png', cacheControlMaxAge: 31536000,
          });
          have.set(k, b.url); uploaded++; break;
        } catch (e) { if (a === 3) console.error('  upload failed', k, String(e?.message ?? e).slice(0, 80)); else await sleep(1500 * (a + 1)); }
      }
      if (uploaded && uploaded % 500 === 0) console.log(`  uploaded ${uploaded}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// 3. record our copy against every record that uses it
// resolved_at is the watermark the Atlas mirrors copy `entities` by, so a
// record only reaches the deployed sites if it moves.
const now = new Date();
const ops = [];
for (const r of rows) {
  const k = keyOf(r.logo_url), url = k ? have.get(k) ?? null : null;
  if ((r.logo_store_url ?? null) !== url && url) ops.push({ updateOne: { filter: { _id: r._id, logo_url: r.logo_url }, update: { $set: { logo_store_url: url, resolved_at: now } } } });
}
// a record whose link was cleared must not keep pointing at the old copy
const stale = await col.countDocuments({ logo_url: null, logo_store_url: { $type: 'string' } });
console.log(`  uploaded ${uploaded}; ${ops.length} records to point at our copy; ${stale} cleared records still holding one`);
if (!DRY) {
  for (let i = 0; i < ops.length; i += 500) await col.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  if (stale) await col.updateMany({ logo_url: null, logo_store_url: { $type: 'string' } }, { $unset: { logo_store_url: '' }, $set: { resolved_at: now } });
}
// 4. publish the lookup files the Odds Library page reads (it has no database
//    behind it): one per sport, name -> logo, plus the competition badges.
//    Our copy where we have one, the original link otherwise. Short cache, so
//    tonight's new logos show up without a deploy.
const nameKey = (x) => String(x ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const bySport = new Map(), comps = {};
let base = null;
for (const r of rows) {
  if (!r.sport || !r.name) continue;
  const k = keyOf(r.logo_url), url = (k && have.get(k)) || r.logo_url;
  if (k && have.get(k) && !base) base = have.get(k).slice(0, have.get(k).indexOf(PREFIX) + PREFIX.length);
  if (r.sport === 'competition') { comps[r.name] = url; continue; }
  if (!bySport.has(r.sport)) bySport.set(r.sport, {});
  const nk = nameKey(r.name);
  if (nk && !bySport.get(r.sport)[nk]) bySport.get(r.sport)[nk] = url;
}
if (!DRY && base) {
  const P = [base, 'https://upload.wikimedia.org/wikipedia/', 'https://thumb.wikimedia.org/wikipedia/', 'https://flagcdn.com/'];
  const pack = (u) => { const i = P.findIndex((p) => u.startsWith(p)); return i >= 0 ? i + '|' + u.slice(P[i].length) : u; };
  const json = (path, obj) => put('index/' + path, JSON.stringify(obj), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 3600 });
  for (const [sport, l] of bySport) await json(`teams/${sport}.json`, { p: P, l: Object.fromEntries(Object.entries(l).map(([k, u]) => [k, pack(u)])) });
  await json('competitions.json', comps);
  // For any other reader holding a Wikipedia logo link of its own (live-fixtures
  // keeps a separate table): the keys we hold, so it can swap a link for our
  // copy. A link's key is 'w-' + the first 16 hex of sha1(file title, spaces
  // not underscores); our copy is then v1/<key>.png.
  await json('keys.json', [...have.keys()].sort());
  console.log(`  published lookups for ${bySport.size} sports and ${Object.keys(comps).length} competitions`);
}
const covered = await col.countDocuments({ logo_store_url: { $type: 'string' } });
console.log(`${stamp()} done: ${covered} records served from our store, ${want.size - have.size} images still to copy`);
await client.close();
