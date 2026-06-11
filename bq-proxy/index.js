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

  // ── GET — load all picks on page load ────────────────────────────────────
  if (req.method === 'GET') {
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

  // ── DELETE — remove a pick by pick_id ────────────────────────────────────
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

  // ── POST — insert a new pick ──────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body;
    const required = ['pick_id', 'player_name', 'position', 'salary', 'contract_yrs'];
    for (const f of required) {
      if (body[f] === undefined || body[f] === null || body[f] === '') {
        res.status(400).json({ error: `Missing required field: ${f}` }); return;
      }
    }

    // Duplicate check — case-insensitive player name
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
