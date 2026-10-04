# Sports Odds Desk

An odds, bets and mapping desk over the **`gutsys_sport`** Mongo database on the
NAS. It began as a port of the Arb Tracker board off Supabase and has since
grown past it: the price grid, a per-fixture Bets tab across three brands, a
Details tab showing how every system sees the same event, and a tournament
mapping page.

The directory is still `arb-tracker-mongo` — only the product name changed, so
paths and git history are untouched.

```
npm install
cp .env.example .env     # fill in MONGO_URI
npm run dev              # API on :5174, app on :5173
```

The API is started under `scripts/dev-api.sh`, which respawns it if it exits.
It has been seen exiting cleanly — code 0, empty log, Mongo reachable — after
running fine for a while, and never reproducibly. With `concurrently -k` that
one quiet exit took the whole dev server down with it. A server that comes back
in a second is a non-event; one that stays down is an outage. A deliberate
Ctrl-C still stops everything, and five failures inside 30s gives up rather than
spinning.

`npm run dev` runs both halves; Vite proxies `/api` to the API, so the browser
only ever sees one origin. For a production-ish run: `npm run build && npm start`
(the API then serves `dist/` too, on `:5174`).

## Why there is a server at all

The Supabase build was a pure SPA: the browser held a Postgres client and talked
to the database directly. Mongo has no browser client and the connection string
is a credential, so that shape isn't available. This app keeps the same React
front end and puts the database behind its own API.

That turned out to be the better split anyway. The server does the work that was
previously shipped to every tab:

| | |
|---|---|
| `server/lib/mongo.mjs` | pooled client; every collection named in one place |
| `server/lib/events.mjs` | fixture documents → the board's `SportEvent` shape |
| `server/lib/queries.mjs` | the board, day browsing, search, odds, H2H |
| `server/lib/pulse.mjs` | feed-freshness heartbeats |
| `server/lib/cache.mjs` | TTL + stale-while-revalidate in front of the slow reads |
| `server/index.mjs` | routes, static serving, and the background cache warmer |
| `src/lib/db.ts` | thin `fetch` wrappers — the same exported surface the components always called |

Nothing above `src/lib/db.ts` changed. `markets.ts` and every component are the
originals.

## The event page

Under the scoreboard, three tabs — **Markets**, **Bets**, **Details** — each with
their own second row.

**Markets** buckets into *All / Moneyline / Handicap / Totals / Specials /
Outright*. The buckets are derived from each market definition's `kind` rather
than a second list to keep in sync, so a new market lands in the right pill on
its own, half- and quarter-variants ride with their parent (a 1st-half line is
still a handicap), and a bucket only appears when the event actually prices it —
golf shows *All* and *Outright* and nothing else.

**Bets** shows what was actually staked on the fixture, per brand — see below.

Selecting an event resets the tabs to Markets, so every event opens the same
way. That reset happens during render rather than in an effect — React's own
idiom for resetting state on a prop change — so a new event never paints for a
frame under the previous one's tab.

**Details** also carries a **Mapping** block: how Swiftbet and Mybet see this
same fixture — their event id, competition and competition id, every timestamp
each keeps, and each one's notion of status. They disagree often enough that the
disagreement is the useful part; a bet that won't match or a price that looks
stale usually traces to one of the three rows saying something different, so
provider start times are shown against Optic's with the drift called out (`+1m`)
rather than left to be worked out by hand. Swiftbet has a real status
(`inprogress` / `finished`); Mybet has no status at all, only a trail of
first-seen / last-seen / suspend timestamps, which is why the two read
differently. The league-level mapping is repeated at the bottom of each, since
an unmapped *league* is the usual reason an event never mapped.

**Details** is the fixture behind the board — venue, season, competitors and
their feed ids, the full timestamp trail — plus a summary of what we hold in
`odds` for it (row count, books, markets, first and last price seen). Loaded
lazily from `/api/event/details`: 1800 board events do not each need to carry a
venue string.

## Which price the grid shows

Once a market has closed, the grid shows its **closing** price — a started game
reads as it finished, not as whatever was last polled.

