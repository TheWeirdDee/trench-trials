import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { insertVerifiedRound, type VerifiedRound } from '@/lib/repo/verifiedRoundImport';
import type { EligibilityDecision } from '@/lib/repo/eligibility';
import { TEST_LIVE_ELIGIBILITY } from '../testEligibility';

/** Test rounds are approved so the mechanics suites can play them — test schema only. */
export const TEST_ELIGIBILITY: EligibilityDecision = TEST_LIVE_ELIGIBILITY;

/**
 * Integration-test-only fixtures.
 *
 * OWNERSHIP-BASED CLEANUP RULES:
 * - Every test tracks exact IDs it creates (round IDs, player anon IDs, daily (date, round) pairs).
 * - Deletion functions REQUIRE explicit IDs and refuse to delete canonical/production rows.
 * - Player deletion strictly refuses to touch any player whose anon_id does not start with 'test-'.
 * - Round deletion strictly refuses to touch canonical rounds (CANONICAL_ROUND_IDS).
 * - Daily rows are never deleted by date alone: only the exact (utc_date, round_id) row a
 *   test created, carrying TEST_DAILY_SOURCE and pointing at a synthetic test round.
 */

import { getPool } from '@/lib/db';
import { assignDailyRound } from '@/lib/repo/rounds';

export function testPool(): Pool {
  return getPool();
}

export async function closeTestPool(): Promise<void> {
  // Shared pool remains active across sequential test files
}

export const CANONICAL_ROUND_IDS = [
  'be497aab-d46e-4d40-a5fb-3fbf0f0d29ca', // Verified Replay round
  'df397565-caab-4208-8737-9b1d208177d7', // Preserved invalid Live round
];

export async function insertRealRound001(): Promise<{ roundId: string; commitmentHash: string }> {
  const filePath = join(__dirname, '..', '..', 'data', 'verified-rounds', 'round-001.json');
  const round: VerifiedRound = JSON.parse(readFileSync(filePath, 'utf8'));
  return insertVerifiedRound(testPool(), round, { eligibility: TEST_ELIGIBILITY });
}

export interface SyntheticRoundOptions {
  mode?: 'replay' | 'daily' | 'live';
  decisionWindowSeconds?: number;
  returns?: { A: number; B: number; C: number };
  repeatOf?: string | null;
  /** Defaults to TEST_ELIGIBILITY (approved); `null` leaves the round pending review. */
  eligibility?: EligibilityDecision | null;
}

/** SYNTHETIC TEST FIXTURE — never real Nansen data, never served to real players. */
export function buildSyntheticRound(options: SyntheticRoundOptions = {}): VerifiedRound {
  const returns = options.returns ?? { A: 0.1, B: 0.05, C: -0.02 };
  const makeAsset = (slot: 'A' | 'B' | 'C', symbol: string, ret: number) => ({
    slot,
    token_symbol: symbol,
    token_address: `TEST_FIXTURE_ADDRESS_${slot}`,
    sectors: ['TestFixture'],
    clue_inputs: {},
    clues: {
      buy_sell_balance: { value: 0, bucket: 'balanced' },
      trading_acceleration: { value: 1, bucket: 'steady' },
      netflow_over_liquidity: { value: 0, bucket: 'balanced' },
      recent_momentum: { value: ret, bucket: ret > 0.05 ? 'rising' : ret < -0.05 ? 'falling' : 'flat' },
    },
    price: {
      entry_candle_start: '2026-01-01T00:00:00Z',
      entry_close: 1,
      exit_candle_start: '2026-01-08T00:00:00Z',
      exit_close: 1 + ret,
    },
    return: ret,
    source_response_sha256: { synthetic_test_fixture: 'not_a_real_nansen_response' },
  });

  return {
    round_id: `synthetic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mode: options.mode ?? 'replay',
    chain: 'solana',
    cutoff: '2026-01-01T00:00:00Z',
    horizon_days: 7,
    candle_interval: '1h',
    resolution_time: '2026-01-08T00:00:00Z',
    round_forge_version: 1,
    clue_schema_version: 1,
    price_policy_version: 1,
    eligibility_policy: { synthetic: true },
    assets: [
      makeAsset('A', 'TESTA', returns.A),
      makeAsset('B', 'TESTB', returns.B),
      makeAsset('C', 'TESTC', returns.C),
    ],
    winner_slot: (Object.entries(returns).sort((a, b) => b[1] - a[1])[0] as [string, number])[0],
    repeat_of: options.repeatOf ?? null,
    provenance: { note: 'SYNTHETIC TEST FIXTURE — not real Nansen data', retrieved_at_utc: null },
  };
}

export async function insertSyntheticRound(
  options: SyntheticRoundOptions = {},
): Promise<{ roundId: string; commitmentHash: string }> {
  const round = buildSyntheticRound(options);
  return insertVerifiedRound(testPool(), round, {
    decisionWindowSeconds: options.decisionWindowSeconds ?? 15,
    eligibility: options.eligibility === null ? undefined : (options.eligibility ?? TEST_ELIGIBILITY),
  });
}

/** assignment_source carried by every Daily row a test creates; genuine assignments use 'admin_api'. */
export const TEST_DAILY_SOURCE = 'integration-test';

/** A Daily row created by this test run, identified exactly. */
export interface OwnedTestDaily {
  utcDate: string;
  roundId: string;
}

/** Today's UTC date by the database clock — the same clock GET /api/daily uses. */
export async function dbTodayUtc(pool: Pool): Promise<string> {
  const res = await pool.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS d`);
  return res.rows[0]!.d;
}

