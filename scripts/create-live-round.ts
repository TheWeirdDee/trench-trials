/**
 * Creates exactly one real Live round from Nansen — see docs/LIVE-REAL-RUNBOOK.md.
 *
 * Without --confirm this is a dry run: it prints the exact requests, the call budget
 * and the active-round check, and makes zero Nansen requests.
 *
 * Usage:
 *   npm run create:live                                    # plan only, zero Nansen requests
 *   npm run create:live -- --confirm                       # create one real Live round
 *   npm run create:live -- --confirm --to-date=YYYY-MM-DD --chain=solana
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
// Real runs keep every raw Nansen response as private, gitignored evidence (src/lib/nansen/client.ts).
if (process.argv.includes('--confirm')) process.env.NANSEN_RAW_RESPONSE_DIR ??= `${process.cwd()}/.nansen-raw`;

import { getPool } from '../src/lib/db';
import { LIVE_CREATE_REQUIRED_NANSEN_CALLS } from '../src/lib/nansen/budget';
import { CURRENT_SCREENER_PATH } from '../src/lib/nansen/client';
import { findActiveLiveRound } from '../src/lib/repo/live';
import {
  buildLiveScreenerRequests,
  createRealLiveSnapshot,
  LiveCreateError,
  resolveLiveCreateBudget,
} from '../src/lib/services/liveSnapshot';

/** Documented cost per current Token Screener request (Nansen pricing docs). */
const CREDITS_PER_SCREENER_CALL = 1;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const chain = flag('chain') ?? 'solana';
  const toDateStr = flag('to-date') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDateStr)) {
    throw new Error(`--to-date must be YYYY-MM-DD (got "${toDateStr}")`);
  }

  const maxCalls = resolveLiveCreateBudget();
  const active = await findActiveLiveRound();

  console.log('Live create plan');
  console.log(`  chain:                ${chain}`);
  console.log(`  snapshot date (UTC):  ${toDateStr} (current screener: data as of the request)`);
  console.log(`  endpoint:             POST ${CURRENT_SCREENER_PATH}`);
  for (const [i, req] of buildLiveScreenerRequests(chain).entries()) {
    console.log(`  request ${i + 1}:            ${JSON.stringify(req)}`);
  }
  console.log(
    `  required requests:    ${LIVE_CREATE_REQUIRED_NANSEN_CALLS} (~${LIVE_CREATE_REQUIRED_NANSEN_CALLS * CREDITS_PER_SCREENER_CALL} credits)`,
  );
  console.log(`  max network requests: ${maxCalls} (worst case ~${maxCalls * CREDITS_PER_SCREENER_CALL} credits)`);
  console.log(`  NANSEN_API_KEY set:   ${process.env.NANSEN_API_KEY ? 'yes' : 'NO'}`);
  console.log(
    `  active Live round:    ${active ? `${active.id} (${active.status}) — creation will be refused` : 'none'}`,
  );

  if (!confirm) {
    console.log('\nDry run: zero Nansen requests made. Re-run with --confirm to create the round.');
    return;
  }
  if (active) {
    console.error('\nRefusing: resolve or invalidate the active Live round first.');
    process.exitCode = 1;
    return;
  }

  console.log('\nCreating one real Live round...');
  try {
    const result = await createRealLiveSnapshot({ chain, toDateStr });

    console.log('✅ Live round created successfully!');
    console.log(`Round ID: ${result.roundId}`);
    console.log(`Commitment Hash: ${result.commitmentHash}`);
    console.log(`Candidate Symbols: ${result.candidateSymbols.join(', ')}`);
    console.log(`Snapshot Published (UTC): ${result.schedule.snapshotPublishedAt.toISOString()}`);
    console.log(`Entry Closes (UTC): ${result.schedule.entryCloseAt.toISOString()}`);
    console.log(`Measurement Starts (UTC): ${result.schedule.measurementStartAt.toISOString()}`);
    console.log(`Measurement Ends (UTC): ${result.schedule.measurementEndAt.toISOString()}`);
    console.log(`Latest Attempt Start (UTC): ${result.schedule.latestAttemptStartAt.toISOString()}`);
    console.log(`Nansen: ${JSON.stringify(result.nansen)}`);
    for (const [idx, meta] of result.nansenMeta.entries()) {
      console.log(
        `Call ${idx + 1}: reqId=${meta.requestId} attempts=${meta.attempts} creditsUsed=${meta.creditsUsed} creditsRemaining=${meta.creditsRemaining} sha256=${meta.responseSha256.slice(0, 16)}...`,
      );
    }
  } catch (err) {
    if (err instanceof LiveCreateError) {
      console.error(`❌ Live creation failed: ${err.code} — ${err.message}`);
      console.error(`Nansen: ${JSON.stringify(err.nansen)}`);
    } else {
      console.error('❌ Failed to create Live round:', err);
    }
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
