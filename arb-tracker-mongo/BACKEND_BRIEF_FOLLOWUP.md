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
