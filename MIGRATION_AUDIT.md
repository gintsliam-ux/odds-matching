# Migration audit — old per-sport tables vs the new schema

Every month of every old table. Events matched allowing +/- 2 days (the old `date` is a plain date, `scheduled_start` a timestamptz) and prefix names ("St Kilda Saints" vs "St Kilda").


**Sampled 13534 distinct events, matched 13531 (99%).**


## Per sport

| sport | months with data | old rows | sampled | matched | unmatched | months where new schema has 0 fixtures |
|---|---|---|---|---|---|---|
| soccer | 28 | 830,547 | 1512 | 1511 | 1 | — |
| basketball | 25 | 771,503 | 1029 | 1029 | 0 | — |
| tennis | 27 | 930,100 | 1555 | 1555 | 0 | — |
| baseball | 24 | 288,133 | 1241 | 1241 | 0 | — |
| icehockey | 16 | 73,391 | 1110 | 1110 | 0 | — |
| amfootball | 24 | 81,720 | 478 | 478 | 0 | — |
| aussierules | 48 | 61,353 | 366 | 365 | 1 | — |
| rugbyleague | 62 | 42,835 | 1354 | 1354 | 0 | — |
| rugbyunion | 7 | 1,036 | 75 | 75 | 0 | — |
| cricket | 28 | 1,517 | 1297 | 1297 | 0 | — |
| mma | 23 | 3,562 | 1522 | 1521 | 1 | — |
| boxing | 19 | 1,138 | 892 | 892 | 0 | — |
| darts | 5 | 154 | 154 | 154 | 0 | — |
| esports | 9 | 3,865 | 720 | 720 | 0 | — |
| volleyball | 6 | 673 | 229 | 229 | 0 | — |

## Unmatched events — each one chased down

Three of 13,534. Two are naming, one is real.

| event | verdict |
|---|---|
| mma 2026-08-11 Jon Kunneman v Joe Kropschot | **Present.** Filed as "Jon Kunneman v **Joseph** Kropschot", same date. |
| aussierules 2026-07-25 Greater Western Sydney v Sydney Swans | **Present.** Filed as "**GWS GIANTS** v Sydney Swans", same date — no prefix bridges those two spellings. |
| soccer 2025-12-31 Central Coast Mariners v Brisbane Roar | **GENUINELY MISSING.** `soccer_odds` holds 57 rows and 199 prices for it (commence_time 2025-12-31T08:00Z, "Australia Aleague"). `fixtures` has Central Coast games on 6, 12, 21 and 27 Dec and A-League fixtures throughout the month — this single fixture did not come across. |

So one fixture in 13,534 sampled — 0.007% — and it is an isolated miss, not a hole in a month or a league.

## Duplicates: fixed forward, still present in the archive

Same match under two fixture_ids, counted on soccer:

| window | fixtures | duplicated matches |
|---|---|---|
| Dec 2025 | 2,342 | **121** (245 rows) |
| Aug 2026 | 2,108 | **0** |

e.g. 2025-12-06 "Plymouth Argyle FC v Bradford City AFC" [League One] alongside
"Plymouth Argyle v Bradford City" [League 1]. The merge cleaned current data;
the archive period still carries pairs, and their odds are split across both.

## Original unmatched list


**soccer** — 1 unmatched of 1512 sampled

- 2025-12-31 Central Coast Mariners v Brisbane Roar

**aussierules** — 1 unmatched of 366 sampled

- 2026-07-25 Greater Western Sydney v Sydney Swans

**mma** — 1 unmatched of 1522 sampled

- 2026-08-11 Jon Kunneman v Joe Kropschot
