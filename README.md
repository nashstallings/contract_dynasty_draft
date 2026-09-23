# contract_dynasty_draft

A contract-based dynasty draft board. `index.html` is the static front end;
`bq-proxy/` is the small Cloud Function it calls, which queries BigQuery on the
page's behalf so no credentials reach the browser.

## Where the data comes from

The proxy reads four tables in `ff-python-api.nflreadpy`:

| Table | Used for |
|---|---|
| `players` | name / position / team, and the cross-platform id join |
| `player_stats` | weekly stat lines |
| `snap_counts` | snap share |
| `ff_opportunity` | opportunity + target-share model output |

**This repo reads those tables. It does not write them.**

They are owned by the `NFL Data Weekly Refresh` workflow in
[`nashstallings/fantasy_football`](https://github.com/nashstallings/fantasy_football),
which rebuilds them every Tuesday from nflreadpy.

`nfl_data_refresh.py` used to populate them from here on a daily cron. It was
removed because two processes were writing the same tables and both used
`if_exists="replace"` — so they were not merging, they were taking turns
clobbering each other, and whichever ran last decided what the tables held.
Nothing failed while that was happening: both writes succeeded and both logs
looked healthy. It surfaced only as a downstream dashboard that kept showing a
season-old view.

The script also had its seasons hardcoded — `range(2022, 2026)` for
`player_stats`, a bare `2025` for the rest — so it could not have picked up
2026 without an edit. The replacement resolves the season from nflreadpy at run
time.

If these tables ever look stale, fix it in `fantasy_football`. Do not add a
writer back here.

## Local dev

`index.html` is static — open it directly, or serve the directory. See
`bq-proxy/` for the function's own setup.
