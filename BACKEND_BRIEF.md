# Odds Library — what to change in the backend

23 Aug 2026. Scanned against the live database: 418 competitions, 139,786 fixtures.

## 1. The one that matters: the sync re-adds Optic's league name

**70 league ids are showing two tournament names.** Not two ids — one id, two names,
so the sidebar lists the same competition twice.

```
soccer_england_premier_league   'English Premier League'  +  'England - Premier League'
soccer_spain_la_liga            'La Liga'                 +  'Spain - La Liga'
soccer_italy_serie_a            'Serie A'                 +  'Italy - Serie A'
baseball_lmb                    'Mexican Baseball League' +  'Mexico - LMB'
rugbyleague_nrl                 'NRL'                     +  'Australia - NRL'
```

**65 of the 70 second rows carry their first fixture on 2026-08-22**, and 69 of 70 on
or after it — the day the tournament labels were rewritten. The old name stops, Optic's
name resumes on the same id the next time the competition plays.

**Cause.** On sync, when the incoming Optic league name differs from the stored
`tournament`, a new row is written rather than the existing one matched. Renaming the
label downstream therefore cannot hold: the rename creates the difference that makes the
next sync insert a second row.

**Fix.** Match on `optic_league` alone and keep the stored `tournament`; never let the
incoming league name create a row. Either naming convention works — ours (country in
`category`, short name in `tournament`) or Optic's — but the sync has to preserve one of
them rather than merge both. With that in place all 70 collapse and stay collapsed.

Full list with both names, fixture counts and the date the second row starts:
`SPLIT_LEAGUES.csv`.

Not in that list, and not faults: `golf_pga` carrying four championships and
`tennis_atp_challenger` carrying ten cities are genuinely separate events under one tour
id, which is how those sports work.

## 2. 33 league ids Optic does not issue

Lower priority — with #1 fixed these stop splitting — but they will keep drifting from
the feed's vocabulary. Each is a short legacy id where Optic issues a region-prefixed
one: `baseball_lmb` → `mexico_-_lmb`, `rugbyleague_nrl` → `australia_-_nrl`,
`icehockey_liiga` → `finland_-_sm_liiga`, `boxing_boxing` → `boxing_matches`, and 29
more. Full mapping with the Optic id and Optic's own league name for each:
`ACTIONS_BY_SPORT.csv`.

Note the rule is "match Optic", not "always add the country": Optic issues a bare `afl`
for the men's competition but `australia_-_afl_women` for the women's.

## 3. Category quality — affects the sidebar headings

Five categories are a truncated word, and each renders as its own heading:

| shows as | should be | competition | fixtures |
|---|---|---|---|
| `Efl` | England | EFL Championship | 1,398 |
| `Spl` | Scotland | Scottish Premiership | 582 |
| `Fa` | England | FA Cup | 448 |
| `League` | Ireland | League of Ireland | 420 |
| `South` | South Africa | South African Premier | 269 |

Eleven more are a competition sitting beside countries — under Baseball the sidebar reads
`USA · Mexico · NPB · KBO · CPBL`, where the last three should be Japan, South Korea and
Taiwan. Also `CFL`→Canada, `AFL`→Australia, `WNBA`/`BIG3`→USA, `FIBA`→International,
`Mestis`→Finland, `Champions Hockey League`→International, `MODUS`→International.

The MMA promotions (`UFC`, `PFL`, `KSW`, `OKTAGON`) and the golf and tennis tours read
fine as categories — those are deliberate, leave them.

## 4. 32 tournament names still carry the sport word

`Soccer Netherlands Eerste Divisie` (424 fx), `Soccer Ukraine Premier` (259),
`Basketball Argentina Lnb` (409), `Esports Dota2` (964), `MMA` (2,282), `Boxing` (955),
`Volleyball Fivb Nations League` (229) and 25 others. These were missed by the rename
pass because they had no second label to collapse against, so nothing flagged them.

## 5. Tennis: one event name has swallowed three tours

Pre-existing, unrelated to the above, and the largest single mislabel in the data:

```
tennis_atp             'ATP Estoril Open'  7,948 fx
tennis_atp_challenger  'Lincoln'          17,865 fx
tennis_wta             'WTA Vancouver'    11,346 fx
```

Every genuinely new event now arrives correctly named (`Cincinnati, USA`,
`Prague, Czech Republic`), so the tour ids are right — but the giant historical row keeps
the whole tour under one event's name, and a new city row appears per tournament
indefinitely.

## What is already clean

No fixture is filed under two ids anywhere. No competition is filed under the wrong
sport. Every league id resolves to a row in `leagues`. No two competitions collide onto
one sidebar entry. `normalized_selection`, `pair_key` and `has_sp` are all sound.
