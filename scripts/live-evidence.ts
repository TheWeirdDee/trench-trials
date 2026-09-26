/**
 * Read-only evidence report for one Live round — see docs/LIVE-REAL-RUNBOOK.md.
 * Prints the round state, assets, source receipts and the api_call_log rows of its
 * create and resolve operations, then cross-checks them. Zero Nansen requests, zero writes.
 *
 * Usage:
 *   npx tsx scripts/live-evidence.ts [<roundId>] [--since=<ISO timestamp taken before create>]
 *
 * Without --since, create rows are matched from 15 minutes before snapshot publication.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getPool } from '../src/lib/db';
import { LIVE_CREATE_REQUIRED_NANSEN_CALLS } from '../src/lib/nansen/budget';

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

interface CallRow {
  purpose: string;
  request_timestamp: Date;
  endpoint: string;
  http_status: number;
  is_success: boolean;
  is_cache_hit: boolean;
  nansen_request_id: string | null;
  credits_used: number | null;
  credits_remaining: number | null;
  error_code: string | null;
}

async function main() {
  const pool = getPool();
  const roundIdArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const roundRes = roundIdArg
    ? await pool.query(`SELECT * FROM rounds WHERE id = $1 AND mode = 'live'`, [roundIdArg])
    : await pool.query(`SELECT * FROM rounds WHERE mode = 'live' ORDER BY created_at DESC LIMIT 1`);
  const round = roundRes.rows[0];
  if (!round) {
    console.log('No live round found.');
    return;
  }

  const published: Date = round.snapshot_published_at;
  const since = flag('since') ? new Date(flag('since')!) : new Date(published.getTime() - 15 * 60 * 1000);
  const problems: string[] = [];

  console.log('ROUND');
  console.log(`  id:                  ${round.id}`);
  console.log(`  status:              ${round.status}${round.invalid_reason ? ` (${round.invalid_reason})` : ''}`);
  console.log(`  chain:               ${round.chain}`);
  console.log(`  snapshot published:  ${published.toISOString()}`);
  console.log(`  entry close:         ${round.entry_close_at.toISOString()}`);
  console.log(`  measurement:         ${round.measurement_start_at.toISOString()} → ${round.measurement_end_at.toISOString()}`);
  console.log(`  initial commitment:  ${round.initial_commitment_hash}`);
  console.log(`  resolution commit.:  ${round.resolution_commitment_hash ?? '—'}`);
  if (round.resolution_manifest) {
    console.log(`  winning slots:       ${round.resolution_manifest.winning_slots.join(', ')}`);
  }

  const assets = await pool.query(
    `SELECT slot, token_symbol, token_address, entry_price, exit_price, return_ratio
     FROM round_assets WHERE round_id = $1 ORDER BY slot`,
    [round.id],
  );
  console.log('\nASSETS');
  for (const a of assets.rows) {
    console.log(
      `  ${a.slot} ${a.token_symbol} ${a.token_address} entry=${a.entry_price ?? '—'} exit=${a.exit_price ?? '—'} return=${a.return_ratio ?? '—'}`,
    );
  }

  const receipts = await pool.query<{
    purpose: string;
    endpoint: string;
    request_id: string | null;
    credits_used: number | null;
    response_sha256: string;
    retrieved_at: Date;
  }>(
    `SELECT purpose, endpoint, request_id, credits_used, response_sha256, retrieved_at
     FROM source_receipts WHERE round_id = $1 ORDER BY retrieved_at, created_at`,
    [round.id],
  );
  console.log('\nSOURCE RECEIPTS');
  for (const r of receipts.rows) {
    console.log(
      `  ${r.purpose.padEnd(13)} ${r.endpoint} req=${r.request_id ?? '—'} credits=${r.credits_used ?? '—'} sha256=${r.response_sha256.slice(0, 16)}… at ${r.retrieved_at.toISOString()}`,
    );
  }

  const calls = await pool.query<CallRow>(
    `SELECT purpose, request_timestamp, endpoint, http_status, is_success, is_cache_hit,
            nansen_request_id, credits_used, credits_remaining, error_code
     FROM api_call_log
     WHERE (purpose = 'live_create' AND request_timestamp >= $1 AND request_timestamp <= $2)
        OR purpose = $3
     ORDER BY request_timestamp`,
    [since, published, `live_resolve:${round.id}`],
  );
  console.log(`\nAPI CALL LOG (create rows since ${since.toISOString()})`);
  for (const c of calls.rows) {
    console.log(
      `  ${c.request_timestamp.toISOString()} ${c.purpose} ${c.endpoint} status=${c.http_status} ok=${c.is_success} cache=${c.is_cache_hit} req=${c.nansen_request_id ?? '—'} used=${c.credits_used ?? '—'} remaining=${c.credits_remaining ?? '—'}${c.error_code ? ` error=${c.error_code}` : ''}`,
    );
  }

  console.log('\nTOTALS');
  for (const purpose of new Set(calls.rows.map((c) => c.purpose))) {
    const rows = calls.rows.filter((c) => c.purpose === purpose);
    const network = rows.filter((c) => !c.is_cache_hit);
    const remaining = network.map((c) => c.credits_remaining).filter((v): v is number => v !== null);
    console.log(
      `  ${purpose}: network=${network.length} succeeded=${network.filter((c) => c.is_success).length} failed=${network.filter((c) => !c.is_success).length} cache_hits=${rows.length - network.length} credits_used=${network.reduce((s, c) => s + (c.credits_used ?? 0), 0)} last_remaining=${remaining.at(-1) ?? '—'}`,
    );
  }

  // Cross-checks: every receipt must trace to a served, logged request.
  const servedIds = new Set(calls.rows.filter((c) => c.is_success && !c.is_cache_hit).map((c) => c.nansen_request_id));
  const snapshotReceipts = receipts.rows.filter((r) => r.purpose === 'live_snapshot');
  if (snapshotReceipts.length !== LIVE_CREATE_REQUIRED_NANSEN_CALLS) {
    problems.push(`expected ${LIVE_CREATE_REQUIRED_NANSEN_CALLS} live_snapshot receipts, found ${snapshotReceipts.length}`);
  }
  for (const r of receipts.rows) {
    if (!r.request_id) problems.push(`${r.purpose} receipt ${r.response_sha256.slice(0, 16)}… has no request_id`);
    else if (!servedIds.has(r.request_id)) problems.push(`receipt request ${r.request_id} has no successful api_call_log row`);
  }
  if (round.status === 'resolved') {
    const slots = new Set(assets.rows.map((a) => a.slot));
    const resolutionReceipts = receipts.rows.filter((r) => r.purpose === 'resolution');
    if (resolutionReceipts.length < slots.size) {
      problems.push(`expected ≥${slots.size} resolution receipts, found ${resolutionReceipts.length}`);
    }
  }

  console.log(problems.length === 0 ? '\nCHECKS: OK' : `\nCHECKS: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (problems.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
