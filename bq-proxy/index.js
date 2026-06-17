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

    // ?auction_values=1  →  player auction value cheat sheet for Auction Values tab
    if (req.query.auction_values === '1') {
      try {
        const [rows] = await bq.query({
          query: `
            SELECT
              av.player_id,
              av.player_name,
              av.position,
              av.rank,
              av.auction_value,
              av.tier,
              av.tier_desc,
              av.ranking_note,
              CAST(FLOOR(pl.age) AS INT64) AS age,
              pl.latest_team AS team
            FROM \`${PROJECT}.dynasty_tycoon.player_auction_values\` av
            LEFT JOIN \`${PROJECT}.nflreadpy.players\` pl
              ON pl.gsis_id = av.player_id
            ORDER BY av.rank ASC
          `,
        });
        res.status(200).json({ auction_values: rows });
      } catch (err) {
        console.error('Auction values load error:', err);
        res.status(500).json({ error: 'Failed to load auction values', message: err.message });
      }
      return;
    }

    // ?targets=1  →  live draft targets computed from draft_picks + player_auction_values
    if (req.query.targets === '1') {
      try {
        // Single query: join auction values against current picks to get
        // undrafted players scored by positional need, age, tier, and budget fit
        const [rows] = await bq.query({
          query: `
            WITH
            -- Current roster state
            picks AS (
              SELECT
                player_name,
                position,
                salary,
                SUM(salary) OVER () AS total_spent,
                COUNT(*) OVER ()    AS total_drafted
              FROM \`${PROJECT}.${DATASET}.${TABLE}\`
            ),
            roster_summary AS (
              SELECT
                COALESCE(SUM(salary), 0)  AS total_spent,
                COALESCE(COUNT(*), 0)     AS total_drafted,
                COALESCE(SUM(CASE WHEN position = 'QB' THEN 1 ELSE 0 END), 0) AS have_qb,
                COALESCE(SUM(CASE WHEN position = 'RB' THEN 1 ELSE 0 END), 0) AS have_rb,
                COALESCE(SUM(CASE WHEN position = 'WR' THEN 1 ELSE 0 END), 0) AS have_wr,
                COALESCE(SUM(CASE WHEN position = 'TE' THEN 1 ELSE 0 END), 0) AS have_te,
                COALESCE(MAX(CASE WHEN position = 'QB' AND salary >= 40 THEN 1 ELSE 0 END), 0) AS has_elite_qb
              FROM \`${PROJECT}.${DATASET}.${TABLE}\`
            ),
            -- Available undrafted players with age joined in
            available AS (
              SELECT
                av.player_name,
                av.position,
                av.rank,
                av.auction_value,
                av.tier,
                av.tier_desc,
                av.ranking_note,
                CAST(FLOOR(pl.age) AS INT64) AS age
              FROM \`${PROJECT}.dynasty_tycoon.player_auction_values\` av
              LEFT JOIN \`${PROJECT}.nflreadpy.players\` pl ON pl.gsis_id = av.player_id
              WHERE NOT EXISTS (
                SELECT 1 FROM \`${PROJECT}.${DATASET}.${TABLE}\` dp
                WHERE LOWER(dp.player_name) = LOWER(av.player_name)
              )
            ),
            -- Score every available player against current roster state
            scored AS (
              SELECT
                a.*,
                rs.total_spent,
                rs.total_drafted,
                rs.have_qb,
                rs.have_rb,
                rs.have_wr,
                rs.have_te,
                rs.has_elite_qb,
                (250 - rs.total_spent) AS remaining,
                SAFE_DIVIDE(250 - rs.total_spent, GREATEST(36 - rs.total_drafted, 1)) AS avg_bid,

                -- Positional need score (starter floors: QB=2, RB=2, WR=3, TE=1)
                CASE a.position
                  WHEN 'QB' THEN
                    CASE WHEN rs.have_qb = 0 THEN 50
                         WHEN rs.have_qb = 1 AND rs.has_elite_qb = 1 THEN 42  -- QB2 in SF starts every week
                         WHEN rs.have_qb = 1 THEN 40
                         WHEN rs.have_qb < 3 THEN 14
                         ELSE 2 END
                  WHEN 'RB' THEN
                    CASE WHEN rs.have_rb = 0 THEN 50
                         WHEN rs.have_rb = 1 THEN 44
                         WHEN rs.have_rb < 4 THEN 20
                         WHEN rs.have_rb < 6 THEN 8
                         ELSE 0 END
                  WHEN 'WR' THEN
                    CASE WHEN rs.have_wr = 0 THEN 46
                         WHEN rs.have_wr = 1 THEN 38
                         WHEN rs.have_wr = 2 THEN 28
                         WHEN rs.have_wr < 5 THEN 16
                         WHEN rs.have_wr < 7 THEN 6
                         ELSE 0 END
                  WHEN 'TE' THEN
                    CASE WHEN rs.have_te = 0 AND a.auction_value >= 30 THEN 44
                         WHEN rs.have_te = 0 THEN 30
                         WHEN rs.have_te < 2 THEN 8
                         ELSE 0 END
                  ELSE 0
                END AS need_score,

                -- Dynasty age score
                CASE
                  WHEN a.age IS NULL   THEN 4
                  WHEN a.age <= 23     THEN 20
                  WHEN a.age <= 26     THEN 12
                  WHEN a.age <= 28     THEN 4
                  WHEN a.age <= 30     THEN -8
                  ELSE -20
                END AS age_score,

                -- Tier quality score
                CASE a.tier
                  WHEN 'TIER 1' THEN 18
                  WHEN 'TIER 2' THEN 12
                  WHEN 'TIER 3' THEN 6
                  WHEN 'TIER 4' THEN 2
                  ELSE 0
                END AS tier_score,

                -- Budget fit score: penalise if too expensive relative to remaining
                CASE
                  WHEN a.auction_value > (250 - rs.total_spent) * 0.7 THEN -25
                  WHEN a.auction_value > (250 - rs.total_spent) * 0.5 THEN -12
                  WHEN a.auction_value <= SAFE_DIVIDE(250 - rs.total_spent, GREATEST(36 - rs.total_drafted, 1)) * 0.6
                    AND a.auction_value <= 20 THEN 8
                  ELSE 0
                END AS budget_score

              FROM available a
              CROSS JOIN roster_summary rs
              WHERE a.auction_value <= (250 - rs.total_spent)
            )

            SELECT
              player_name,
              position,
              rank,
              auction_value,
              tier,
              tier_desc,
              ranking_note,
              age,
              remaining,
              avg_bid,
              have_qb, have_rb, have_wr, have_te,
              (need_score + age_score + tier_score + budget_score) AS total_score,
              need_score,
              age_score,
              tier_score,
              budget_score,
              -- Bucket assignment
              CASE
                WHEN auction_value <= 8 THEN 'stash'
                WHEN (need_score + age_score + tier_score + budget_score) >= 30 THEN 'priority'
                ELSE 'value'
              END AS bucket
            FROM scored
            ORDER BY bucket, total_score DESC, rank ASC
          `,
        });
        res.status(200).json({ targets: rows });
      } catch (err) {
        console.error('Targets load error:', err);
        res.status(500).json({ error: 'Failed to load targets', message: err.message });
      }
      return;
    }

    // ?eval=<gsis_id>  →  season + weekly stats for Player Eval tab
    if (req.query.eval) {
      const gsis_id = String(req.query.eval);
      try {
        const [[seasonRows], [weeklyRows]] = await Promise.all([

          // Season aggregates: player_stats + snap_counts + ff_opportunity
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
                  AVG(rec_attempt / NULLIF(rec_attempt_team, 0))                  AS target_share,
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

          // Weekly fantasy points for bar chart
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
        ]);

        res.status(200).json({
          season: seasonRows[0] || {},
          weekly: weeklyRows,
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
    const pick_id = req.query.pick_id;
    if (!pick_id) { res.status(400).json({ error: 'Missing pick_id' }); return; }
    try {
      await bq.query({
        query: `DELETE FROM \`${PROJECT}.${DATASET}.${TABLE}\` WHERE pick_id = @pick_id`,
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
        query: `SELECT pick_id FROM \`${PROJECT}.${DATASET}.${TABLE}\` WHERE LOWER(player_name) = LOWER(@name) LIMIT 1`,
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
      const pick_id         = String(body.pick_id).replace(/'/g,"''");
      const drafted_at      = body.drafted_at || new Date().toISOString();
      const player_name     = String(body.player_name).replace(/'/g,"''");
      const position        = String(body.position).replace(/'/g,"''");
      const age             = parseInt(body.age) || 0;
      const salary          = parseFloat(body.salary);
      const contract_yrs    = parseInt(body.contract_yrs);
      const discount_pct    = parseFloat(body.discount_pct) || 0;
      const cap_hit         = parseFloat(body.cap_hit);
      const total_commitment= parseFloat(body.total_commitment);

      await bq.query({
        query: `
          INSERT INTO \`${PROJECT}.${DATASET}.${TABLE}\`
            (pick_id, drafted_at, player_name, position, age, salary,
             contract_yrs, discount_pct, cap_hit, total_commitment)
          VALUES (
            '${pick_id}',
            TIMESTAMP('${drafted_at}'),
            '${player_name}',
            '${position}',
            ${age},
            CAST(${salary} AS NUMERIC),
            ${contract_yrs},
            CAST(${discount_pct} AS NUMERIC),
            CAST(${cap_hit} AS NUMERIC),
            CAST(${total_commitment} AS NUMERIC)
          )
        `,
      });
      console.log(`Inserted: ${player_name} (${position}) $${salary}/${contract_yrs}yr`);
      res.status(200).json({ success: true, pick_id: body.pick_id });
    } catch (err) {
      console.error('Insert error:', err);
      res.status(500).json({ error: 'Internal server error', message: err.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
