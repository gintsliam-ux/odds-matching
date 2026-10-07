# odds-api — please add the in-play fields to the fixture columns

7 Oct 2026. Checked against the live store: 168,035 fixtures, 29 of them in play at
03:28 UTC while this was written.

## The problem

The deployed site cannot say where a live game is up to. It shows **"LIVE"** where the
local build shows **"Q4"** or **"Q4 02:13"**, because the deployed build has only
`odds-api` to read and that pivot carries no in-play columns.

Live example, Utah Jazz v Denver Nuggets, `20261007BEB8BDE8`:

```
deployed (from odds-api)   period: null   clock: null   periodScores: []     -> badge "LIVE"
the fixtures store         period: 4      clock: null   periods 31/28/22/25  -> badge "Q4"
```

The scoreline is already right in both — `home_score` / `away_score` are on the pivot
and read 106-117. It is only *where in the game* that is missing.

## Why this is an odds-api change and not ours

`odds-api` is the only fixture surface a deployed instance has. There is no `fixtures`
collection in Atlas — 148 MB of constantly-changing rows is not worth mirroring to serve
one lookup — so the deployed build reconstructs each fixture from the pivot's
fixture-level columns, of which there are currently 17:

```
optic_fixture_id  date  commence_time  sport_key  optic_league  category  tournament
location  home_team  away_team  event_name  home_score  away_score
sports_market_type  market_display_name  line  pair_key
```

`home_score` and `away_score` are already fixture-level facts repeated on every row of a
fixture, so the five fields below are the same kind of column, carried the same way. No
new endpoint needed.

## What to add

Four scalars, named as the fixtures store already names them so nothing needs
translating. If you would rather namespace them `in_play_period` etc., that is fine and
we will map it — only say which.

| column | type | example | why we need it |
|---|---|---|---|
| `period_number` | int \| null | `4` | The period itself. Without it the badge can only say "LIVE". This is the one that matters most. |
| `period` | string \| null | `"4"`, `"1H"`, `"HALF"`, `"END-REG"` | The feed's own label. `"HALF"` is how a soccer match at the break arrives, which `period_number` alone cannot express. |
| `clock` | string \| null | `"02:13"`, `"0:19"`, `"30"` | The time on the clock. Format varies by sport and that is fine — we handle both `MM:SS` and soccer's bare minute count. Send it exactly as the source gives it; do not normalise. |
| `is_clock_stopped` | bool \| null | `true` | Distinguishes a break from a stoppage. A stopped clock with no value is halftime; a stopped clock that still has a value is a timeout and keeps its time. We label the first "HT" and that is the only thing telling them apart. |

Plus the per-period scores, which drive the quarter-by-quarter breakdown under the
scoreline (currently always empty on the deployed build):

| column | type | example |
|---|---|---|
| `home_period_scores` | int[] \| null | `[17, 14, 10, 14]` |
| `away_period_scores` | int[] \| null | `[0, 7, 20, 7]` |

Ordered by period, index 0 = period 1. A nested
`{home: {period_1: 17, …}, away: {…}}` object is equally fine if that is closer to your
source — it is the shape the fixtures store uses. Either way we only need the periods
that have been played.

## Only live fixtures need them

Null everywhere else is correct and expected. Across 40,000 sampled fixtures the store
has them non-null on:

```
period              32,052
is_clock_stopped    30,980
period_number       30,001
clock                1,600     <- only while a game is actually running
```

`clock` is rare because a finished game has none. Among the 29 fixtures live at the time
of writing, 16 had one:

```
sport         live   with clock
basketball       9            6
tennis           7            0
soccer           6            5
icehockey        3            3
amfootball       1            1
baseball         1            1
cricket          1            0
esports          1            0
```

## Two things NOT to send

- **`time_min` and `time_sec`.** They exist on the source record and are **null on all
  33,036 fixtures that carry in-play data at all**, and absent on the rest — a count
  across the whole collection, not a sample. Dead fields; please don't carry them.
- **A synthesised clock.** Eight of the 29 live fixtures were running with
  `is_clock_stopped: false` and no clock — Oklahoma City v New Orleans at Q4, Astros de
  Jalisco at Q3. We show the bare period for those rather than invent a time, and would
  rather keep a true gap than receive a guess. Tennis never has a clock at all (0 of 7
  live matches) and that is correct, not a gap.

## Examples to verify against

Taken live from the store at 03:28 UTC, 7 Oct 2026:

```
202610062198A91B  amfootball_ncaaf      Troy v Southern Mississippi
  period_number=4  period="4"  clock="0:19"  is_clock_stopped=false
  home periods 17/14/10/14   away 0/7/20/7

202609180B502417  soccer_indonesia_championship   FC Bekasi City v Persikad Depok
  period_number=1  period="HALF"  clock=null  is_clock_stopped=true
  home periods 1/0   away 0/2

20261003D109F2A3  soccer_germany_regionalliga     SC Paderborn 07 II v SC Rot-Weiss Oberhausen
  period_number=1  period="1H"  clock="30"  is_clock_stopped=false

20261006C2073A6A  basketball_nba        Golden State Warriors v LA Lakers
  period_number=2  period="2"  clock=null  is_clock_stopped=true    (halftime)
  home periods 45/36   away 31/22
```

## How we will check it landed

Once the columns are on the pivot, `/api/event?id=<live fixture>` on the deployed site
should return a non-null `period` and a populated `periodScores`, and the badge should
read `Q4 02:13` / `HT` instead of `LIVE`. Nothing else needs to change on our side
beyond reading the new columns in `fixtureFromPivot`.
