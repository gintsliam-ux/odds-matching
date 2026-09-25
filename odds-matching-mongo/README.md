# Odds Library (Mongo)

The API behind the Odds Library — the page at odds-matching.vercel.app —
serving the **`gutsys_sport`** Mongo database on the NAS in place of Supabase.
Same page, same tables, same discrepancy scanner; a different database
underneath.

The page itself is **`../index.html`**, the file the Vercel `workspace` project
deploys. There is no copy of it here: this server mounts that one file, so the
thing you develop against is the thing that ships.

```
npm install
cp .env.example .env     # fill in MONGO_URI
npm start                # page + API on http://localhost:5180
```

In production the two halves split — the page is on Vercel, this API runs in a
container on the NAS next to Mongo, and `../vercel.json` rewrites `/api/*` to
it. See **DEPLOY_API_ON_NAS.md**.

`npm run dev` is the same thing under `--watch`. `LOG_REQUESTS=1` prints a line
per API call with its duration, which is what tells a slow query apart from the
page asking too often.

## Why there is a server at all

The Supabase build was a pure static page: the browser held the anon key and
talked to PostgREST directly. Mongo has no browser client and the connection
string is a credential, so that shape isn't available. This keeps the page as
one file and puts the database behind its own API.

That turned out to be the better split anyway. The competition list used to be
built by paging **every one of a sport's fixture rows** down the wire — 63,306
of them for soccer, 64 requests — and folding them in the browser. Mongo groups
where the data is: the same list is now one request returning 933 counted
rows in ~0.7s. `groupCompetitions` in the page still does the merging, it just
receives rows that already carry an `n`.

| | |
|---|---|
| `server/lib/mongo.mjs` | pooled client; every collection named in one place |
| `server/lib/queries.mjs` | the nine reads the page makes |
| `server/lib/cache.mjs` | TTL + stale-while-revalidate in front of the slow ones |
| `server/index.mjs` | routes, CORS, and `../index.html` + `../assets` mounted from the workspace root |
| `Dockerfile` / `docker-compose.yml` | the API plus its cloudflared sidecar, on :8788 |
| `scripts/` | the two logo resolvers, and the `entities` store they share |

## The API

Every route is a GET under `/api`, and every one answers with what the page's
own functions already wanted.

| route | feeds |
|---|---|
| `/api/date-range?sport=` | the period picker's span |
| `/api/leagues` | the optic_league → (category, tournament) directory |
| `/api/competitions?sport=&year=&month=` | counted (league, tournament, country) triples — the sidebar and the month's tournament picker |
| `/api/fixtures?sport=&year=&month=&league=&league=…` | a month's events, optionally scoped to a competition (`league` repeats for a merged one, `tournament` for a competition with no league id) |
| `/api/fixture?id=` | one fixture, so a deep link can find the month it lives in |
| `/api/search?q=` | event-name search |
| `/api/odds?fixture_id=` | `{source: 'closing' \| 'live' \| 'none', rows}` |
| `/api/competition-logos` | competition badges from `entities` |
| `/api/health` | connectivity and the fixture count (also plain `/health`, for the container) |

`/api/odds` prefers the closing record in `odds_sp` and falls back to the
live/pregame board in `odds`. Which of the board's two kinds of row to use stays
the page's call — a live price is not a pregame price and the two must never be
averaged into one cell — so both come back and it splits them.

## Two things the Mongo data made explicit

- **`scheduled_start` is a BSON date**, not the ISO string PostgREST returned.
  Month filters are real date ranges; the page still receives ISO strings,
  because that is what JSON does to a date.
- **`scores` has two shapes in the archive** — a plain `{home, away}` pair and a
  `{home: {total, periods}}` object from the sports that carry a period
  breakdown. The Supabase page read only the second, which showed no score at
  all for every fixture written in the first shape.

## The logo resolvers

`scripts/resolve-entity-logos.mjs` (team crests, player flags) and
`scripts/resolve-tournament-logos.mjs` (competition badges) write `entities`,
which is where the page's badges come from. They used to live at the workspace
root and write Supabase; they write Mongo now, and moved here because this is
where the driver and the connection string already are.

```sh
node scripts/resolve-tournament-logos.mjs --dry-run
node scripts/resolve-entity-logos.mjs --dry-run tennis golf
```

**Dry-run first.** `gutsys_sport` is the scrapers' database, and the entity
resolver opens with a sweep that replaces every stale player photo with a flag
— a pass that can touch thousands of rows before the `--limit` on new lookups
applies. `--dry-run` does every read and reports the same
inserted/updated/merged split without writing.

Three things are different from the Supabase version, beyond the transport:

- **`normalized` is written at insert time.** It is the only join key, both
  resolvers upserted on `(sport, name)` and never wrote it, and a whole backfill
  script existed to repair the rows they left invisible. Now they don't leave any.
- **A `(sport, normalized)` collision fills instead of failing.** "Real Madrid
  CF" and "Real Madrid" normalise to the same key; where one is already owned,
  the colliding row's logo or country is merged into the owner rather than
  fought over.
- **Golfers come from the outright market.** There is no `golf_outrights`
  collection here, so the field is read from `odds` + `odds_sp` where
  `market_id = 'outright'` — 586 names, against the 8 golf fixtures that carry
  no competitors at all.

live-fixtures runs its **own** resolver (`live-fixtures/scripts/resolve-logos.mjs`,
daily cron) against its own Supabase `entities`. That one is untouched: the two
tables are fed independently now, which is what it means for this page to be off
Supabase.

## One index worth adding

`fixtures` is indexed on `{sport, status, scheduled_start}`, so a month query
uses the `sport` prefix and then scans — an unscoped soccer month is ~4s, where
every league-scoped one is under 100ms. If the unscoped view is worth making
fast:

```js
db.fixtures.createIndex({ sport: 1, scheduled_start: 1 })
```

It is a write to a database the scrapers share, so it is left as a decision
rather than done here.

## Deployment

The page is on Vercel; this API runs in a container next to Mongo and is
published through a Cloudflare named tunnel, alongside the odds API that already
works that way. `../vercel.json` rewrites `/api/*` to the tunnel hostname, so
the page stays same-origin and needs no CORS and no build-time variable.
**DEPLOY.md** has the sequence.
