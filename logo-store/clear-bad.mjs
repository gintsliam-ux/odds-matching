// Blanks the logo link on records the audit found dead or wrong, keeping the
// old link in logo_url_prev. Only touches a record whose link is still the one
// that was audited.   node --env-file=<env with MONGO_URI> clear-bad.mjs [--apply]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const { MongoClient } = createRequire(process.env.MONGODB_FROM ?? import.meta.url)('mongodb');
const APPLY = process.argv.includes('--apply');
const cl = JSON.parse(readFileSync('work/classified.json', 'utf8'));
const dead = new Set(JSON.parse(readFileSync('work/dead.json', 'utf8')).map((r) => r._id));
const targets = [];
for (const r of cl) {
  const why = dead.has(r._id) ? 'dead link' : r.cls.startsWith('wrong') ? r.cls.replace('wrong: ', '') : null;
  if (why) targets.push({ _id: r._id, sport: r.sport, name: r.name, was: r.logo_url, why });
}
const tally = {}; for (const t of targets) tally[t.why] = (tally[t.why] ?? 0) + 1;
console.log(targets.length, 'records', tally);
writeFileSync('work/cleared.json', JSON.stringify(targets, null, 1));
if (!APPLY) { console.log('dry run — pass --apply to write'); process.exit(0); }
const c = new MongoClient(process.env.MONGO_URI, { appName: 'oddslib:logo-clear' }); await c.connect();
const col = c.db('gutsys_sport').collection('entities');
const at = new Date(); let n = 0;
for (let i = 0; i < targets.length; i += 200) {
  const r = await col.bulkWrite(targets.slice(i, i + 200).map((t) => ({ updateOne: {
    filter: { _id: t._id, logo_url: t.was },
    update: { $set: { logo_url: null, source: null, logo_url_prev: t.was, logo_cleared: { at, why: t.why } } },
  } })), { ordered: false });
  n += r.modifiedCount;
}
console.log('cleared', n);
await c.close();
