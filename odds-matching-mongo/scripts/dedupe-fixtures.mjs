// Collapse the 855 fixture_ids that exist on two documents.
//
// Cause: something inserts fixtures without setting `_id` to the fixture_id and
// without upserting on it, and `fixture_id_1` is not a unique index — so a
// re-run writes a second document rather than updating the first. 14,057
// documents are keyed by ObjectId; 855 ids have collided so far.
//
// The two copies are NOT interchangeable. The ObjectId-keyed one is narrower:
// 484 of the groups differ on `competitors`, `country`, `venue`, `source_ids`,
// `tournament_stage` and the odds timestamps, all present on the canonical copy
// and absent on the twin. So "keep either" would quietly drop the competitor
// list from 484 fixtures.
//
// The rule is therefore: keep the document that carries the most, break ties
// toward the one whose `_id` is the fixture_id, then toward the most recently
// written. A group where the survivor is NOT a superset of the loser is
// reported and skipped — that is a genuine conflict and wants a person.
//
// Usage:  node scripts/dedupe-fixtures.mjs            dry run
//         node scripts/dedupe-fixtures.mjs --apply

import { db, close } from './lib/entities.mjs';

const APPLY = process.argv.includes('--apply');

/* Where the two copies fill the same field with different values, merging has
   nothing to go on — so by default those groups are skipped. `--resolve` adds
   one rule and no more: the copy written later wins, field by field.
 *
 * That settles 116 of the 209, almost all of them a league rename caught
 * mid-flight — the same fixture_id under `icehockey_liiga` and
 * `icehockey_finland_sm_liiga`, the newer write naming the newer league.
 *
 * It cannot settle the other 93, where both copies carry the SAME
 * `updated_at` to the millisecond: two writes in one batch disagreeing about
 * kick-off time by an hour or about which category the fixture belongs to.
 * There is no "later" to prefer, and guessing a kick-off time is worse than
 * leaving a duplicate, so those stay for a person. */
const RESOLVE = process.argv.includes('--resolve');

/* Timestamps differ between copies for mechanical reasons and say nothing about
   which is better, so they are excluded when comparing content. */
const IGNORE = new Set(['_id', 'updated_at', 'created_at', 'settled_at']);

const empty = (v) =>
  v === null || v === undefined
  || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && !Object.keys(v).length);

/* Key order is not information. The two insert paths serialise `competitors`
   differently — one writes {name, side, id}, the other {id, abbr, name} — so a
   plain JSON compare called 484 identical lists a conflict. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const filled = (doc) =>
  Object.entries(doc).filter(([k, v]) => !IGNORE.has(k) && !empty(v)).length;

/**
 * Fold the copies into one document rather than choosing between them.
 *
 * They are complementary, not rival: the ObjectId-keyed copy carries the live
 * match state (`actual_start`, `in_play_data`) while the canonical one carries
 * the fuller static record (`competitors` with `abbr`, `source_ids`). Picking
 * either loses something real, so every field is taken from whichever copy
 * actually has it.
 *
 * Only a field both copies fill with genuinely different values is a conflict,
 * and those are reported rather than guessed at.
 */
function merge(docs) {
  const ranked = docs.slice().sort((a, b) =>
    filled(b) - filled(a)
    || (String(b._id) === b.fixture_id ? 1 : 0) - (String(a._id) === a.fixture_id ? 1 : 0)
    || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const [keep, ...drop] = ranked;

  const patch = {};
  const conflict = [];
  const resolved = [];
  for (const other of drop) {
    for (const [k, v] of Object.entries(other)) {
      if (IGNORE.has(k) || empty(v)) continue;
      const mine = patch[k] !== undefined ? patch[k] : keep[k];
      if (empty(mine)) { patch[k] = v; continue; }
      if (stable(mine) === stable(v)) continue;
      const newer = (other.updated_at ?? 0) > (keep.updated_at ?? 0);
      if (RESOLVE && newer) { patch[k] = v; resolved.push(k); continue; }
      if (RESOLVE && (keep.updated_at ?? 0) > (other.updated_at ?? 0)) continue;  // keep wins
      conflict.push(k);
    }
  }
  return { keep, drop, patch, conflict: [...new Set(conflict)], resolved: [...new Set(resolved)] };
}

async function main() {
  const d = await db();
  const F = d.collection('fixtures');

  const groups = await F.aggregate([
    { $group: { _id: '$fixture_id', n: { $sum: 1 }, docs: { $push: '$$ROOT' } } },
    { $match: { n: { $gt: 1 } } },
  ], { allowDiskUse: true }).toArray();

  console.log(`${APPLY ? '' : 'DRY RUN — nothing is written.\n'}${groups.length} fixture_ids on more than one document\n`);

  const toDelete = [];
  const patches = [];
  const conflicts = [];
  let enriched = 0, settled = 0;
  for (const g of groups) {
    const { keep, drop, patch, conflict, resolved } = merge(g.docs);
    if (resolved.length) settled++;
    if (conflict.length) { conflicts.push({ id: g._id, conflict }); continue; }
    if (Object.keys(patch).length) { patches.push({ _id: keep._id, patch }); enriched++; }
    toDelete.push(...drop.map((x) => x._id));
  }

  console.log(`  ${toDelete.length} documents would be removed`);
  console.log(`  ${enriched} survivors would gain fields from the copy being removed`);
  if (RESOLVE) console.log(`  ${settled} groups settled by taking the later write`);
  console.log(`  ${conflicts.length} groups skipped — both copies written at the same instant, so nothing to prefer`);

  if (conflicts.length) {
    console.log('\n  conflicts (first 10):');
    for (const c of conflicts.slice(0, 10)) {
      console.log(`    ${c.id}  disagree on: ${c.conflict.join(', ')}`);
    }
  }

  if (APPLY && patches.length) {
    for (const p of patches) await F.updateOne({ _id: p._id }, { $set: p.patch });
    console.log(`\n  enriched ${patches.length} survivors`);
  }

  if (APPLY && toDelete.length) {
    /* Deleted by _id in batches — never by fixture_id, which is the whole
       reason this collection has duplicates in the first place. */
    let done = 0;
    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = toDelete.slice(i, i + 500);
      const r = await F.deleteMany({ _id: { $in: batch } });
      done += r.deletedCount;
    }
    console.log(`\n  removed ${done}`);
    const left = await F.aggregate([
      { $group: { _id: '$fixture_id', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } }, { $count: 'n' },
    ], { allowDiskUse: true }).toArray();
    console.log(`  fixture_ids still duplicated: ${left[0]?.n ?? 0}`);
  }

  if (!APPLY) {
    console.log('\n  Re-run with --apply to remove them.');
    console.log('  Then add the index that stops this recurring:');
    console.log('    db.fixtures.createIndex({ fixture_id: 1 }, { unique: true })');
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(close);
