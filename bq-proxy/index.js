const { BigQuery } = require('@google-cloud/bigquery');

const bq = new BigQuery();
const DATASET = 'dynasty_tycoon';
const TABLE   = 'draft_picks';
const PROJECT = 'ff-python-api';

exports.draftPicksInsert = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {

    // ?roster=1  →  eligible player list for draft typeahead
    if (req.query.roster === '1') {
      try {
        const [rows] = await bq.query({
          query: `
            SELECT
              gsis_id,
              display_name,
              position,
              CAST(FLOOR(age) AS INT64) AS age,
              latest_team
            FROM \`${PROJECT}.nflreadpy.players\`
            WHERE position IN ('QB','WR','RB','TE')
              AND last_season >= 2023
              AND display_name IS NOT NULL
            ORDER BY display_name ASC
          `,
        });
        res.status(200).json({ players: rows });
      } catch (err) {
        console.error('Roster load error:', err);
        res.status(500).json({ error: 'Failed to load roster', message: err.message });
      }
      return;
    }

    // ?eval=<gsis_id>  →  season + weekly stats + YPRR for Player Eval tab
    if (req.query.eval) {
      const gsis_id = String(req.query.eval);
      try {
        const [[seasonRows], [weeklyRows], [yprrRows]] = await Promise.all([

          // 1. Season aggregates: player_stats + snap_counts + ff_opportunity
          bq.query({
            query: `
              WITH stats AS (
                SELECT
                  player_id,
                  COUNT(DISTINCT week)       AS games,
                  SUM(passing_yards)         AS passing_yards,
                  SUM(passing_tds)           AS passing_tds,
                  SUM(passing_interceptions) AS interceptions,
                  SUM(attempts)              AS attempts,
                  SUM(completions)           AS completions,
                  SUM(carries)               AS carries,
                  SUM(rushing_yards)         AS rushing_yards,
                  SUM(rushing_tds)           AS rushing_tds,
                  SUM(receptions)            AS receptions,
                  SUM(targets)               AS targets,
                  SUM(receiving_yards)       AS receiving_yards,
                  SUM(receiving_tds)         AS receiving_tds,
                  SUM(fantasy_points_ppr)    AS fantasy_pts_ppr
                FROM \`${PROJECT}.nflreadpy.player_stats\`
                WHERE player_id = @gsis_id
                  AND season_type = 'REG'
                GROUP BY player_id
              ),
              snaps AS (
                SELECT pfr_player_id, AVG(offense_pct) AS snap_pct
                FROM \`${PROJECT}.nflreadpy.snap_counts\`
                WHERE game_type = 'REG'
                GROUP BY pfr_player_id
              ),
              opp AS (
                SELECT
                  player_id,
                  AVG(rec_attempt / NULLIF(rec_attempt_team, 0))               AS target_share,
                  AVG(total_fantasy_points / NULLIF(total_fantasy_points_exp, 0)) AS wopr
                FROM \`${PROJECT}.nflreadpy.ff_opportunity\`
                WHERE player_id = @gsis_id
                GROUP BY player_id
              )
              SELECT
                s.*,
                sn.snap_pct,
                o.target_share,
                o.wopr,
                SAFE_DIVIDE(s.completions, s.attempts) AS completion_pct
              FROM stats s
              LEFT JOIN opp o ON o.player_id = s.player_id
              LEFT JOIN \`${PROJECT}.nflreadpy.players\` pl ON pl.gsis_id = s.player_id
              LEFT JOIN snaps sn ON sn.pfr_player_id = pl.pfr_id
            `,
            params: { gsis_id },
          }),

          // 2. Weekly fantasy points for bar chart
          bq.query({
            query: `
              SELECT week, SUM(fantasy_points_ppr) AS fantasy_pts
              FROM \`${PROJECT}.nflreadpy.player_stats\`
              WHERE player_id = @gsis_id
                AND season_type = 'REG'
              GROUP BY week
              ORDER BY week ASC
            `,
            params: { gsis_id },
          }),

          // 3. Weekly YPRR from pfr_advstats_rec, joined via pfr_id
          //    Table created by Colab ETL: nflreadpy.load_pfr_advstats(stat_type='rec')
          bq.query({
            query: `
              SELECT
                r.week,
                r.routes_run,
                r.targets                               AS pfr_targets,
                r.rec_yards,
                SAFE_DIVIDE(r.rec_yards, r.routes_run)  AS yprr,
                r.adot,
                r.yac,
                r.drop,
                r.drop_pct
              FROM \`${PROJECT}.nflreadpy.pfr_advstats_rec\` r
              JOIN \`${PROJECT}.nflreadpy.players\` pl
                ON pl.pfr_id = r.pfr_player_id
              WHERE pl.gsis_id = @gsis_id
                AND r.game_type = 'REG'
              ORDER BY r.week ASC
            `,
            params: { gsis_id },
          }),
        ]);

        // Roll up season-level YPRR from the weekly rows
        const totalRoutes = yprrRows.reduce((s, r) => s + (r.routes_run || 0), 0);
        const totalRecYds = yprrRows.reduce((s, r) => s + (r.rec_yards  || 0), 0);
        const yprr_season = yprrRows.length > 0 ? {
          routes_run: totalRoutes,
          yprr:       totalRoutes > 0 ? totalRecYds / totalRoutes : null,
          adot:       yprrRows.reduce((s, r) => s + (r.adot     || 0), 0) / yprrRows.length,
          drop_pct:   yprrRows.reduce((s, r) => s + (r.drop_pct || 0), 0) / yprrRows.length,
        } : null;

        res.status(200).json({
          season:      seasonRows[0] || {},
          weekly:      weeklyRows,
          yprr_weekly: yprrRows,
          yprr_season,
        });
      } catch (err) {
        console.error('Eval error:', err);
        res.status(500).json({ error: 'Failed to load eval data', message: err.message });
      }
      return;
    }

    // default: load existing draft picks
    try {
      const [rows] = await bq.query({
        query: `SELECT * FROM \`${PROJECT}.${DATASET}.${TABLE}\` ORDER BY drafted_at ASC`,
      });
      res.status(200).json({ picks: rows });
    } catch (err) {
      console.error('Load error:', err);
      res.status(500).json({ error: 'Failed to load picks', message: err.message });
    }
    return;
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { pick_id } = req.body;
    if (!pick_id) { res.status(400).json({ error: 'Missing pick_id' }); return; }
    try {
      await bq.query({
        query:  `DELETE FROM \`${PROJECT}.${DATASET}.${TABLE}\` WHERE pick_id = @pick_id`,
        params: { pick_id: String(pick_id) },
      });
      console.log(`Deleted pick: ${pick_id}`);
      res.status(200).json({ success: true, pick_id });
    } catch (err) {
      console.error('Delete error:', err);
      res.status(500).json({ error: 'Failed to delete pick', message: err.message });
    }
    return;
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body;
    const required = ['pick_id', 'player_name', 'position', 'salary', 'contract_yrs'];
    for (const f of required) {
      if (body[f] === undefined || body[f] === null || body[f] === '') {
        res.status(400).json({ error: `Missing required field: ${f}` }); return;
      }
    }

    try {
      const [rows] = await bq.query({
        query:  `SELECT pick_id FROM \`${PROJECT}.${DATASET}.${TABLE}\` WHERE LOWER(player_name) = LOWER(@name) LIMIT 1`,
        params: { name: String(body.player_name) },
      });
      if (rows.length > 0) {
        res.status(409).json({ error: 'duplicate', message: `${body.player_name} is already drafted` });
        return;
      }
    } catch (err) {
      console.error('Duplicate check error:', err);
    }

    try {
      const row = {
        pick_id:          String(body.pick_id),
        drafted_at:       body.drafted_at || new Date().toISOString(),
        player_name:      String(body.player_name),
        position:         String(body.position),
        age:              parseInt(body.age) || null,
        salary:           parseFloat(body.salary),
        contract_yrs:     parseInt(body.contract_yrs),
        discount_pct:     parseFloat(body.discount_pct) || 0,
        cap_hit:          parseFloat(body.cap_hit),
        total_commitment: parseFloat(body.total_commitment),
      };
      await bq.dataset(DATASET).table(TABLE).insert([row]);
      console.log(`Inserted: ${row.player_name} (${row.position}) $${row.salary}/${row.contract_yrs}yr`);
      res.status(200).json({ success: true, pick_id: row.pick_id });
    } catch (err) {
      console.error('Insert error:', err);
      if (err.name === 'PartialFailureError') {
        res.status(422).json({ error: 'BigQuery insert failed', details: err.errors });
      } else {
        res.status(500).json({ error: 'Internal server error', message: err.message });
      }
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
