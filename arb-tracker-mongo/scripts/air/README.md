# What runs on the Air

Nothing under `~/gutsy` on the Air is a git checkout — every directory there is
a hand-made copy — so a file that exists only on that machine has no history,
no backup, and no way to tell that the running copy has drifted from the one
somebody last edited. `sync-to-atlas.mjs` carries a warning about exactly this,
earned on 2026-10-20 when the hourly mirror failed silently for three days.

These are the canonical copies. Changing one here does nothing until it is
copied across.

| file | installed at | what it does |
|---|---|---|
| `run-player-stats.sh` | `~/gutsy/odds-matching-mongo/scripts/` | mirrors `player_stats` and `mybet.markets` to Atlas |
| `com.gutsy.playerstats.plist` | `~/Library/LaunchAgents/` | runs it every 60s (`StartInterval 60`, `RunAtLoad`) |

To deploy:

    scp scripts/air/run-player-stats.sh liam@100.64.153.96:~/gutsy/odds-matching-mongo/scripts/
    scp scripts/air/com.gutsy.playerstats.plist liam@100.64.153.96:~/Library/LaunchAgents/
    ssh liam@100.64.153.96 'launchctl unload ~/Library/LaunchAgents/com.gutsy.playerstats.plist;
                            launchctl load   ~/Library/LaunchAgents/com.gutsy.playerstats.plist'

`sync-to-atlas.mjs` itself is NOT here — its canonical copy is
`scripts/sync-to-atlas.mjs` in this repo, and it is copied to
`~/gutsy/odds-matching-mongo/scripts/` the same way.

## Why these exist

The deployed site reads Atlas. `player_stats` and `mybet.markets` both change
while somebody is watching — a live box score is rewritten about once a minute,
and the market book carries the alternate lines and the quarter markets — and
both used to reach Atlas only on the slow mapping mirror, whose cycle measured
7 to 21 minutes. Final stats could sit on the NAS for twenty minutes after the
whistle. This job carries just those two, in about a second, every minute,
beside the slow mirror rather than instead of it.
