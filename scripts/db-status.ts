import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { getPool } from '../src/lib/db';

async function main() {
  const pool = getPool();
  const round = await pool.query('SELECT * FROM rounds WHERE id = $1', ['df397565-caab-4208-8737-9b1d208177d7']);
  console.log('ROUND:', JSON.stringify(round.rows[0], null, 2));

  const assets = await pool.query('SELECT * FROM round_assets WHERE round_id = $1 ORDER BY slot ASC', ['df397565-caab-4208-8737-9b1d208177d7']);
  console.log('ASSETS:', JSON.stringify(assets.rows, null, 2));

  const receipts = await pool.query('SELECT id, round_id, endpoint, request_params, retrieved_at, response_sha256, schema_version, purpose FROM source_receipts WHERE round_id = $1', ['df397565-caab-4208-8737-9b1d208177d7']);
  console.log('RECEIPTS:', JSON.stringify(receipts.rows, null, 2));

  const roundsCount = await pool.query('SELECT COUNT(*) FROM rounds');
  const assetsCount = await pool.query('SELECT COUNT(*) FROM round_assets');
  const receiptsCount = await pool.query('SELECT COUNT(*) FROM source_receipts');
  const dailyCount = await pool.query('SELECT COUNT(*) FROM daily_challenges');
  const playersCount = await pool.query('SELECT COUNT(*) FROM players');
  const attemptsCount = await pool.query('SELECT COUNT(*) FROM attempts');
  const eventsCount = await pool.query('SELECT COUNT(*) FROM decision_events');

  if (Number(playersCount.rows[0].count) > 0) {
    const players = await pool.query('SELECT * FROM players');
    console.log('PLAYERS_ROWS:', players.rows);
  }

  const apiCallLogCount = await pool.query('SELECT COUNT(*) FROM api_call_log');
  const allRounds = await pool.query('SELECT id, mode, status, repeat_of FROM rounds');
  console.log('ALL_ROUNDS:', allRounds.rows);

  console.log('COUNTS:', {
    rounds: Number(roundsCount.rows[0].count),
    round_assets: Number(assetsCount.rows[0].count),
    source_receipts: Number(receiptsCount.rows[0].count),
    daily_challenges: Number(dailyCount.rows[0].count),
    players: Number(playersCount.rows[0].count),
    attempts: Number(attemptsCount.rows[0].count),
    decision_events: Number(eventsCount.rows[0].count),
    api_call_log: Number(apiCallLogCount.rows[0].count),
  });
  await pool.end();
}
main().catch(console.error);
