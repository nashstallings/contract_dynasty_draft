const { BigQuery } = require('@google-cloud/bigquery');

const bq = new BigQuery();
const DATASET   = 'dynasty_tycoon';
const TABLE     = 'draft_picks';
const NOM_TABLE = 'nominations';
const PROJECT   = 'ff-python-api';

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

    // ?nominations=1  →  players currently on the block, shared across all devices
    if (req.query.nominations === '1') {
      try {
        const [rows] = await bq.query({
          query: `SELECT * FROM \`${PROJECT}.${DATASET}.${NOM_TABLE}\` ORDER BY updated_at ASC`,
        });
        res.status(200).json({ nominations: rows });
      } catch (err) {
        console.error('Nominations load error:', err);
        res.status(500).json({ error: 'Failed to load nominations', message: err.message });
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
    if (req.query.nomination_id) {
      const nomination_id = req.query.nomination_id;
      try {
        await bq.query({
          query: `DELETE FROM \`${PROJECT}.${DATASET}.${NOM_TABLE}\` WHERE nomination_id = @nomination_id`,
          params: { nomination_id: String(nomination_id) },
        });
        console.log(`Deleted nomination: ${nomination_id}`);
        res.status(200).json({ success: true, nomination_id });
      } catch (err) {
        console.error('Nomination delete error:', err);
        res.status(500).json({ error: 'Failed to delete nomination', message: err.message });
      }
      return;
    }

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
    // ?nomination=1  →  upsert a live nomination (shared board, keyed by nomination_id)
    if (req.query.nomination === '1') {
      const body = req.body;
      const required = ['nomination_id', 'player_name', 'position'];
      for (const f of required) {
        if (body[f] === undefined || body[f] === null || body[f] === '') {
          res.status(400).json({ error: `Missing required field: ${f}` }); return;
        }
      }
      try {
        await bq.query({
          query: `
            MERGE \`${PROJECT}.${DATASET}.${NOM_TABLE}\` T
            USING (SELECT @nomination_id AS nomination_id) S
            ON T.nomination_id = S.nomination_id
            WHEN MATCHED THEN UPDATE SET
              bid = @bid, owner = @owner, contract_yrs = @contract_yrs, updated_at = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT
              (nomination_id, player_name, position, age, latest_team, gsis_id, bid, owner, contract_yrs, updated_at)
              VALUES (@nomination_id, @player_name, @position, @age, @latest_team, @gsis_id, @bid, @owner, @contract_yrs, CURRENT_TIMESTAMP())
          `,
          params: {
            nomination_id: String(body.nomination_id),
            player_name: String(body.player_name),
            position: String(body.position),
            age: body.age != null ? parseInt(body.age) : null,
            latest_team: body.latest_team != null ? String(body.latest_team) : null,
            gsis_id: body.gsis_id != null ? String(body.gsis_id) : null,
            bid: parseFloat(body.bid) || 0,
            owner: String(body.owner || 'NashStallings'),
            contract_yrs: parseInt(body.contract_yrs) || 1,
          },
          types: { age: 'INT64', bid: 'NUMERIC', contract_yrs: 'INT64' },
        });
        res.status(200).json({ success: true, nomination_id: body.nomination_id });
      } catch (err) {
        console.error('Nomination upsert error:', err);
        res.status(500).json({ error: 'Failed to save nomination', message: err.message });
      }
      return;
    }

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
      const pick_id         = String(body.pick_id);
      const drafted_at      = body.drafted_at || new Date().toISOString();
      const owner           = String(body.owner || 'NashStallings');
      const player_name     = String(body.player_name);
      const position        = String(body.position);
      const age             = parseInt(body.age) || 0;
      const salary          = parseFloat(body.salary);
      const contract_yrs    = parseInt(body.contract_yrs);
      const discount_pct    = parseFloat(body.discount_pct) || 0;
      const cap_hit         = parseFloat(body.cap_hit);
      const total_commitment= parseFloat(body.total_commitment);

      await bq.query({
        query: `
          INSERT INTO \`${PROJECT}.${DATASET}.${TABLE}\`
            (pick_id, drafted_at, owner, player_name, position, age, salary,
             contract_yrs, discount_pct, cap_hit, total_commitment)
          VALUES (
            @pick_id,
            TIMESTAMP(@drafted_at),
            @owner,
            @player_name,
            @position,
            @age,
            CAST(@salary AS NUMERIC),
            @contract_yrs,
            CAST(@discount_pct AS NUMERIC),
            CAST(@cap_hit AS NUMERIC),
            CAST(@total_commitment AS NUMERIC)
          )
        `,
        params: {
          pick_id, drafted_at, owner, player_name, position, age,
          salary, contract_yrs, discount_pct, cap_hit, total_commitment,
        },
        types: { age: 'INT64', salary: 'NUMERIC', contract_yrs: 'INT64', discount_pct: 'NUMERIC', cap_hit: 'NUMERIC', total_commitment: 'NUMERIC' },
      });
      console.log(`Inserted: ${player_name} (${position}) $${salary}/${contract_yrs}yr → ${owner}`);
      res.status(200).json({ success: true, pick_id: body.pick_id });
    } catch (err) {
      console.error('Insert error:', err);
      res.status(500).json({ error: 'Internal server error', message: err.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
