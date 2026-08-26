// Delete event_mapping rows whose fixture no longer exists.
//
// Orphans accrue whenever fixtures are deleted and nothing prunes them: 20,997
// had built up by 2026-08-25 (39% of the table), and deleting one batch of
// youth fixtures added 776 within the hour. Left alone the table drifts back
// toward a third of its rows pointing at nothing, and every coverage figure
// computed against it reads low.
//
// Runs from the DAILY cron, not the ~10-min tick: it needs the FULL fixture id
// set (~97k rows, ~97 paged requests). The matchers deliberately load a
// windowed set — source=optic, last 45 days — and pruning against that would
// call every out-of-window fixture an orphan and delete a working mapping.

const REST = `${process.env.VITE_SUPABASE_URL}/rest/v1`
const H = {
  apikey: process.env.VITE_SUPABASE_ANON_KEY,
  Authorization: `Bearer ${process.env.VITE_SUPABASE_ANON_KEY}`,
}

/** A read that loses rows would look exactly like a pile of orphans, so this
 *  refuses to delete unless the fixture read returned a plausible table. */
const MIN_FIXTURES = 10_000
/** A single run should never remove more than this share of the table. Beyond
 *  it, something is wrong with the read rather than the data. */
const MAX_DELETE_FRACTION = 0.25

async function pageAll(path, orderCol) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${REST}/${path}&order=${orderCol}.asc`, {
      headers: { ...H, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    })
    if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 160)}`)
    const rows = await r.json()
    if (!Array.isArray(rows) || rows.length === 0) break
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

export async function pruneOrphanMappings({ log = () => {}, apply = true } = {}) {
  // Ordered by the primary key — an unordered paged read is not a stable slice,
  // and here that would mean deleting mappings whose fixture the read dropped.
  const fixtures = await pageAll('fixtures?select=fixture_id', 'fixture_id')
  if (fixtures.length < MIN_FIXTURES) {
    log(`  fixtures read returned only ${fixtures.length} rows — refusing to prune.`)
    return { deleted: 0, skipped: true }
  }
  const live = new Set(fixtures.map((r) => r.fixture_id))

  const mappings = await pageAll('event_mapping?select=id,optic_fixture_id,source', 'id')
  // Manual rows are never pruned: someone made them deliberately, and a fixture
  // vanishing is not evidence the pairing was wrong.
  const orphans = mappings.filter((r) => !live.has(r.optic_fixture_id) && r.source !== 'manual')

  const fraction = orphans.length / Math.max(mappings.length, 1)
  if (fraction > MAX_DELETE_FRACTION) {
    log(`  ${orphans.length} of ${mappings.length} look orphaned (${(fraction * 100).toFixed(0)}%) — above the ${MAX_DELETE_FRACTION * 100}% ceiling, refusing.`)
    return { deleted: 0, skipped: true }
  }
  if (!orphans.length || !apply) {
    log(`  ${orphans.length} orphaned event_mapping rows${apply ? '' : ' (dry run)'}.`)
    return { deleted: 0, orphans: orphans.length }
  }

  let deleted = 0
  for (let i = 0; i < orphans.length; i += 200) {
    const ids = orphans.slice(i, i + 200).map((r) => r.id)
    const r = await fetch(`${REST}/event_mapping?id=in.(${ids.join(',')})`, {
      method: 'DELETE',
      headers: { ...H, Prefer: 'return=minimal' },
    })
    if (r.ok) deleted += ids.length
  }
  // Report what the database confirms, not what was attempted.
  const after = await pageAll('event_mapping?select=id', 'id')
  log(`  pruned ${deleted} orphaned mappings; ${after.length} rows remain.`)
  return { deleted, remaining: after.length }
}
