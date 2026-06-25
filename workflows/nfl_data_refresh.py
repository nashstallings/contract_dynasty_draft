code_to_write = """
!pip install -q nflreadpy
!pip install -q pandas_gbq
!pip install sleeper-api-wrapper -q

import pandas as pd
import nflreadpy as nfl
from pandas_gbq import to_gbq
from sleeper_wrapper import Players, Stats

from google.colab import auth
auth.authenticate_user()

import google.auth
credentials, project = google.auth.default()

# Dataset/table names
project_id = "ff-python-api"
dataset_id = "nflreadpy"

# Players
players = nfl.load_players().to_pandas()
players = players[players['position'].isin(['QB','RB','WR','TE'])].reset_index()

ids = nfl.load_ff_playerids().to_pandas()
players = pd.merge(players, ids, on='gsis_id', how='left', suffixes=('', '_y'))
players.drop(players.filter(regex='_y$').columns.tolist(),axis=1, inplace=True)

# Write players Dataframe to BigQuery
to_gbq(players, f"{dataset_id}.players", project_id=project_id, if_exists='replace')
print("Players DataFrame successfully written to BigQuery.")

# Player Stats
player_stats = nfl.load_player_stats(2025,"week").to_pandas()
player_stats = player_stats[player_stats['position'].isin(['QB','RB','WR','TE'])].reset_index()
player_stats['weekly_positional_ranks'] = player_stats.groupby(['week','position'])['fantasy_points_ppr'].rank(method="min", ascending=False)

# Write player_stats DataFrame to BigQuery
to_gbq(player_stats, f"{dataset_id}.player_stats", project_id=project_id, if_exists='replace')
print("Player Stats DataFrame successfully written to BigQuery.")

# Snap Counts
snap_counts = nfl.load_snap_counts(2025).to_pandas()
snap_counts = snap_counts[snap_counts['position'].isin(['QB','RB','WR','TE'])].reset_index()

# Write snap_counts DataFrame to BigQuery
to_gbq(snap_counts, f"{dataset_id}.snap_counts", project_id=project_id, if_exists='replace')
print("Snap Counts DataFrame successfully written to BigQuery.")

# Next Gen Stats
nextgen_stats_passing = nfl.load_nextgen_stats(2025,'passing').to_pandas()
nextgen_stats_receiving = nfl.load_nextgen_stats(2025,'receiving').to_pandas()
nextgen_stats_rushing = nfl.load_nextgen_stats(2025,'rushing').to_pandas()
nextgen_stats = pd.concat([nextgen_stats_passing, nextgen_stats_receiving, nextgen_stats_rushing])
nextgen_stats = nextgen_stats[nextgen_stats['player_position'].isin(['QB','RB','WR','TE'])].reset_index()

# Write nextgen_stats Dataframe to BigQuery
to_gbq(nextgen_stats, f"{dataset_id}.nextgen_stats", project_id=project_id, if_exists='replace')
print("Nextgen_Stats DataFrame successfully written to BigQuery.")

# FF Opportunity
ff_opportunity = nfl.load_ff_opportunity(seasons = 2025,stat_type = "weekly",model_version = "latest").to_pandas()
ff_opportunity = ff_opportunity[ff_opportunity['position'].isin(['QB','RB','WR','TE'])].reset_index()

# Write ff_opportunity Dataframe to BigQuery
to_gbq(ff_opportunity, f"{dataset_id}.ff_opportunity", project_id=project_id, if_exists='replace')
print("FF_Opportunity DataFrame successfully written to BigQuery.")

# Full player DB (carries gsis_id, position, team, age)
players_db = Players().get_all_players()
print("Sleeper players:", len(players_db))

# Projections come through the Stats class
stats = Stats()
print("Stats methods:", [m for m in dir(stats) if not m.startswith('_')])

# 2026 season-long projections
proj = stats.get_all_projections("regular", 2026)
print("Projection rows:", len(proj), "| type:", type(proj).__name__)

# Inspect one record
import json
k = next(iter(proj))
print("\nSample (player_id =", k, "):")
print(json.dumps(proj[k], indent=2)[:900])
"""

with open('nfl_data_processing.py', 'w') as f:
    f.write(code_to_write)

print("nfl_data_processing.py created successfully!")
