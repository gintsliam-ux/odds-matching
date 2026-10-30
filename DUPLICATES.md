# Duplicate report — Odds Library

Measured against the live database: 143620 fixtures, 361 distinct optic_league ids.


## 1. optic_league ids that look like one competition

`overlap` = share of the smaller id's teams also present in the other (names normalised, so "Alabama" matches "Alabama Crimson Tide" only if identical after normalising — see the prefix column).


| ids | fixtures | date ranges | same day ever? | team overlap | reading |
|---|---|---|---|---|---|
| `americanfootball_cfl`<br>`amfootball_cfl` | 129 + 4 | americanfootball_cfl: 2024-11-17 → 2026-08-15<br>amfootball_cfl: 2026-08-20 → 2026-08-23 | no | 100% | CUTOVER — same teams, never the same day |
| `americanfootball_ncaaf`<br>`amfootball_ncaaf` | 881 + 146 | americanfootball_ncaaf: 2025-01-01 → 2026-09-12<br>amfootball_ncaaf: 2026-08-27 → 2026-09-12 | YES | 94% | DUPLICATE COVERAGE — same teams, same days |
| `basketball_fiba_wc_qual`<br>`basketball_fiba_world_cup_qualifiers` | 253 + 18 | basketball_fiba_wc_qual: 2025-02-20 → 2026-07-09<br>basketball_fiba_world_cup_qualifiers: 2026-08-27 → 2026-08-28 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_austria_-_bundesliga`<br>`soccer_austria_bundesliga` | 17 + 503 | soccer_austria_-_bundesliga: 2026-08-14 → 2026-09-02<br>soccer_austria_bundesliga: 2025-02-07 → 2026-08-09 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_bulgaria_-_parva_liga`<br>`soccer_bulgaria_parva_liga` | 17 + 414 | soccer_bulgaria_-_parva_liga: 2026-08-14 → 2026-09-02<br>soccer_bulgaria_parva_liga: 2025-02-07 → 2026-08-10 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_conmebol_-_copa_libertadores`<br>`soccer_conmebol_copa_libertadores` | 16 + 371 | soccer_conmebol_-_copa_libertadores: 2026-08-11 → 2026-08-26<br>soccer_conmebol_copa_libertadores: 2024-11-30 → 2026-05-29 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_conmebol_-_copa_sudamericana`<br>`soccer_conmebol_copa_sudamericana` | 16 + 348 | soccer_conmebol_-_copa_sudamericana: 2026-08-11 → 2026-08-27<br>soccer_conmebol_copa_sudamericana: 2025-04-01 → 2026-07-31 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_denmark_-_superliga`<br>`soccer_denmark_superliga` | 32 + 441 | soccer_denmark_-_superliga: 2026-08-14 → 2026-09-14<br>soccer_denmark_superliga: 2024-12-02 → 2026-08-10 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_ecuador_-_serie_a`<br>`soccer_ecuador_serie_a` | 40 + 337 | soccer_ecuador_-_serie_a: 2026-08-15 → 2026-09-06<br>soccer_ecuador_serie_a: 2025-08-02 → 2026-08-11 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_england_-_efl_cup`<br>`soccer_england_efl_cup` | 60 + 191 | soccer_england_-_efl_cup: 2026-08-01 → 2026-08-27<br>soccer_england_efl_cup: 2025-01-07 → 2026-03-22 | no | 98% | CUTOVER — same teams, never the same day |
| `soccer_england_-_premier_league`<br>`soccer_england_premier_league` | 20 + 1115 | soccer_england_-_premier_league: 2026-08-21 → 2026-08-31<br>soccer_england_premier_league: 2025-01-01 → 2026-05-24 | no | 90% | CUTOVER — same teams, never the same day |
| `soccer_germany_-_bundesliga`<br>`soccer_germany_bundesliga` | 15 + 927 | soccer_germany_-_bundesliga: 2026-08-28 → 2026-09-06<br>soccer_germany_bundesliga: 2025-01-10 → 2026-05-25 | no | 94% | CUTOVER — same teams, never the same day |
| `soccer_greece_-_super_league`<br>`soccer_greece_super_league` | 7 + 610 | soccer_greece_-_super_league: 2026-08-22 → 2026-08-23<br>soccer_greece_super_league: 2025-01-04 → 2026-05-21 | no | 86% | CUTOVER — same teams, never the same day |
| `soccer_italy_-_serie_a`<br>`soccer_italy_serie_a` | 28 + 1095 | soccer_italy_-_serie_a: 2026-08-22 → 2026-09-07<br>soccer_italy_serie_a: 2025-01-04 → 2026-05-24 | no | 95% | CUTOVER — same teams, never the same day |
| `soccer_netherlands_-_eredivisie`<br>`soccer_netherlands_eredivisie` | 35 + 724 | soccer_netherlands_-_eredivisie: 2026-08-14 → 2026-09-09<br>soccer_netherlands_eredivisie: 2025-01-10 → 2026-08-09 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_norway_-_eliteserien`<br>`soccer_norway_eliteserien` | 31 + 537 | soccer_norway_-_eliteserien: 2026-08-14 → 2026-09-13<br>soccer_norway_eliteserien: 2024-12-01 → 2026-08-09 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_poland_-_ekstraklasa`<br>`soccer_poland_ekstraklasa` | 45 + 765 | soccer_poland_-_ekstraklasa: 2026-08-14 → 2026-09-15<br>soccer_poland_ekstraklasa: 2024-12-14 → 2026-08-09 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_portugal_-_primeira_liga`<br>`soccer_portugal_primeira_liga` | 23 + 778 | soccer_portugal_-_primeira_liga: 2026-08-14 → 2026-08-30<br>soccer_portugal_primeira_liga: 2025-01-03 → 2026-08-10 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_spain_-_la_liga`<br>`soccer_spain_la_liga` | 40 + 759 | soccer_spain_-_la_liga: 2026-08-15 → 2026-09-07<br>soccer_spain_la_liga: 2025-01-03 → 2026-05-24 | no | 85% | CUTOVER — same teams, never the same day |
| `soccer_sweden_-_allsvenskan`<br>`soccer_sweden_allsvenskan` | 32 + 496 | soccer_sweden_-_allsvenskan: 2026-08-14 → 2026-09-07<br>soccer_sweden_allsvenskan: 2025-03-29 → 2026-08-10 | no | 100% | CUTOVER — same teams, never the same day |
| `soccer_uefa_-_champions_league`<br>`soccer_uefa_champions_league` | 34 + 277 | soccer_uefa_-_champions_league: 2026-08-04 → 2026-08-26<br>soccer_uefa_champions_league: 2025-08-05 → 2026-07-29 | no | 75% | partial overlap — inspect |
| `soccer_uefa_-_super_cup`<br>`soccer_uefa_super_cup` | 1 + 1 | soccer_uefa_-_super_cup: 2026-08-12 → 2026-08-12<br>soccer_uefa_super_cup: 2025-08-13 → 2025-08-13 | no | 50% | one-off each, different editions — check before merging |


## 2. Fixtures recorded twice

- **Exact duplicates** (same sport, day and both team names): **4361 matches**, 8722 fixture rows.
- **Near duplicates** (same sport and day, team names differing only by a suffix such as "Alabama" vs "Alabama Crimson Tide"): **3411 pairs**.

Exact duplicates by id kind:

- `optic + syn` — 3248
- `optic + optic` — 732
- `syn + syn` — 381

### Sample exact duplicates

| sport | date | match | fixture_ids | leagues | has_sp |
|---|---|---|---|---|---|
| mma | 2025-01-11 | Magomed Gadzhiyasulov v Bruno Lopes | syn_c7be2b847fd308f7, syn_ace2bcf2c77e98b0 | mma_mixed_martial_arts, mma_ufc | True, True |
| mma | 2025-01-11 | Preston Parsons v Jacobe Smith | syn_b771dfb3d9d0ecf3, syn_db8153369c28deab | mma_mixed_martial_arts, mma_ufc | True, True |
| mma | 2025-01-11 | Jose Johnson v Felipe Bunes | syn_2e80ca084358ab43, syn_ea9472f285e688c6 | mma_mixed_martial_arts, mma_ufc | True, True |
| tennis | 2025-01-12 | Cristina Bucsa v Chloe Paquet | syn_04688a1740a54caf, wta:DE4C27E84E23 | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Hugo Gaston v Omar Jasika | syn_17b7712af3ee6271, atp:492BA8062F81 | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Diane Parry v Donna Vekic | syn_290f0a92baeaa750, wta:06C806328E29 | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Bernarda Pera v Tatjana Maria | syn_3c5d850ec0ae5c8d, wta:E86D4299DFE4 | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Anna Blinkova v Daria Saville | syn_5470b0562915ce15, wta:EFC12E734D4E | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Veronika Erjavec v Suzan Lamens | syn_62ca3ec3a5b787bd, wta:90DE78C7934B | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Clara Tauson v Linda Noskova | syn_7068f3c6fa086910, wta:A0E642F4A8CF | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Aryna Sabalenka v Sloane Stephens | syn_86c85166ea75a92e, wta:26F019FC2276 | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Paula Badosa v Xinyu Wang | syn_c5034c42b1c32a0b, wta:7C9EDEB18ED7 | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Sonay Kartal v Jessica Bouzas Maneiro | syn_dc909e176b86ceb8, wta:EAEDB460E12F | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Anca Todoni v Qinwen Zheng | syn_23f686439e7663c0, wta:47A8941F7B6C | tennis_wta, tennis_wta_aus_open_singles | True, True |
| tennis | 2025-01-12 | Otto Virtanen v Arthur Fils | syn_7a4d64f50c5a890d, atp:7C07293DCF4A | tennis_atp, tennis_atp_aus_open_singles | True, True |
| mma | 2025-01-12 | Cesar Almeida v Abdul Razak Alhassan | syn_584aed47b8cdfd16, syn_70f22eda0e634ecb | mma_mixed_martial_arts, mma_ufc | True, True |
| tennis | 2025-01-12 | Kei Nishikori v Thiago Monteiro | syn_5625e6cc2e0b117a, atp:B0ADCD28609D | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Gauthier Onclin v Reilly Opelka | syn_953b899458ea7045, atp:12351AED58CA | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Casper Ruud v Jaume Munar | syn_b06b2f82fe12f933, atp:9CB414E0F1F0 | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Adam Walton v Quentin Halys | syn_bbf33f9bb41c6429, atp:0883D62CF297 | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Sumit Nagal v Tomas Machac | syn_63e932dcc9acdef6, atp:6FE5B0D7F3DB | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Pedro Martinez v Luciano Darderi | syn_0ded01effb6b6af4, atp:CFB6FA0FEF3D | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Ugo Humbert v Matteo Gigante | syn_fa80aa5621829bc5, atp:0F0595C43631 | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Jiri Lehecka v Li Tu | syn_4f8d0d140e880bc9, atp:A1C6C15D5D3E | tennis_atp, tennis_atp_aus_open_singles | True, True |
| tennis | 2025-01-12 | Lucas Pouille v Alexander Zverev | syn_e39964f0528a4006, atp:5E137EBA7C82 | tennis_atp, tennis_atp_aus_open_singles | True, True |

### Sample near duplicates (naming difference)

| sport | date | A | B | fixture_ids | leagues |
|---|---|---|---|---|---|
| soccer | 2025-01-01 | Burton Albion FC v Peterborough United FC | Burton Albion v Peterborough United | england_-_league_1:95956F6CDCCA, syn_00bc8fc1c878e01b | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-01 | Bristol Rovers FC v Leyton Orient FC | Bristol Rovers v Leyton Orient | england_-_league_1:98E3429F994A, syn_1ccfe736e35eccef | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-01 | Cambridge United FC v Reading FC | Cambridge United v Reading | england_-_league_1:A7A836F29B47, syn_ba3e5758739fab1c | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-01 | Northampton Town FC v Stevenage FC | Northampton Town v Stevenage | england_-_league_1:CCDB6F549EA4, syn_51eb7795c3096458 | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-01 | Wycombe Wanderers FC v Exeter City FC | Wycombe Wanderers v Exeter City | england_-_league_1:D2FE8DCE3D30, syn_62fb4e74f1591b8b | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-01 | Blackpool FC v Shrewsbury Town FC | Blackpool v Shrewsbury Town | england_-_league_1:E06B123BCF7D, syn_f46e9183ef47e54a | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-01 | Crewe Alexandra FC v Carlisle United FC | Crewe Alexandra v Carlisle United | england_-_league_2:2F0192B21747, syn_e92e517b9a77f238 | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-01 | Notts County FC v Walsall FC | Notts County v Walsall | england_-_league_2:42AD7D024B4C, syn_0448b332e7aa218a | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-01 | Barrow AFC v Bradford City AFC | Barrow v Bradford City | england_-_league_2:43E743385ABA, syn_2a889340df9b11dc | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-01 | Accrington Stanley FC v Grimsby Town FC | Accrington Stanley v Grimsby Town | england_-_league_2:440334927B88, syn_7a7329f2bb1ee2c4 | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-01 | Port Vale FC v Cheltenham Town FC | Port Vale v Cheltenham Town | england_-_league_2:ABE55E791D25, syn_a912780d09456761 | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-01 | Doncaster Rovers FC v Fleetwood Town FC | Doncaster Rovers v Fleetwood Town | england_-_league_2:AC8238A88AA7, syn_b2d6826ffc164dee | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-01 | Harrogate Town FC v Salford City FC | Harrogate Town v Salford City | england_-_league_2:B24285BE439B, syn_3e92334bf780c8d9 | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-01 | Morecambe FC v Tranmere Rovers FC | Morecambe v Tranmere Rovers | england_-_league_2:C2F3DFF78359, syn_ab58448df7433744 | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-01 | Swindon Town FC v Colchester United FC | Swindon Town v Colchester United | england_-_league_2:CA940052D760, syn_4018c52f33890f5b | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-03 | Brisbane Roar FC v Central Coast Mariners FC | Brisbane Roar v Central Coast Mariners | australia_-_a-league:263AB9EB19CC, syn_0eba7e8c4fc3a16a | soccer_australia_aleague, soccer_australia_aleague |
| soccer | 2025-01-04 | Melbourne Victory FC v Western Sydney Wanderers FC | Melbourne Victory v Western Sydney Wanderers | australia_-_a-league:3EE2D93EB38C, syn_c8c8fba409b1f09e | soccer_australia_aleague, soccer_australia_aleague |
| soccer | 2025-01-04 | Burton Albion FC v Northampton Town FC | Burton Albion v Northampton Town | england_-_league_1:A95920CC9015, syn_783598e0a94906ef | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-04 | Cambridge United FC v Bristol Rovers FC | Cambridge United v Bristol Rovers | england_-_league_1:D4288E580859, syn_2ddc7c40d883fd10 | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-04 | Notts County FC v Swindon Town FC | Notts County v Swindon Town | england_-_league_2:3A54ECED6369, syn_ce92c5873ca019e1 | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-04 | Bradford City AFC v Grimsby Town FC | Bradford City v Grimsby Town | england_-_league_2:DE87C9E5F131, syn_cd8007770fa21a13 | soccer_england_league2, soccer_england_league2 |
| soccer | 2025-01-04 | Wigan Athletic FC v Birmingham City FC | Wigan Athletic v Birmingham City | england_-_league_1:0A32F8C3289B, syn_5283c34f5e115da0 | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-04 | Wycombe Wanderers FC v Blackpool FC | Wycombe Wanderers v Blackpool | england_-_league_1:1653F283AC3B, syn_44ab8c0339721caf | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-04 | Leyton Orient FC v Shrewsbury Town FC | Leyton Orient v Shrewsbury Town | england_-_league_1:26E73FF7F9FD, syn_ffcce3f0458417ed | soccer_england_league1, soccer_england_league1 |
| soccer | 2025-01-04 | Exeter City FC v Bolton Wanderers FC | Exeter City v Bolton Wanderers | england_-_league_1:4089D41765E5, syn_f5833c081d8c5ea9 | soccer_england_league1, soccer_england_league1 |
