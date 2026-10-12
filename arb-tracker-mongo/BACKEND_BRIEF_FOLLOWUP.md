# odds-api — three follow-ups

7 Oct 2026. The in-play columns landed and work: 13 of 16 live fixtures carry a period,
the board shows `Q4 02:13` and `HT`, and the per-period breakdown populates. Nothing
below is a complaint about that change.

Ordered by what it costs us, not by effort.

---

## 1. `flucs=true` is doing two unrelated jobs, and it cost us a production bug

**It controls the price history AND whether unsettled fixtures appear at all.**

The ticker fetches up to 25 fixtures to fill its price-comparison columns and reads only
`current_price` — no ladder, no open, no close. So we dropped `flucs` from that call to
avoid paying for history we discard.

Every upcoming fixture then came back **empty**, which is most of the feed. Bets priced
fell from 96 of 150 to **50 of 150**, and the comparison columns simply rendered blank.
No error, no empty-result signal — just absent rows.

This is documented behaviour on your side and our own code says so two functions above
the one we edited:

> Upcoming fixtures only exist on this drain with `flucs=true`. Without it the ticker has
> no price to show for anything that has not already been played.

So this is our bug, not yours. The ask is that the surface stop making it possible:

**Either** an `include_unsettled=true` that works independently of `flucs`, **or** have
`flucs=false` stop excluding unsettled fixtures. We want "current prices for upcoming
fixtures, no history", which is currently unexpressible.

**Be aware the payoff is small.** Measured from our own phase timings, the per-fixture
drain costs about **1-2s for 24 fixtures with `flucs`, against 0.4-1.0s without** — so
roughly a second on a cold load, not the twenty we first assumed. Treat this as removing
a trap rather than a performance win. If it is awkward, leaving it alone is survivable
now that we know.

---

## 2. Two timestamps would complete the status bar

Our header carries a pulse per feed, showing **an age** — "Pinnacle 48s" — because the
question it answers is "is what I'm looking at current?". A dot with no number cannot
answer it.

Locally the bar has five dots. On the deployed build it has three, because two of them
need a timestamp the pivot does not carry:

| dot | needs | currently |
|---|---|---|
| **Optic** | the moment the fixture row itself was last written | no counterpart on the pivot |
| **Scores** | the moment a score last changed | no counterpart on the pivot |

The in-play columns gave us the **counts** both dots want, so this is only about the
timestamps. Two more fixture-level columns would do it:

- `fixture_updated_at` — when the fixture row was last written, however you track it
- `score_updated_at` — when `home_score`/`away_score` last changed

**Please do not derive either from price movement.** We deliberately left both dots out
rather than age them off the quoting heartbeat: a Scores dot that goes green whenever
prices move is worse than no Scores dot, because it reports healthy exactly when scores
have stopped arriving and prices have not.

---

## 3. Data quality: fixtures in play with a start time in the future

Not an odds-api bug — it is in the fixtures store too, so it is upstream of both — but
you are better placed to chase it.

Two tennis matches, both reported in play with set scores, both with a `scheduled_start`
**4.7 hours in the future**, and both carrying the identical nominal start time:

```
2026100678973FD3  status=live  start=2026-10-07T10:10:00Z  period=3  1-1
                  Francesco Maestrelli v Oliver Tarvet
20261006742BECB2  status=live  start=2026-10-07T10:10:00Z  period=1  1-0
                  Philip Henning v Maks Kasnikowski
```

Observed at 05:27Z, fixture rows updated 29s earlier — so this is live state, not a
stale record. Our guess is a "not before" slot time that is never replaced once the match
actually starts, which would make tennis start times unreliable rather than wrong. It
matters to us because the board sorts by time-to-start, so a match already in play sorts
as though it has not begun.

### A smaller one, probably just lag

A finished game keeps its last in-play snapshot for a while before going final. Golden
State v LA Lakers sat at `Q4 03:02, 122-84` for upwards of ten minutes after it ended,
then resolved correctly to `final, 124-98`. Since `is_live` does flip and the badge then
reads "Final", the only symptom is a frozen clock in the interim. Worth knowing; not
worth special-casing.

---

## What we changed on our side

- `fixtureFromPivot` reads all six in-play columns; `FIXTURE_COLS` declares them.
- `in_play_data` is null when nothing is in play, so "not in play" stays distinguishable
  from "in play, unknown".
- Period-score arrays map to the period breakdown. Index 0 = period 1, as specified.
- The clock is passed through unnormalised — `MM:SS` and soccer's bare minute count both
  render correctly, the latter with a prime.
- `flucs=true` is restored on the per-fixture drain with a comment explaining why it is
  not optional, so nobody removes it again.

---

## 4. The outright pivot cannot be assembled from `oc<n>_<book>_<field>`

Added 8 Oct 2026, after trying to put golf on the deployed board and backing it
out.

Golf has no head-to-head market — a tournament is a field — so `market=h2h`
removes the sport rather than thinning it, and the deployed board carries no
golf at all. Asking for `market=outright` instead fixes that part: the fixture,
the event page and the details panel all serve correctly.

The odds behind it do not. For `fixture_id`
`type_baycurrent_classic_2026_winner-sport_golf-league_pga` the surface
returned **five rows for a 106-player field**, every one carrying `outcome_no: 1`
and the same player, and the prices are not that player's:

```
                 surface says    odds store says
Ishizaka betmgm        23              751
         draftkings     21.5           1301
         fanduel        56             1001
         tab          1001              751
         fanatics      501              501   <- the only one that agrees
```

Prices that short belong to favourites, so runner names and prices have come
apart. We read a wide pivot as `oc<n>_<book>_<field>`, with the runner implied
by `n` — which describes a two-sided market and cannot describe a field of 106.