/**
 * Fails closed: throws, before anything is written, if `utcDate` already has a Daily
 * assignment. A test must never displace — or later delete — a row it did not create.
 */
export async function assertDailyDateUnassigned(pool: Pool, utcDate: string): Promise<void> {
  const existing = await pool.query<{ round_id: string; assignment_source: string }>(
    'SELECT round_id, assignment_source FROM daily_challenges WHERE utc_date = $1::date',
    [utcDate],
  );
  const row = existing.rows[0];
  if (row) {
    throw new Error(
      `SAFETY REFUSAL: ${utcDate} already has a Daily assignment (round ${row.round_id}, source ${row.assignment_source}) that this test did not create; refusing to touch it.`,
    );
  }
}

/** Assigns a synthetic test round to a free date, marked TEST_DAILY_SOURCE. Fails closed if the date is taken. */
export async function assignTestDaily(pool: Pool, utcDate: string, roundId: string): Promise<OwnedTestDaily> {
  await assertDailyDateUnassigned(pool, utcDate);
  const result = await assignDailyRound(utcDate, roundId, { source: TEST_DAILY_SOURCE });
  if (!result.ok) {
    throw new Error(`SAFETY REFUSAL: test Daily assignment for ${utcDate} failed (${result.error}); nothing was changed.`);
  }
  return { utcDate, roundId };
}

/**
 * Deletes exactly the Daily row a test created — matched on date, round, the test
 * marker and a synthetic test round — and throws unless exactly one row went.
 */
export async function deleteOwnedTestDaily(pool: Pool, owned: OwnedTestDaily): Promise<void> {
  const res = await pool.query(
    `DELETE FROM daily_challenges dc
     USING rounds r
     WHERE dc.utc_date = $1::date
       AND dc.round_id = $2
       AND dc.assignment_source = $3
       AND r.id = dc.round_id
       AND r.initial_manifest->>'round_id_source' LIKE 'synthetic-test-%'`,
    [owned.utcDate, owned.roundId, TEST_DAILY_SOURCE],
  );
  if (res.rowCount !== 1) {
    throw new Error(
      `SAFETY REFUSAL: expected to delete exactly 1 test-owned Daily row for ${owned.utcDate} / ${owned.roundId}, deleted ${res.rowCount}.`,
    );
  }
}

/**
 * Safely deletes explicit test rounds by exact IDs.
 * Strictly refuses to delete canonical rounds or rounds without explicit IDs.
 */
export async function deleteTestRounds(pool: Pool, roundIds: string[]): Promise<void> {
  if (!roundIds || roundIds.length === 0) return;

  // Filter out any canonical rounds
  const safeRoundIds = roundIds.filter((id) => !CANONICAL_ROUND_IDS.includes(id));
  if (safeRoundIds.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Crash safety net: test-marked Daily rows still pointing at these rounds. A row
    // without the marker is left alone, and its foreign key then fails the round
    // delete below — the whole cleanup rolls back rather than touch it.
    await client.query('DELETE FROM daily_challenges WHERE round_id = ANY($1::uuid[]) AND assignment_source = $2', [
      safeRoundIds,
      TEST_DAILY_SOURCE,
    ]);
    // Delete the test rounds (cascades to test assets/attempts/events)
    await client.query('DELETE FROM rounds WHERE id = ANY($1::uuid[])', [safeRoundIds]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Safely deletes explicit test players by exact anonymous IDs.
 * Strictly requires that every anon_id begins with 'test-'. Throws if any non-test ID is passed.
 */
export async function deleteTestPlayers(pool: Pool, anonIds: string[]): Promise<void> {
  if (!anonIds || anonIds.length === 0) return;

  for (const anonId of anonIds) {
    if (!anonId.startsWith('test-')) {
      throw new Error(`SAFETY REFUSAL: Cannot delete non-test player '${anonId}'. Only 'test-*' IDs allowed.`);
    }
  }

  await pool.query('DELETE FROM players WHERE anon_id = ANY($1::text[])', [anonIds]);
}

export async function deleteRounds(roundIds: string[]): Promise<void> {
  await deleteTestRounds(testPool(), roundIds);
}

export async function deletePlayers(anonIds?: string[]): Promise<void> {
  if (anonIds && anonIds.length > 0) {
    await deleteTestPlayers(testPool(), anonIds);
  }
}

export async function cleanupAllTestFixtures(): Promise<void> {
  // Safe no-op alias
}

export function randomAnonId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
