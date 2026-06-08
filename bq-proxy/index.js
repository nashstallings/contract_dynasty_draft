const { BigQuery } = require('@google-cloud/bigquery');

const bq = new BigQuery();
const DATASET = 'dynasty_tycoon';
const TABLE = 'draft_picks';

exports.draftPicksInsert = async (req, res) => {
  // CORS — allow your HTML file to call this from any origin (or lock to a specific domain)
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body;

    // Validate required fields
    const required = ['pick_id', 'player_name', 'position', 'salary', 'contract_yrs'];
    for (const field of required) {
      if (body[field] === undefined || body[field] === null || body[field] === '') {
        res.status(400).json({ error: `Missing required field: ${field}` });
        return;
      }
    }

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

    console.log(`Inserted pick: ${row.player_name} (${row.position}) $${row.salary}/${row.contract_yrs}yr`);
    res.status(200).json({ success: true, pick_id: row.pick_id });

  } catch (err) {
    console.error('Insert error:', err);
    // BigQuery insert errors come back as insertErrors array
    if (err.name === 'PartialFailureError') {
      res.status(422).json({ error: 'BigQuery insert failed', details: err.errors });
    } else {
      res.status(500).json({ error: 'Internal server error', message: err.message });
    }
  }
};
