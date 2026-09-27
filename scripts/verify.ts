/**
 * npm run verify
 *
 * Independently recomputes prices-to-returns, ties, winner determination, switch
 * impact and Ticker Tax aggregation, and checks every round's commitment hash. Per
 * PRD §14, this uses its OWN from-scratch implementation of the formulas below
 * (deliberately not importing src/lib/domain/*) so it can catch a regression in that
 * shared module rather than just checking it against itself.
 *
 * This proves internal consistency — that stored results are reproducible from
 * stored inputs and that commitments are not tampered with. It does NOT prove
 * Nansen's underlying data was correct, and does not re-fetch anything from Nansen.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { createHash } from 'node:crypto';
import { Pool } from 'pg';

const TIE_TOLERANCE_RATIO = 0.0001; // 0.01pp, per PRD §7

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
function independentReturn(entryPrice: number, exitPrice: number): number {
  return exitPrice / entryPrice - 1;
}
function independentWinningSlots(returns: Record<string, number>): string[] {
  const entries = Object.entries(returns);
  const max = Math.max(...entries.map(([, r]) => r));
  return entries.filter(([, r]) => max - r <= TIE_TOLERANCE_RATIO).map(([slot]) => slot);
}
function independentSwitchImpactPp(rBlind: number, rFinal: number): number {
  return 100 * (rFinal - rBlind);
}
function independentTickerTaxPp(rBlind: number, rFinal: number): number {
  return 100 * (rBlind - rFinal);
}

let checks = 0;
let failures = 0;

function check(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

async function main() {
  // DB_SCHEMA (a plain identifier) points the checks at an isolated schema, e.g. a fresh demo copy.
  const schema = process.env.DB_SCHEMA;
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA must be a plain lowercase identifier');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });

  // --- 1. Commitment verification for every round ---
  const rounds = await pool.query<{
    id: string;
    mode: string;
    status: string;
    measurement_start_at: Date | null;
    measurement_end_at: Date | null;
    initial_manifest: any;
    initial_nonce: string;
    initial_commitment_hash: string;
    resolution_manifest: any;
    resolution_nonce: string | null;
    resolution_commitment_hash: string | null;
  }>('SELECT id, mode, status, measurement_start_at, measurement_end_at, initial_manifest, initial_nonce, initial_commitment_hash, resolution_manifest, resolution_nonce, resolution_commitment_hash FROM rounds');

  for (const r of rounds.rows) {
    const recomputedInitial = sha256Hex(canonicalize({ manifest: r.initial_manifest, nonce: r.initial_nonce }));
    check(recomputedInitial === r.initial_commitment_hash, `initial commitment mismatch for round ${r.id}`);

    if (r.mode === 'live' && r.status !== 'invalid' && r.measurement_start_at && r.measurement_end_at) {
      const start = new Date(r.measurement_start_at);
      const end = new Date(r.measurement_end_at);
      const durationHours = (end.getTime() - start.getTime()) / (3600 * 1000);
      check(
        Math.abs(durationHours - 24) < 1e-4,
        `Live round ${r.id} measurement horizon is not 24 hours: ${durationHours}h`,
      );

      // Check 5m candle boundary alignment
      check(
        start.getUTCMinutes() % 5 === 0 && start.getUTCSeconds() === 0 && start.getUTCMilliseconds() === 0,
        `Live round ${r.id} measurement_start_at is not an exact 5m candle boundary: ${start.toISOString()}`,
      );
      check(
        end.getUTCMinutes() % 5 === 0 && end.getUTCSeconds() === 0 && end.getUTCMilliseconds() === 0,
        `Live round ${r.id} measurement_end_at is not an exact 5m candle boundary: ${end.toISOString()}`,
      );

      // Check committed price policy
      const manifest = r.initial_manifest as any;
      if (manifest?.price_policy) {
        check(manifest.price_policy.timeframe === '5m', `Live round ${r.id} committed timeframe is not 5m`);
        check(
          manifest.price_policy.entry_interval_start === start.toISOString(),
          `Live round ${r.id} entry_interval_start mismatch`,
        );
        check(
          manifest.price_policy.exit_interval_start === end.toISOString(),
          `Live round ${r.id} exit_interval_start mismatch`,
        );
      }
    }

    if (r.status === 'resolved' && r.resolution_manifest && r.resolution_nonce) {
      const recomputedResolution = sha256Hex(
        canonicalize({ manifest: r.resolution_manifest, nonce: r.resolution_nonce }),
      );
      check(
        recomputedResolution === r.resolution_commitment_hash,
        `resolution commitment mismatch for round ${r.id}`,
      );
    }

    // Source receipts exist for round
    const receipts = await pool.query<{ count: string }>(
      'SELECT count(*) as count FROM source_receipts WHERE round_id = $1',
      [r.id],
    );
    check(Number(receipts.rows[0]?.count ?? 0) > 0, `round ${r.id} has no source receipts`);
  }
  console.log(`Checked ${rounds.rows.length} round commitment(s) and provenance.`);

  // --- 1b. Eligibility: only leak-free rounds approved under the current policy may be player-facing ---
  const hasEligibility = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'rounds' AND column_name = 'rebuilt_from'`,
  );
  if (hasEligibility.rowCount) {
    const elig = await pool.query<{
      id: string; mode: string; status: string; round_forge_version: number; eligibility_status: string;
      eligibility_policy_version: number | null; rebuilt_from: string | null; ancestor_status: string | null;
    }>(
      `SELECT r.id, r.mode, r.status, r.round_forge_version, r.eligibility_status, r.eligibility_policy_version,
              r.rebuilt_from, a.eligibility_status AS ancestor_status
       FROM rounds r LEFT JOIN rounds a ON a.id = r.rebuilt_from ORDER BY r.mode, r.cutoff`,
    );
    const counts: Record<string, number> = {};
    for (const r of elig.rows) {
      const kind = r.rebuilt_from ? 'rebuilt' : 'original';
      counts[`${r.mode}/${kind}/${r.eligibility_status}`] = (counts[`${r.mode}/${kind}/${r.eligibility_status}`] ?? 0) + 1;
      if (r.eligibility_status !== 'approved') continue;
      // Rounds forged before v4 read the screener after their cutoff (F1): never approvable as stored.
      check(r.mode !== 'replay' || r.round_forge_version >= 4, `approved Replay round ${r.id} was forged before v4 (F1 leakage)`);
      check(r.status !== 'invalid', `approved round ${r.id} is invalid`);
      if (r.rebuilt_from) check(r.ancestor_status !== 'approved', `rebuilt round ${r.id} and its ancestor ${r.rebuilt_from} are both approved`);
    }
    console.log(`Eligibility: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    const daily = await pool.query<{ utc_date: string; round_id: string; eligibility_status: string }>(
      `SELECT dc.utc_date::text, dc.round_id, r.eligibility_status FROM daily_challenges dc JOIN rounds r ON r.id = dc.round_id
       WHERE dc.utc_date = (now() AT TIME ZONE 'UTC')::date`,
    );
    for (const d of daily.rows) {
      console.log(`Today's Daily ${d.utc_date}: ${d.round_id} (${d.eligibility_status})`);
      check(d.eligibility_status === 'approved', `today's Daily ${d.utc_date} points at a round that is not approved`);
    }
  } else {
    console.log('Eligibility columns not present in this schema: eligibility checks skipped.');
  }

  // --- 2. Return + winner recomputation for resolved/ready round assets ---
  for (const r of rounds.rows) {
    if (r.status === 'draft' || r.status === 'open' || r.status === 'resolving' || r.status === 'invalid') {
      console.log(`Round ${r.id} (${r.mode}, status=${r.status}): open/pending/invalid, skipping price recomputation.`);
      continue;
    }

    const assets = await pool.query<{ slot: string; entry_price: string; exit_price: string; return_ratio: string }>(
      'SELECT slot, entry_price, exit_price, return_ratio FROM round_assets WHERE round_id = $1',
      [r.id],
    );
    if (assets.rows.length === 0) continue;

    const returns: Record<string, number> = {};
    for (const a of assets.rows) {
      const entryPrice = Number(a.entry_price);
      const exitPrice = Number(a.exit_price);
      check(Number.isFinite(entryPrice) && entryPrice > 0, `round ${r.id} slot ${a.slot} entry_price is not positive finite`);
      check(Number.isFinite(exitPrice) && exitPrice > 0, `round ${r.id} slot ${a.slot} exit_price is not positive finite`);

      const recomputedReturn = independentReturn(entryPrice, exitPrice);
      returns[a.slot] = recomputedReturn;
      check(
        Math.abs(recomputedReturn - Number(a.return_ratio)) < 1e-9,
        `return mismatch round ${r.id} slot ${a.slot}: stored=${a.return_ratio} recomputed=${recomputedReturn}`,
      );
    }
    const winners = independentWinningSlots(returns);
    console.log(
      `Round ${r.id}: recomputed returns ${JSON.stringify(
        Object.fromEntries(Object.entries(returns).map(([s, v]) => [s, (v * 100).toFixed(4) + '%'])),
      )} -> winner(s): ${winners.join(', ')}`,
    );
  }

  // --- 3. Attempt invariants + switch impact / Ticker Tax recomputation ---
  const attempts = await pool.query<{
    id: string;
    round_id: string;
    blind_slot: string | null;
    final_slot: string | null;
    final_action_type: string | null;
    is_repeat: boolean;
  }>(
    `SELECT a.id, a.round_id, a.blind_slot, a.final_slot, a.final_action_type, a.is_repeat
     FROM attempts a
     JOIN rounds r ON r.id = a.round_id
     WHERE a.stage = 'final_locked' AND r.status IN ('ready', 'resolved')`,
  );

  const taxValues: number[] = [];
  const assetCache = new Map<string, Record<string, number>>();

  for (const a of attempts.rows) {
    check(
      Boolean(a.blind_slot && a.final_slot && a.final_action_type),
      `attempt ${a.id} is final_locked but missing blind/final/action fields`,
    );
    if (!a.blind_slot || !a.final_slot || !a.final_action_type) continue;

    check(
      !(a.final_action_type === 'stick' && a.blind_slot !== a.final_slot),
      `attempt ${a.id} marked 'stick' but blind_slot != final_slot`,
    );
    check(
      !(a.final_action_type === 'switch' && a.blind_slot === a.final_slot),
      `attempt ${a.id} marked 'switch' but blind_slot == final_slot`,
    );
    check(
      !(a.final_action_type === 'timeout' && a.blind_slot !== a.final_slot),
      `attempt ${a.id} marked 'timeout' but final_slot != retained blind_slot`,
    );

    let returns = assetCache.get(a.round_id);
    if (!returns) {
      const assets = await pool.query<{ slot: string; return_ratio: string }>(
        'SELECT slot, return_ratio FROM round_assets WHERE round_id = $1',
        [a.round_id],
      );
      returns = Object.fromEntries(assets.rows.map((row) => [row.slot, Number(row.return_ratio)]));
      assetCache.set(a.round_id, returns);
    }

    const blindReturn = returns[a.blind_slot];
    const finalReturn = returns[a.final_slot];
    check(
      blindReturn !== undefined && finalReturn !== undefined,
      `attempt ${a.id} references a slot missing from round_assets for round ${a.round_id}`,
    );
    if (blindReturn === undefined || finalReturn === undefined) continue;

    const impact = independentSwitchImpactPp(blindReturn, finalReturn);
    const tax = independentTickerTaxPp(blindReturn, finalReturn);

    if (!a.is_repeat && a.final_action_type !== 'timeout') {
      taxValues.push(tax);
    }

    console.log(
      `Attempt ${a.id}: ${a.blind_slot} -> ${a.final_slot} (${a.final_action_type}), switch_impact_pp=${impact.toFixed(4)}, ticker_tax_pp=${tax.toFixed(4)}`,
    );
  }

  const avgTax = taxValues.length > 0 ? taxValues.reduce((sum, v) => sum + v, 0) / taxValues.length : null;
  console.log(
    `\nTicker Tax recomputed over ${taxValues.length} eligible (first-time, non-timeout, valid) attempt(s): ` +
      `average = ${avgTax === null ? 'n/a (no eligible attempts)' : avgTax.toFixed(4) + 'pp'}`,
  );

  console.log(`\n${checks} check(s) run, ${failures} failure(s).`);
  await pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Verify script crashed:', err);
  process.exit(1);
});