The gate is `closed_at`, not `close_price`, and that distinction is load
bearing. Where the settler has stamped a close the two agree (69,905 of 69,925
rows sampled over 48h), so preferring the close is exact. Where it has *not* —
~10k rows, concentrated in the exchange feeds — `close_price` is still a copy of
`open_price` in 70% of cases while `current_price` holds the genuine last price.
Reading `close_price` unconditionally would quietly rewind those rows to their
opening price. So: close when it was really stamped, latest price otherwise.

## Mapping page

`/mapping`, linked from the bottom of the rail. One row per optic league with
**both** providers as columns — Swiftbet and Mybet side by side — so the two can
be compared and corrected together rather than a tab at a time.

**Sport is the top-level filter**, not provider. It is the coarsest useful cut
and the one that makes a 415-row table feel finite; the buckets below it
(ready / needs a look / no candidate / mapped) then count across *both*
providers, since a league with a ready Swiftbet suggestion is work to do
whatever its Mybet side happens to be. Header carries per-provider coverage
bars, which is the one number that says how much of this job is left.

Every cell can be **edited**: a searchable picker over that provider's
competitions, reachable from all three states — replacing a mapping, overriding
a suggestion, or placing a league the matcher found nothing for — so no row is a
dead end. The list is **scoped to the league's sport** (19 cricket competitions
rather than all 369, with a toggle to widen), and competitions already mapped to
another league sort last behind a `taken` badge: picking one would quietly leave
two leagues pointing at the same place. A hand-picked competition is recorded at
full confidence — it was stated, not inferred.

mybet's league list does carry a sport of its own ("Gridiron", "Australian
Rules"), which the synonym table folds; that both scopes the picker and lets the
sport gate apply to mybet candidates during matching.

The three feeds spell the same competition differently — `NPB` /
`Nippon Professional Baseball` / `Japanese NPB` — so candidates are proposed by
name and then **corroborated against the squads each competition actually
fields**. That second step is what makes it usable rather than plausible. On
names alone the matcher confidently produced `England/FA Cup -> Chinese FA Cup`,
`Spain/La Liga -> LaLiga SmartBank`, and Italy, Brazil and Ecuador's Serie A all
onto one candidate. Squad overlap settles every one of those: only one Serie A
fields Juventus.

