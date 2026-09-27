import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSyntheticRound, closeTestPool, deleteTestRounds, TEST_ELIGIBILITY, testPool } from './fixtures';

import { playerFacingSql } from '@/lib/domain/eligibility';
import { recordApiCallLog } from '@/lib/repo/apiCallLog';
import { setRoundEligibility } from '@/lib/repo/eligibility';
import { BASELINE_CALLS, expectedDashboardTotal, getEvidence } from '@/lib/repo/evidence';
import { insertVerifiedRound } from '@/lib/repo/verifiedRoundImport';

/**
 * Regression: the public Evidence totals are exactly what the call log and receipts hold.
 * Usage counts, credits and the latest balance come from api_call_log; only player-facing
 * rounds are listed, each with every receipt it was built from; a rejected (withdrawn) or
 * pending round is never listed; the expected dashboard total is the earlier calls plus the
 * successful logged ones. Synthetic, test-schema rows only.
 */
const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

const roundIds: string[] = [];
const logIds: string[] = [];
const run = randomUUID().slice(0, 8);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const requestId = (n: number) => `test-evidence-${run}-${n}`;

let approved = '';
let rejected = '';
let pending = '';

async function roundWithReceipts(first: number, eligibility: typeof TEST_ELIGIBILITY | undefined): Promise<string> {
  const receipts = [first, first + 1].map((n) => ({
    endpoint: '/synthetic-test-fixture',
    purpose: `replay_outcome_${n}`,
    requestParams: {},
    responseSha256: sha(requestId(n)),
    retrievedAt: '2099-01-01T00:00:00Z',
    requestId: requestId(n),
    creditsUsed: 5,
  }));
  const { roundId } = await insertVerifiedRound(testPool(), buildSyntheticRound(), { eligibility, receipts });
  roundIds.push(roundId);
  return roundId;
}

async function logCall(n: number, ok: boolean, remaining: number, minute: number): Promise<void> {
  const at = new Date(Date.UTC(2099, 0, 1, 0, minute));
  logIds.push(
    await recordApiCallLog({
      endpoint: '/synthetic-test-fixture',
      requestTimestamp: at,
      responseTimestamp: at,
      durationMs: 1,
      httpStatus: ok ? 200 : 500,
      isSuccess: ok,
      nansenRequestId: ok ? requestId(n) : null,
      quotedCredits: 5,
      creditsUsed: ok ? 5 : 0,
      creditsRemaining: remaining,
      errorCode: ok ? null : 'synthetic_test_failure',
      isCacheHit: false,
    }),
  );
}

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  approved = await roundWithReceipts(1, TEST_ELIGIBILITY);
  rejected = await roundWithReceipts(3, TEST_ELIGIBILITY);
  await setRoundEligibility(testPool(), rejected, { status: 'withdrawn', actor: 'test_fixture', note: 'catalog_quality_repeat_winner' });
  pending = await roundWithReceipts(5, undefined);
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  if (logIds.length) await testPool().query('DELETE FROM api_call_log WHERE id = ANY($1::uuid[])', [logIds]);
  await deleteTestRounds(testPool(), roundIds);
  await closeTestPool();
});

maybeDescribe('Evidence — totals match the call log and receipts', () => {
  it('usage counts, credits and balance are exactly the call log', async () => {
    const before = (await getEvidence()).usage;
    await logCall(1, true, 105, 1);
    await logCall(2, true, 100, 2);
    await logCall(99, false, 100, 3);
    const { usage } = await getEvidence();

    expect(usage.loggedCalls).toBe(before.loggedCalls + 3);
    expect(usage.successfulCalls).toBe(before.successfulCalls + 2);
    expect(usage.creditsUsed).toBe(before.creditsUsed + 10);
    expect(usage.creditsRemaining).toBe(100);
    expect(usage.lastCallAt).toBe('2099-01-01T00:03:00.000Z');

    const db = await testPool().query<{ logged: number; ok: number; credits: number }>(
      `SELECT count(*)::int AS logged, count(*) FILTER (WHERE is_success)::int AS ok, coalesce(sum(credits_used), 0)::int AS credits FROM api_call_log`,
    );
    expect({ logged: usage.loggedCalls, ok: usage.successfulCalls, credits: usage.creditsUsed }).toEqual(db.rows[0]);
  });

  it('the expected dashboard total is the earlier calls plus the successful logged calls (21 + 116 = 137)', () => {
    expect(BASELINE_CALLS).toBe(21);
    expect(expectedDashboardTotal({ successfulCalls: 116 })).toBe(137);
  });

  it('lists exactly the player-facing rounds, each with all its receipts, and never a rejected or pending round', async () => {
    const { rounds } = await getEvidence();
    const facing = await testPool().query<{ id: string }>(
      `SELECT r.id FROM rounds r WHERE r.mode = 'replay' AND r.status IN ('ready', 'resolved') AND ${playerFacingSql('r')}`,
    );
    expect(rounds.map((r) => r.id).sort()).toEqual(facing.rows.map((r) => r.id).sort());
    expect(rounds.map((r) => r.id)).not.toContain(rejected);
    expect(rounds.map((r) => r.id)).not.toContain(pending);

    for (const r of rounds) {
      const stored = await testPool().query<{ n: number }>('SELECT count(*)::int AS n FROM source_receipts WHERE round_id = $1', [r.id]);
      expect(r.receipts, r.id).toHaveLength(stored.rows[0]!.n);
    }
    const mine = rounds.find((r) => r.id === approved)!;
    expect(mine.receipts.map((x) => x.requestId).sort()).toEqual([requestId(1), requestId(2)]);
    expect(mine.checks).toEqual({ provenance: true, commitment: true, calculation: true, eligibility: true });
  });
});
