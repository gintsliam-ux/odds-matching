// Re-key `entities` rows whose join key disagrees with their own name.
//
// `normalized` is the ONLY join key between a fixture's team name and its
// crest — see normEntity in server/lib/events.mjs, which is what the board
// computes at read time. A row whose stored key does not equal
// normEntity(name) is invisible to that join however good its crest is.
//
// 310 rows are in that state, 286 of them holding a crest nobody can see, and
// 291 of the 310 have a non-ASCII name. That is the whole story: an older
// resolver lowercased and then replaced every non-[a-z0-9] run with "_"
// WITHOUT folding accents first, so
//
//   "Malmo FF"  (o with diaeresis)  ->  malm_ff     stored
//                                       malmo_ff    what the board looks up
//   "Sao Paulo FC" (a with tilde)   ->  s_o_paulo_fc
//                                       sao_paulo_fc
//
// The current resolver folds correctly, so new rows are fine. These survive
// because a row that already HAS a crest is never revisited, and so its key is
// never recomputed.
//
// Collisions are the interesting case: a chunk of them already have a
// correctly keyed twin. Where the twin has no crest and the mis-keyed row
// does, the crest is moved across -- that is pure gain.
//
// Where the twin already has a crest the mis-keyed row is left ALONE, and
// deliberately. It is already invisible to the join, so deleting it buys
// nothing, and (sport, normalized) collapsing two names into one key is not
// proof they are the same club -- the resolver treats "Real Madrid CF" and
// "Real Madrid" as one entity, but two genuinely different clubs can land on
// one key too. Removing 238 rows on that assumption is not a call worth making
// for tidiness. --prune-duplicates is there if it ever is.
//
// Usage:
//   node --env-file=.env scripts/repair-entity-keys.mjs --dry-run
//   node --env-file=.env scripts/repair-entity-keys.mjs
//   node --env-file=.env scripts/repair-entity-keys.mjs --target=nas|mirror|both
//   node --env-file=.env scripts/repair-entity-keys.mjs --prune-duplicates
//
// Writes to BOTH stores by default. `entities` mirrors in watermark mode on
// `resolved_at`, which copies updates but never prunes deletes — so the mirror
// is repaired directly rather than left to catch up.

import { MongoClient } from 'mongodb';
import { normEntity } from '../server/lib/events.mjs';

const DRY = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune-duplicates');
const targetArg = process.argv.find((a) => a.startsWith('--target='));
const TARGET = targetArg ? targetArg.split('=')[1] : 'both';

const NAS_URI = process.env.MONGO_URI;
const NAS_DB = process.env.MONGO_DB || 'gutsys_sport';
const MIRROR_URI = process.env.MIRROR_URI || process.env.BETS_URI;
const MIRROR_DB = process.env.MIRROR_DB || 'gutsys_sport';

async function repair(label, uri, dbName) {
  if (!uri) {
    console.log(`\n${label}: no connection string configured — skipped`);
    return;
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20_000, maxPoolSize: 4 });
  await client.connect();
  try {
    const ent = client.db(dbName).collection('entities');
    const rows = await ent
      .find({}, { projection: { _id: 1, sport: 1, name: 1, normalized: 1, logo_url: 1, country: 1 } })
      .toArray();

    // Every key currently in use, so a re-key can tell a free slot from a twin.
    const owners = new Map();
    for (const r of rows) {
      if (r.normalized == null) continue;
      owners.set(`${r.sport}|${r.normalized}`, r);
    }

    const rekey = [];
    const mergeThenDrop = [];
    const dropDuplicate = [];
    let noName = 0;

    for (const r of rows) {
      if (!r.name) { noName++; continue; }
      const want = normEntity(r.name);
      if (!want || want === r.normalized) continue;

      const twin = owners.get(`${r.sport}|${want}`);
      if (!twin) {
        rekey.push({ r, want });
        // Claim the slot so two mis-keyed rows cannot both take it.
        owners.set(`${r.sport}|${want}`, r);
      } else if (twin.logo_url == null && r.logo_url != null) {
        mergeThenDrop.push({ r, twin });
      } else {
        dropDuplicate.push({ r, twin });
      }
    }

    const crests = (list) => list.filter((x) => x.r.logo_url != null).length;
    console.log(`\n${label} (${rows.length} rows)${DRY ? '  [DRY RUN]' : ''}`);
    console.log(`  re-key in place        ${String(rekey.length).padStart(4)}   (${crests(rekey)} carrying a crest)`);
    console.log(`  crest moved to twin    ${String(mergeThenDrop.length).padStart(4)}`);
    console.log(`  duplicate left alone   ${String(dropDuplicate.length).padStart(4)}   (${crests(dropDuplicate)} with a crest the twin already has)${PRUNE ? '  [--prune-duplicates: WILL BE DELETED]' : ''}`);
    console.log(`  rows with no name      ${String(noName).padStart(4)}`);

    for (const { r, want } of rekey.slice(0, 8)) {
      console.log(`    [${r.sport}] "${r.name}"  ${r.normalized} -> ${want}${r.logo_url ? '  (crest)' : ''}`);
    }
    if (rekey.length > 8) console.log(`    … ${rekey.length - 8} more`);

    if (DRY) return;

    const stamp = new Date();
    let done = 0, failed = 0;
    for (const { r, want } of rekey) {
      try {
        // resolved_at is the mirror's watermark; without bumping it the repair
        // would never travel.
        await ent.updateOne({ _id: r._id }, { $set: { normalized: want, resolved_at: stamp } });
        done++;
      } catch (err) {
        // (sport, normalized) is unique. A slot this run thought was free can
        // still be taken by a row written since the read — report it rather
        // than abort the rest.
        failed++;
        console.log(`    ! ${r.sport} "${r.name}" -> ${want}: ${String(err?.message ?? err).slice(0, 90)}`);
      }
    }
    for (const { r, twin } of mergeThenDrop) {
      const fill = { resolved_at: stamp };
      if (twin.logo_url == null && r.logo_url != null) fill.logo_url = r.logo_url;
      if (twin.country == null && r.country != null) fill.country = r.country;
      await ent.updateOne({ _id: twin._id }, { $set: fill });
      done++;
    }
    if (PRUNE) {
      for (const { r } of dropDuplicate) {
        await ent.deleteOne({ _id: r._id });
        done++;
      }
    }
    console.log(`  applied ${done} changes${failed ? `, ${failed} refused by the unique index` : ''}`);

    // Prove it: nothing should disagree with its own name afterwards.
    const after = await ent.find({}, { projection: { _id: 0, sport: 1, name: 1, normalized: 1 } }).toArray();
    const left = after.filter((r) => r.name && r.normalized != null && normEntity(r.name) !== r.normalized);
    console.log(`  rows still disagreeing with their name: ${left.length}` +
      (PRUNE ? '' : `  (the duplicates left alone — they were already invisible)`));
  } finally {
    await client.close().catch(() => {});
  }
}

if (TARGET === 'nas' || TARGET === 'both') await repair('NAS', NAS_URI, NAS_DB);
if (TARGET === 'mirror' || TARGET === 'both') await repair('mirror', MIRROR_URI, MIRROR_DB);
console.log(DRY ? '\ndry run — nothing written' : '\ndone.');
