# competition_mapping backups

Point-in-time copies of rows deleted from Supabase `competition_mapping`, kept
because those deletions are not otherwise recoverable — PostgREST has no undo and
the table has no soft-delete.

## 2026-07-27 — cleanup of cross-league reuse (30 rows)

One book competition had been mapped to many unrelated OPTIC leagues, e.g.

- `Liga Profesional de Primera División` (Argentina) → 7 leagues incl. Morocco, Spain, Venezuela, Chile
- `SSE Airtricity League Premier Division` (Ireland) → 9 leagues incl. Australia, Belarus, Canada, Sierra Leone
- `Pepsi Max deildin` (Iceland) → Iceland 1st, 2nd, 3rd **and** Besta deild

All were `source='manual'`, which is sticky: `build-mapping` preserves those rows
and its `deleteAllAutoUnverified()` pass skips them, so the matcher could never
repair them. They got that way because the UI's auto-map button used to write
`source='manual'` for machine guesses — fixed since (it writes `'auto'`, which is
disposable).

| file | rows | what |
|---|---|---|
| `2026-07-27-competition-mapping-deleted-25.json` | 25 | the confident set — 4 exact duplicates + 21 country/tier mismatches |
| `2026-07-27-competition-mapping-deleted-05.json` | 5 | Iceland `1/2/3 deild` and the two NPL `u20`/`premier_league_1` variants |

After both passes: tier mismatches 0, cross-league reuse clusters 9 → 0.

## Restoring

Each object is a complete row as PostgREST returned it. To put one back, POST it
minus `id` and `resolved_at` (both are server-assigned):

```bash
jq 'map(del(.id, .resolved_at))' 2026-07-27-competition-mapping-deleted-25.json \
  > /tmp/restore.json

curl -X POST "$VITE_SUPABASE_URL/rest/v1/competition_mapping" \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $VITE_SUPABASE_ANON_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: resolution=merge-duplicates' \
  --data @/tmp/restore.json
```

Restoring re-creates the bad mappings, so filter to the specific rows you want
rather than replaying a whole file. Note that restored rows carry
`source='manual'` and would again be invisible to the matcher's country and tier
gates.