**What would help:** either the tall shape for outrights (one row per runner,
with the runner named on the row), or confirmation of which column carries the
runner name in the wide outright pivot so `n` can be resolved against it. We
have reverted to `h2h` everywhere until then; golf simply stays off the
deployed board, which is the safe failure.

---

## 5. The board cannot enumerate fixtures from `market=h2h` any more — 22% are invisible

Added 10 Oct 2026. This is the big one, and it supersedes item 4 (golf is one
symptom of it).

The deployed board derives its fixture list from `market=h2h`, because that is
the cheapest way to get one row per fixture — 0.5 MB a sport against 28 MB
unfiltered. The cost is that a fixture with no head-to-head price is invisible
to it. That was measured once at eleven fixtures. Today:

```
                local board   deployed board   missing
soccer               1563            1030        533
basketball            513             464         49
amfootball            148             126         22
rugbyunion             15               3         12
icehockey             383             377          6
volleyball             18              13          5
mma                    24              20          4
golf                    1               0          1
                    -----           -----       ----
                     2892            2260        632   (22%)
```

Those fixtures are NOT missing from the surface. Fetched by `fixture_id` they
return 58-161 rows each. They are missing a **full-match two-way moneyline**,
which is the only thing `market=h2h` selects on. Four distinct shapes:

```
no moneyline at all        asian_total, spread, total, 1h_spread, 1h_total
                           -> soccer (Premier League, Serie A, UCL), rugby union
only a PERIOD moneyline    1h_moneyline, spread, total, 1h_spread
                           -> basketball
only a 3-WAY moneyline     moneyline_3way                 -> ice hockey
no two-sided market        total_sets, set_spread, 1s_total -> volleyball
```

(Soccer's 1X2 is labelled `moneyline`, so soccer is unaffected by the 3-way
case; ice hockey carries `moneyline_3way` as a separate market and is.)

**What would help, in order of preference:**

1. **A fixtures endpoint.** A fixture list should not be a side effect of an
   odds market. Give us `fixture_id, sport, league, category, tournament,
   commence_time, home/away, scores, and the in-play columns you just added`,
   per sport and window, and the board stops guessing entirely. This also
   removes the golf problem and the outright-pivot problem in one go.
2. **Failing that: does `market` accept a list?** If `market=h2h,total` works,
   one drain covers every shape above and we will take the extra bytes.
3. **Failing that: a cheap enumeration market** — anything that returns exactly
   one row per fixture regardless of what is priced.

We have NOT worked around this by dropping the market filter: 28 MB a sport
across sixteen sports is not something the board can pay on a cold load.

---

## 6. A windowed query is truncated and reports `has_more: false` — this is the big one

Added 12 Oct 2026. This cost us every upcoming soccer fixture on the deployed
board for an unknown length of time, and it presents as an empty schedule
rather than as an error, which is why it went unnoticed.

**One `odds-api` query per (sport, date window) stops at roughly 1,240 rows and
about 4 MB, and then says there is nothing more.**

```
soccer, market=h2h, date_from=2026-10-10 date_to=2026-10-19
  limit=50000   1 page    1239 rows   has_more=false   latest start 10-11T18:15
  limit=4000    4 pages   1248 rows   has_more=false   latest start 10-11T18:15

soccer, market=h2h, date_from=2026-10-13 date_to=2026-10-20
                1 page     630 rows   has_more=false   ALL 630 upcoming
```

Nothing is missing on your side. The narrower window returns exactly the rows
the wider one dropped. But the response is ordered by start time, so what the
cap removes is always the **far end of the window** — which for a ten-day board
is its entire upcoming half.

The result on the deployed board: **1,205 soccer fixtures, not one of them yet
to start.** Rugby union and volleyball likewise. Two of the vanished fixtures,
fetched by `fixture_id` instead, returned 333 and 851 price rows — so the data
was always there and always reachable, just not that way.

### `next_offset` advances by the requested `limit`, not by the rows returned

This is the part that makes the cap unpageable, and it is a straightforward bug:

```
limit=4000:  page rows  404, 345, 438, 61
             next_offset 4000, 8000, 12000
```

Each step skips the ~3,600 rows between what arrived and what was asked for.
Honouring that offset loses more than ignoring it does, so we now send a `limit`
large enough that a span comes back in one page and the offset is never used.

**What would help, in order:**

1. **Make `has_more` honest.** If the response was capped, say so. We can page
   or narrow the window ourselves — but only if we are told. Silent truncation
   on a fixture-enumerating query is the worst possible failure mode.
2. **Fix `next_offset`** to advance by rows actually returned, which would make
   paging work and remove the need for (1) to be acted on urgently.
3. Tell us what the cap actually is (rows? bytes? both?) so we can size spans to
   it instead of probing for it.

### What we changed on our side

The window is split into 3-day spans up front and any span that still looks
truncated is split again — detected directly, by a span whose last fixture
starts a day or more before its own `date_to` on a response near the cap. That
took the board from 464 upcoming events to 1,988 and a cold build from 23s to
2.1s. It is a workaround for a surface that misreports completeness, and item 1
above would let us delete it.

### This also re-prices item 5

Item 5 asked for a fixtures endpoint on the strength of 22% of fixtures being
invisible. That number was measuring two faults at once. With the cap worked
around, **"has a price but the board cannot see it" fell to 9 fixtures.** What
remains is the genuine version of item 5: **766 upcoming fixtures with no odds
row anywhere** — 47 NHL (a whole Wednesday slate), 58 NCAAF, 31 Premier League,
26 NBA, 30 darts. Those cannot be reached by any odds query, and we now serve
them from our own mirrored copy of `fixtures` instead. A fixtures endpoint would
still be the right home for it, but it is no longer urgent.
