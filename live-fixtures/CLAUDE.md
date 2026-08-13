# live-fixtures

## Supabase: a new table needs a read policy, or it silently returns nothing

Supabase enables RLS on every new table. A table with **RLS on and no policy**
is default-deny: PostgREST authenticates fine, finds the table, applies an empty
policy set, and filters out every row.

Through the anon key that looks like this:

```
HTTP 200   content-range: */0   []
```

which is **byte-identical to a genuinely empty table**. The app cannot tell them
apart, so the sport/board/panel fed by that table just quietly disappears — no
error, no empty-state, nothing in the console. `golf_tournaments` and
`golf_outrights` were rebuilt without policies and golf vanished from the nav
entirely; it took a `pg_policies` check to find it.

So when a table is created or rebuilt, add the read policy at the same time:

```sql
create policy "anon read" on public.<table>
  for select to anon using (true);
```

Note what that grants: the anon key ships in the client bundle, so this makes
the table world-readable. That is already true of `live_fixtures`, so it is
consistent for this project's tables — but it is a public-read grant, and worth
a deliberate decision rather than a reflex.

### Telling the three cases apart

Probe with the anon key and read the status line, not the body:

| response | meaning |
| --- | --- |
| `200` + `content-range: */0` | table exists, readable, **no rows returned** — usually RLS with no policy |
| `206` + `content-range: 0-N/total` | working normally |
| `404` + `PGRST205 … not found in the schema cache` | table missing or not exposed to the Data API |

```sh
curl -sS -D- -o/dev/null \
  -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  -H "Prefer: count=exact" \
  "$VITE_SUPABASE_URL/rest/v1/<table>?select=*&limit=1"
```

A count from the SQL editor that disagrees with `*/0` here confirms RLS: the
owner sees rows, the anon role does not.

### Existing policies

```sql
select tablename, policyname, roles, cmd, qual
from pg_policies where schemaname = 'public';
```

Match a new table to what the working tables already use rather than inventing a
looser rule for it.
