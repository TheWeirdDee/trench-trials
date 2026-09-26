/**
 * Resolves a Live round from real Nansen 5m OHLCV — see docs/LIVE-REAL-RUNBOOK.md.
 *
 * Without --confirm this is a dry run: it prints the round's schedule, whether real
 * resolution is allowed yet, and the call budget, and makes zero Nansen requests.
 *
 * Usage:
 *   npm run resolve:live [-- <roundId>]                    # plan only
 *   npm run resolve:live -- <roundId> --confirm            # query OHLCV and resolve
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
// Real runs keep every raw Nansen response as private, gitignored evidence (src/lib/nansen/client.ts).
if (process.argv.includes('--confirm')) process.env.NANSEN_RAW_RESPONSE_DIR ??= `${process.cwd()}/.nansen-raw`;

import { getPool } from '../src/lib/db';
import { LIVE_RESOLVE_MIN_DATA_DELAY_SECONDS } from '../src/lib/domain/live';
import {
  DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_RESOLVE,
  MAX_NANSEN_CALLS_PER_LIVE_RESOLVE_ENV,
  readNansenCallBudget,
} from '../src/lib/nansen/budget';
import { HISTORICAL_OHLCV_PATH } from '../src/lib/nansen/client';
import { getCurrentLiveRound, resolveLiveRound } from '../src/lib/repo/live';

/** Observed cost per Historical Token OHLCV request (DATA-CONTRACT.md §1.2). */
const CREDITS_PER_OHLCV_CALL = 5;

async function main() {
  const confirm = process.argv.includes('--confirm');
  const roundIdArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const pool = getPool();

  let roundId = roundIdArg;
  if (!roundId) {
    const current = await getCurrentLiveRound();
    if (!current) {
      console.log('No live round found.');
      return;
    }
    roundId = current.id;
  }

  const roundRes = await pool.query<{
    status: string;
    chain: string;
    measurement_start_at: Date;
    measurement_end_at: Date;
  }>(`SELECT status, chain, measurement_start_at, measurement_end_at FROM rounds WHERE id = $1 AND mode = 'live'`, [
    roundId,
  ]);
  const round = roundRes.rows[0];
  if (!round) {
    console.error(`Live round ${roundId} not found.`);
    process.exitCode = 1;
    return;
  }
  const assets = await pool.query<{ slot: string; token_address: string }>(
    'SELECT slot, token_address FROM round_assets WHERE round_id = $1 ORDER BY slot',
    [roundId],
  );

  const now = new Date();
  const end = round.measurement_end_at;
  const notBefore = new Date(end.getTime() + LIVE_RESOLVE_MIN_DATA_DELAY_SECONDS * 1000);
  const retryDeadline = new Date(end.getTime() + 6 * 3600 * 1000);
  const maxCalls = readNansenCallBudget(MAX_NANSEN_CALLS_PER_LIVE_RESOLVE_ENV, DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_RESOLVE);

  console.log('Live resolve plan');
  console.log(`  round:                ${roundId} (${round.status}, ${round.chain})`);
  console.log(`  measurement start:    ${round.measurement_start_at.toISOString()}`);
  console.log(`  measurement end:      ${end.toISOString()}`);
  console.log(`  real data not before: ${notBefore.toISOString()}`);
  console.log(`  retry deadline:       ${retryDeadline.toISOString()} (INVALID after this)`);
  console.log(`  now:                  ${now.toISOString()}`);
  console.log(`  endpoint:             POST ${HISTORICAL_OHLCV_PATH} (5m, one per slot)`);
  for (const a of assets.rows) {
    console.log(
      `    slot ${a.slot}: ${JSON.stringify({
        chain: round.chain,
        token_address: a.token_address,
        date_from: round.measurement_start_at.toISOString().slice(0, 10),
        as_of_date: end.toISOString().slice(0, 10),
        timeframe: '5m',
      })}`,
    );
  }
  console.log(`  required requests:    ${assets.rows.length} (~${assets.rows.length * CREDITS_PER_OHLCV_CALL} credits)`);
  console.log(`  max network requests: ${maxCalls} (worst case ~${maxCalls * CREDITS_PER_OHLCV_CALL} credits)`);
  if (['resolved', 'invalid'].includes(round.status)) {
    console.log(`  → round is already ${round.status}; resolving makes no Nansen request.`);
  } else if (now < notBefore) {
    console.log('  → too early: resolving now makes no Nansen request.');
  }

  if (!confirm) {
    console.log('\nDry run: zero Nansen requests made. Re-run with --confirm to resolve.');
    return;
  }

  console.log(`\nResolving live round ${roundId}...`);
  const result = await resolveLiveRound(roundId);

  if (result.ok) {
    console.log('✅ Round resolved successfully!');
    console.log('Manifest:', JSON.stringify(result.manifest, null, 2));
    if (result.nansen) console.log(`Nansen: ${JSON.stringify(result.nansen)}`);
  } else {
    console.log(`⏳ Resolution pending / failed: ${result.error}`, result);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
