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

## Paged reads need an ORDER BY, or the slice is not stable

PostgREST gives no ordering guarantee across `.range()` pages. Without an
explicit `ORDER BY` on a **unique** column, rows shift between requests, so a
paged read both repeats and DROPS records — silently, with no error.

This bit four reads in this app and four on the capture side on the same day.
It also manufactured a bug report: `fixtures` appeared to hold 2,681 duplicate
ids in a 45-day window. The same query ordered returns 13,943 rows and 13,943
distinct ids. `fixture_id` is the primary key and cannot repeat.

Ordering on a non-unique column is the same bug wearing a hat — `scheduled_start`
has dozens of fixtures sharing a kickoff time. Order on the key, or add it as a
tiebreak.

```ts
.order('fixture_id', { ascending: true })   // NOT scheduled_start alone
.range(from, from + PAGE - 1)
```

Any figure computed through an unordered pager is unreliable, including counts
that look plausible.

## Matching a team name must be scored BOTH ways

Deciding which side of a fixture a string names — a bet's outcome, a book's
selection — cannot be done by asking "does the team's name appear in the text".
That only measures one direction, and it cannot see a word the text has and the
team does not.

`Incheon United FC` shares `united` with `Loudoun United FC` and nothing checks
that `incheon` appears nowhere. It resolved as the away side of Rhode Island v
Loudoun United and the bet was graded against the wrong team. `Real Monarchs
SLC` resolved as `Real Salt Lake` the same way.

Three rules, all needed:

1. **Score both directions**, weaker one governing — team-words-in-text AND
   text-words-in-team.
2. **Exclude club-type words**: united, city, real, athletic, atletico,
   deportivo, sporting, racing, county, town, rovers, club, sport, football.
   These identify the *type* of club, not the club.
3. **Whole-word matching.** `includes('city')` finds "Cityscape".

Require a strict winner and return null otherwise. Ungraded is safe; confidently
wrong is not. Measured over 342,600 name × fixture pairs, this took wrong-team
resolutions from 0.44% to 0.091% while still grading the fixture's own teams on
291 of 300.

## Read every rendered field before retiring a table

Check what the UI actually renders out of a table before dropping it, not just
what something obviously depends on. `live_fixtures.period_scores` held the only
copy of the per-set breakdown — the data needed to grade tennis game and point
markets — and `fixtures.scores` did not have it. It was found by auditing what
the board displayed, hours before the table was due to be dropped.