The name scorer (`mappingMatch.mjs`) handles acronyms by segmentation — each
word contributes its initial or the whole of itself, so `NCAAF` reads as
NCAA+Football but `NBA` cannot be read out of NCAA Baseball — and refuses a
match outright when the two sides name different countries, name different
sports, or disagree on a discriminating word (women's, youth, qualification).
Names made only of sport and container words ("Basketball League", "Cup") match
nothing but themselves.

**Apply covers both providers.** A league's Swiftbet and Mybet counterparts are
two separate facts, so the bulk button applies every ready suggestion across the
table at once — labelled with the split ("Apply 75 ready (40 Swiftbet · 35
Mybet)") — rather than making you switch the filter and press it twice. It goes
out as one `bulkWrite` of upserts, so the batch lands or doesn't instead of
leaving the table half-applied, and is capped at 500 rows per request.

**Tennis looks wrong and mostly isn't.** An optic "league" like
`tennis_atp_challenger` is a *tour*: one league key covering 19,037 fixtures
across 33 separate tournaments, while providers file each week's Challenger as
its own competition. Many-to-one is the correct shape there, not a matching
error. Two things did make it look worse than it is, both now fixed: the row was
labelled with one arbitrary event from the tour ("Sion, Switzerland" for the
whole ATP Challenger circuit — it now reads the category plus a tournament
count), and `competition_mapping` stores the same competition repeatedly (71
groups repeat 2-4x, 81 redundant rows), so mybet's 87 ATP Challenger rows are
really **41 distinct competitions**. Duplicates are collapsed for display and
flagged with a `2× duplicated` badge rather than silently hidden.

**A league maps to MANY competitions, not one.** `competition_mapping` is
one-to-many and always was: `tennis_atp_challenger` holds 87 mybet tournaments
(each week's Challenger is its own competition) and 67 Swiftbet ones, and mybet
carries both "UFC" and "UFC - Women" against the same MMA league. So applying
**adds** a row — the upsert is keyed on (provider, league, competition), not on
(provider, league), which would have silently rewritten one arbitrary row of the
87. Removing takes out just the one you clicked. Cells lead with three entries
and open on demand.

**Nothing is written without a click.** Suggestions are bucketed into *ready to
apply* (high score, uncontested), *needs a look*, and *no candidate*; a
suggestion two leagues both claim is marked contested and demoted, because at
most one can be right and the matcher cannot tell which. Applying writes an
upsert to `competition_mapping` marked `source: manual, verified: true`, and
each row can be unmapped again from the same cell.

## Bets

The bets live on a **different cluster** from the odds (Atlas, not the NAS), set
by `BETS_URI`. Leave it unset and the tab says so; nothing else is affected.

The bridge between the two worlds is `gutsys_sport.event_mapping`, one row per
(optic fixture, provider):

| brand | collection | join |
|---|---|---|
| Swiftbet | `gutsy.bets` | provider `swift` → UUID → `derived.legs_event_ids` |
| Mybet | `gutsy.multi_bets` | provider `mybet` → numeric id → `event_identifier` |
| Multis | `gutsy.multi_bets` | the same id, split on `transaction_licenseid` |

Mybet and Multis are one collection separated by licence (`MyBet` /
`MultisComAu`). About 24% of board fixtures carry a swift mapping and 13% a
mybet one, so a fixture legitimately having bets under one brand and none under
another is normal — the panel distinguishes *not mapped* from *nobody bet*,
because they look identical otherwise and mean opposite things.

**The index.** `multi_bets` originally had no index on `event_identifier`, so
the lookup was a 46-second scan of 5.7M documents. It now carries

```js
{ event_identifier: 1, transaction_date: -1 }   // 66 MB, built in 55s
```

which answers the lookup *and* the sort from one index — **28ms**, 11 keys
examined to return 11 rows, no in-memory sort. Because of it the query needs no
date bound, so a bet placed months early is found like any other; only the 2023
floor applies. (Reuse of `event_identifier` across seasons would have made an
unbounded query unsafe — it doesn't happen: the median bet-date span per id is
0.0 days and the p99 is 1.9.) `gutsy.bets` never needed this — its
`derived.legs_event_ids` was already indexed and answers in 24ms.

**Why P/L is often blank.** `pl` cannot be trusted until a bet is settled. On a
finished NFL game the feed carried `pl = -24.03` against a leg still marked
Unresulted, and `pl = 0` against both a Won and a Lost bet — the settlement pass
simply had not run. Totalling that column produces a confident wrong number
(-$6,252 where the truth was -$195 across the 7 settled bets), so unresolved
bets report no P/L and the header says how many are settled. The result itself
comes from the feed's own `derived.legs_breakdown[].result`, not
`enrichment.result`, which is this app's stamp and absent on ~96% of rows.

## Crests that vanish on a dark ground

Club crests arrive from Wikipedia as drawn, and some are entirely near-black —
the NZ Breakers wordmark and the Detroit Tigers "D" load perfectly and then
render as an invisible smudge. `logoContrast.ts` measures each one and gives
those a light tile.

The test is the **brightest** pixel, not the average. Average gets it wrong both
ways: Brisbane Bullets averages a middling 0.51 but carries white highlights
(max 1.00) that read clearly, while the Breakers average 0.11 with a maximum of
0.11 — nothing in the artwork could show against a dark ground whatever the mean
says. Measured once per URL and cached for the page, since a board repeats the
same crest across dozens of rows. About 6% of crests get a tile.

## Book aliases

`odds.sportsbook` carries two spellings for the same book —
`betfair_exchange_australia` beside `betfair`, `ladbrokes_australia` beside
`ladbrokes`. The UI's columns key on the canonical id, so an alias-keyed row
matched no column and its price silently vanished; on a live tennis fixture that
emptied the whole Betfair Back column. `foldBookAliases` maps them back using the
`books` table's own `aliases`, comparing loosely because that table has at least
one typo (`ladbrokes_australia_`) that would never match a real row. Where both
spellings carry the same selection, the freshest row wins.

## Two things this database does differently

**`has_odds` is a live flag, not a history flag.** It's cleared once an event
settles. A fixture from a week ago reads `has_odds: false` while still holding
769 odds rows. Filtering on it — as the Supabase build did — costs the board
~570 recently-finished events and makes past-date browsing come back *completely
empty*. So odds-presence is derived from the `odds` collection instead
(`keepPriceable` in `queries.mjs`). Board: 1314 → 1828 events. A past day: 0 →
332.

**`scores` comes in two shapes.** The Optic feed writes
`{home: {total, periods}}`; archived fixtures carry a flat `{home: 1, away: 1}`.
`sideScore()` reads both.

## Query shapes that matter

`odds` holds 6.6M rows and is indexed on `fixture_id` — not on `sportsbook` or
`selection`. Three queries had to be written around that, and the difference is
not marginal:

- **Search over outright selections** — a bare regex on `odds.selection` is a
  **43s** collection scan. Scoped to golf's fixture ids first (outright markets
  only ever hang off golf), it's **0.4s**.
- **Feed freshness per book** — "newest `updated_at` for TAB" is a **54s** scan.
  Scoped to the fixtures about to jump, it's a few seconds — and is a better
  answer to the question anyway: *are the feeds moving on the games we're
  pricing right now.*
- **Crest + flag joins** — an `$or` of 500 `{sport, normalized}` pairs stops
  being one index range and becomes 500 of them (**10s**). One `$in` over both
  fields is **0.8s** for the same result.

The board and the pulse sit behind a 45s cache with stale-while-revalidate, and
the server refreshes both on a 30s timer from the moment it boots. That matters
because the NAS is shared with the scrapers: a cold board query is anywhere from
5 to 35 seconds depending on what else is running, while a warm one is ~10ms.
Warming it in the background moves that cost off the request path instead of
landing it on whoever opens the page first — and costs the database nothing
extra, since every tab already shares the one cached result.

### Do you need extra indexes?

No. The three that exist on `odds` cover every query this app makes, and the one
read that looks expensive isn't:

```
distinct('fixture_id', { fixture_id: { $in: [3003 ids] } })
  stage: PROJECTION_COVERED <- DISTINCT_SCAN
  docs examined: 0     keys examined: 196     415ms
```

That's the odds-presence check from `keepPriceable`, and it never touches a
document — `DISTINCT_SCAN` walks straight between distinct index keys. Writing
the same thing as a `find` + dedupe in application code takes **12 seconds** for
the identical answer, so the shape of that call matters much more than any index
would; leave it as `distinct`.

The cold-board variance (5-35s) is the NAS being busy with the scrapers, not a
query plan. That's what the background warmer is for, and it's why an index
wouldn't have helped.

The one index that *would* buy something is `{sportsbook: 1, updated_at: -1}`,
for the unscoped "newest write per book" that the Supabase build asked. But the
pulse deliberately no longer asks that question — scoped to imminent fixtures is
both fast on the current indexes and a more useful answer. Not worth the write
overhead on a 6.6M-row collection the scrapers are constantly appending to.

## Deploying

Two ways to run this, and the difference is which database is reachable.

**On the tailnet** (laptop, or `nas01` itself) — `MONGO_URI` set, reads
`gutsys_sport` directly, every feature works.

**Deployed** (Vercel) — `gutsys_sport` is a Tailscale address that public
infrastructure cannot route to, so the board reads the tunnelled
`sport.gutsysapi.com` surface instead: set `SPORT_API_URL` / `SPORT_API_KEY` and
leave `MONGO_URI` unset. `server/lib/source.mjs` picks the source, the route
table in `server/lib/routes.mjs` is shared by both hosts (`server/index.mjs`
locally, `api/[...path].mjs` on Vercel) so they cannot drift, and `/api/capabilities`
tells the client what to hide.

### What a deployed build cannot show

The surface publishes prices, not the join tables, and no per-price history:

| | deployed |
|---|---|
| Board, market grid, ladders, 10 books | ✅ |
| Fair blend, vig, opening prices | ✅ (more than the Mongo path shows) |
| Price hover card — opening price, 6h→10m snapshots | ✅ via `flucs=true` |
| Suspended prices struck through | ✅ via `flucs=true` (`_status`) |
| Hover-card sparkline (point-by-point series) | ❌ no series upstream |
| 9am `daily_prices` series | ❌ not published |
| Team crests and flags | ❌ `entities` not published |
| Bets tab / Details mapping / Mapping page | ❌ join tables not published |
| **Upcoming fixtures** | ❌ see below |

**Live and upcoming come from two different queries, and both are needed.**

`/odds-api` defaults to *closing* prices — one row per market for a fixture
whose book has closed. Two things follow, and missing either empties the board
of everything happening now:

- **Upcoming** fixtures are only returned when the query is explicitly
  forward-dated. `date_from`/`date_to` spanning today and tomorrow returns them;
  the unbounded default does not.
- **In-play** fixtures are a *separate source*, not a flag. A game still running
  has no closing price, so it is absent from the closing pivot entirely — asking
  `live=true` and merging those rows in as fixtures of their own is the only way
  they appear. Flagging rows already present finds nothing, because there is
  nothing to flag. **Both the fixture list and the per-fixture odds have to do
  this**: doing it in only one place lists a live game on the board and then
  tells you "No odds available" when you open it.

**`include_stale=true` is required for a complete market**, and it is passed per
call rather than globally. Without it the surface emits only rows a book is
actively quoting — which in play is a fraction of the truth: on an 8-2 blowout
every price on the leading side was suspended, so the whole outcome vanished and
the moneyline rendered one-sided. With it, 12 of 12 live prices come through and
match `gutsys_sport.odds` to the decimal.

A just-finished match sits in a gap between the two sources: it has no active
price left, and is not yet settled into `odds_sp`. It therefore appears in
neither the liveness probe nor the closing list, and dropped off the board
entirely — "Event not found" — for the hour or so between the final whistle and
settlement. The fixture list is built from **stale live rows plus closing**, which
covers it; the `isLive` flag still comes from the active-only probe.

The one question `include_stale` must NOT be asked is *what is live*: a stale live row
outlives the game it belongs to, so including them in the liveness probe
reported finished matches as in play and took the board from 11 live to 554.
Liveness comes from actively-quoted prices; completeness comes from
`include_stale`. They are different questions.

`fixture_id` works too (with `sport`, which the surface requires), so an event
page fetches 89 rows for one match instead of draining 1,130 for the sport.

**`flucs=true` carries a price's whole life**, per outcome per book: `_open`,
`_6h`, `_3h`, `_1h`, `_30m`, `_10m`, `_close`, `_current`, `_at` and `_status`.
Checked against `gutsys_sport.odds`, 54 of 54 fields match exactly across all
ten books — so the deployed hover card shows the same snapshot ladder as the
local one, and suspended prices are struck through again. It costs enough to be
worth asking for only on an event page; the board stays on the cheap shape.

Despite the name it is not a point-by-point series — there is no `flucs` array
anywhere in the surface — so the hover card's sparkline stays empty. `priceSeries`
is the capability flag for that.

`API_SPORTS` is copied verbatim from the surface's own 400 message. An invalid
sport (`handball` was one) rejects, and with the pivot cache handing the same
promise to callers that may never await it, that rejection escaped as an
unhandled rejection and killed the process on startup. The cache now absorbs its
own failures; the error still reaches whoever actually awaited.

**Which pivot wins is decided by trading status, not by which pivot it is.**
A live row wins only while its book is still quoting it (`status: active`).
Once a match ends those rows freeze at the last in-play price — pinnacle at
1.021 on a dead market — and carry no snapshot ladder. Letting the live pivot
win unconditionally therefore showed stale in-play numbers *and* no history, for
exactly the six books the live feed covers, while the four it does not were
correct. Closing wins once nothing is trading; live wins while it is.

**Scores cannot be used to infer that a match was played.** The pivot carries
`home_score`/`away_score` on every row, including fixtures yet to kick off —
"Club Libertad 0-1" for a 22:00 start. Treating a present score as evidence
marked the entire board `final` and painted phantom scorelines on tomorrow's
games. Start time decides; the live feed decides what is in play.

### Keeping it fast

Three things, measured:

- **Ask for one market, not all of them.** The board needs a row per fixture
  and the head-to-head price the ticker shows — `market=h2h` gives exactly that
  for **0.5 MB across seven sports against 28 MB unfiltered**, and five times
  faster. It misses the eleven fixtures (1.8%) that carry no head-to-head market
  at all; those could not have shown a ticker price anyway, and opening one by
  link still loads every market because the event page fetches by `fixture_id`
  without the filter.
- **Ask which sports exist.** `action=list_sports` is authoritative. Hardcoding
  that list is how `handball` — which this feed does not carry — reached a
  request, was rejected, and took the process down.
- **Bound the upstream query.** `/odds-api` accepts `date_from` / `date_to`;
  without them the adapter pulled a full week for fourteen sports and threw most
  of it away — 37.9s for a cold board. Windowed to the two days the board shows,
  all fourteen come back in 2.9s.
- **One page, not twelve.** `limit=50000` returns every windowed sport whole
  (`has_more: false`), so `drain` almost never loops. The loop stays for the
  weekend that proves the exception.
- **Never cache an empty answer.** An empty board is far more likely to be a
  blip upstream than a day with no sport on it, and `s-maxage=300` turned one
  failed fetch into five minutes of "No events match these filters" for
  everybody. Empty and error responses are `no-store`.
- **Don't swallow per-sport failures.** `allEvents` fans out over fourteen
  sports; each one used to fail silently to `[]`, which is how a total outage
  presented as a plausible empty schedule. Failures are logged, and every sport
  failing throws rather than returning a cacheable nothing.
- **Keep the upstream timeout inside the function's budget.** It was 120s
  against a 60s `maxDuration` — the wrong way round, so one slow sport held the
  whole board until the platform killed it. Now 20s with a single retry, and
  only for 5xx/transport errors: a 400 for a bad sport will not improve.
- **Let the CDN do the caching.** Functions are ephemeral, so the in-process
  cache rarely survives an invocation; `s-maxage=300, stale-while-revalidate=3600`
  is what actually keeps it quick. Closing prices for finished matches change
  slowly, so a board that is a minute stale costs nothing against making every
  visitor wait on a cold drain.

Net: cold 37.9s → **1.8s**, cached 0.17s.

The board's `/api/h2h` is a **GET** for that reason too. It began as a POST of
fixture ids, which the CDN cannot cache and which Vercel's deployment protection
refuses outright (`status=000`) — so the deployed ticker had no prices at all.
The server already knows what is on the board, so no ids need sending.

One trap worth knowing: the adapter derives status from scores and start time.
Before it did, every fixture read `upcoming`, and the ticker — which keeps every
non-final event and re-sorts on each clock tick — tried to render 2,243 of them
every second and locked the page. Correct status is load-bearing, not cosmetic.

## Reachability

`MONGO_URI` points at a **Tailscale** address (`100.64.0.0/10`). It resolves
from a machine on the tailnet and nowhere else — so this runs locally, or on a
host that's on the tailnet. A Vercel deployment could serve the front end but its
functions could not reach the database.

## Tables

Wired: `fixtures`, `odds`, `entities`, and — via `/api/meta` — `books`,
`leagues`, `market_rules`.

Present and named in `COLLECTIONS` but not yet surfaced: `odds_sp` (settled
fairs / blend), `event_mapping`, `competition_mapping`, `tab_competitions`,
`blend_config`. Adding one is a query in `queries.mjs` and a line in `ROUTES`.
