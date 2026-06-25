import os
import json
import pandas as pd
import nflreadpy as nfl
from pandas_gbq import to_gbq
from sleeper_wrapper import Players, Stats
from google.oauth2 import service_account

project_id = "ff-python-api"
dataset_id = "nflreadpy"

sa_info = json.loads(os.environ["GCP_SA_KEY"])
credentials = service_account.Credentials.from_service_account_info(
    sa_info,
    scopes=["https://www.googleapis.com/auth/bigquery"],
)


def write(df, table):
    to_gbq(df, f"{dataset_id}.{table}", project_id=project_id,
           if_exists="replace", credentials=credentials)
    print(f"{table} written to BigQuery.")


# Players
players = nfl.load_players().to_pandas()
players = players[players["position"].isin(["QB", "RB", "WR", "TE"])].reset_index()
ids = nfl.load_ff_playerids().to_pandas()
players = pd.merge(players, ids, on="gsis_id", how="left", suffixes=("", "_y"))
players.drop(players.filter(regex="_y$").columns.tolist(), axis=1, inplace=True)
write(players, "players")

# Player Stats
player_stats = nfl.load_player_stats(2025, "week").to_pandas()
player_stats = player_stats[player_stats["position"].isin(["QB", "RB", "WR", "TE"])].reset_index()
player_stats["weekly_positional_ranks"] = (
    player_stats.groupby(["week", "position"])["fantasy_points_ppr"]
    .rank(method="min", ascending=False)
)
write(player_stats, "player_stats")

# Snap Counts
snap_counts = nfl.load_snap_counts(2025).to_pandas()
snap_counts = snap_counts[snap_counts["position"].isin(["QB", "RB", "WR", "TE"])].reset_index()
write(snap_counts, "snap_counts")

# Next Gen Stats
nextgen_stats = pd.concat([
    nfl.load_nextgen_stats(2025, "passing").to_pandas(),
    nfl.load_nextgen_stats(2025, "receiving").to_pandas(),
    nfl.load_nextgen_stats(2025, "rushing").to_pandas(),
])
nextgen_stats = nextgen_stats[nextgen_stats["player_position"].isin(["QB", "RB", "WR", "TE"])].reset_index()
write(nextgen_stats, "nextgen_stats")

# FF Opportunity
ff_opportunity = nfl.load_ff_opportunity(seasons=2025, stat_type="weekly", model_version="latest").to_pandas()
ff_opportunity = ff_opportunity[ff_opportunity["position"].isin(["QB", "RB", "WR", "TE"])].reset_index()
write(ff_opportunity, "ff_opportunity")

# Sleeper Projections
players_db = Players().get_all_players()
print(f"Sleeper players: {len(players_db)}")

stats = Stats()
proj = stats.get_all_projections("regular", 2026)
print(f"Projection rows: {len(proj)}")
