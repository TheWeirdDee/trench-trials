import { afterAll, describe, expect, it } from 'vitest';
import {
  assertDailyDateUnassigned,
  assignTestDaily,
  closeTestPool,
  dbTodayUtc,
  deleteOwnedTestDaily,
  deleteTestPlayers,
  deleteTestRounds,
  insertSyntheticRound,
  randomAnonId,
  TEST_DAILY_SOURCE,
  testPool,
  type OwnedTestDaily,
} from './fixtures';
import { makeRequest, TestSession } from './testClient';

import { GET as getDaily } from '@/app/api/daily/route';
import { POST as postAssignDaily } from '@/app/api/internal/daily/assign/route';
import { GET as getRound } from '@/app/api/rounds/[id]/route';
import { POST as postBlind } from '@/app/api/rounds/[id]/blind/route';
import { POST as postFinal } from '@/app/api/rounds/[id]/final/route';
import { GET as getResult } from '@/app/api/rounds/[id]/result/route';
import { assignDailyRound } from '@/lib/repo/rounds';

const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

const roundIdsToClean: string[] = [];
const anonIdsToClean: string[] = [];

function trackRound(id: string) {
  roundIdsToClean.push(id);
  return id;
}
function trackSession(session: TestSession) {
  anonIdsToClean.push(session.cookieHeader());
  return session;
}

/**
 * Runs `fn` while this test owns the Daily row for `utcDate`, then deletes exactly
 * that row. Never deletes by date: if the date is already taken — for example by a
 * genuine assignment for today — it fails closed before writing anything.
 */
async function withOwnedTestDaily(utcDate: string, roundId: string, fn: (owned: OwnedTestDaily) => Promise<void>) {
  const owned = await assignTestDaily(testPool(), utcDate, roundId);
  try {
    await fn(owned);
  } finally {
    await deleteOwnedTestDaily(testPool(), owned);
  }
}

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  const pool = testPool();
  await deleteTestRounds(pool, roundIdsToClean);
  await deleteTestPlayers(pool, anonIdsToClean);
  await closeTestPool();
});

maybeDescribe('Daily Trial — backend flow and assignment validation', () => {
  const futureUtc = '2099-01-01';

  it('GET /api/daily returns 404 available:false when no daily is configured for today', async () => {
    // Observes today; never clears it. A Daily already assigned for today fails this test closed.
    await assertDailyDateUnassigned(testPool(), await dbTodayUtc(testPool()));

    const res = await getDaily();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.message).toContain("Today's Trial is not available yet");
  });

  it('internal assignment route rejects unauthorized requests', async () => {
    const { roundId } = await insertSyntheticRound({ mode: 'daily' });
    trackRound(roundId);

    const req = makeRequest('http://test/api/internal/daily/assign', {
      method: 'POST',
      body: { utcDate: futureUtc, roundId },
    });
    const res = await postAssignDaily(req);
    expect(res.status).toBe(401);
  });

  it('assignDailyRound rejects nonexistent rounds', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const result = await assignDailyRound(futureUtc, fakeId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('round_not_found');
    }
  });

  it('assignDailyRound rejects Live rounds and repeat copies — a Daily is a canonical round', async () => {
    const { roundId: liveRound } = await insertSyntheticRound({ mode: 'live' });
    const { roundId: canonical } = await insertSyntheticRound({ mode: 'replay' });
    const { roundId: copy } = await insertSyntheticRound({ mode: 'daily', repeatOf: canonical });
    trackRound(copy);
    trackRound(liveRound);
    trackRound(canonical);

    const live = await assignDailyRound(futureUtc, liveRound);
    expect(live).toEqual({ ok: false, error: 'round_is_live' });
    const repeat = await assignDailyRound(futureUtc, copy);
    expect(repeat).toEqual({ ok: false, error: 'round_is_repeat' });
    const rows = await testPool().query('SELECT 1 FROM daily_challenges WHERE utc_date = $1::date', [futureUtc]);
    expect(rows.rowCount).toBe(0);
  });

  it('a canonical Replay round becomes the Daily directly — no copy — and only once', async () => {
    const { roundId } = await insertSyntheticRound({ mode: 'replay' });
    trackRound(roundId);

    await withOwnedTestDaily('2099-06-01', roundId, async () => {
      const row = await testPool().query('SELECT round_id FROM daily_challenges WHERE utc_date = $1::date', [
        '2099-06-01',
      ]);
      expect(row.rows).toEqual([{ round_id: roundId }]);
      const copies = await testPool().query('SELECT 1 FROM rounds WHERE repeat_of = $1', [roundId]);
      expect(copies.rowCount).toBe(0); // nothing was cloned

      const again = await assignDailyRound('2099-06-02', roundId, { source: TEST_DAILY_SOURCE });
      expect(again).toEqual({ ok: false, error: 'round_already_daily' });
      const second = await testPool().query('SELECT 1 FROM daily_challenges WHERE utc_date = $1::date', ['2099-06-02']);
      expect(second.rowCount).toBe(0);
    });
  });

  it('assignDailyRound rejects non-resolved rounds', async () => {
    const { roundId } = await insertSyntheticRound({ mode: 'daily' });
    trackRound(roundId);
    await testPool().query(`UPDATE rounds SET status = 'draft' WHERE id = $1`, [roundId]);

    const result = await assignDailyRound(futureUtc, roundId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('round_not_resolved');
    }
  });

  it('assignDailyRound rejects sourceless rounds (no source receipts)', async () => {
    const { roundId } = await insertSyntheticRound({ mode: 'daily' });
    trackRound(roundId);
    await testPool().query('DELETE FROM source_receipts WHERE round_id = $1', [roundId]);

    const result = await assignDailyRound(futureUtc, roundId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('round_sourceless');
    }
  });

  it('assignDailyRound successfully assigns a verified daily round and prevents duplicate assignment for the same UTC date', async () => {
    const dateToAssign = '2099-05-15';
    const { roundId: round1 } = await insertSyntheticRound({ mode: 'daily' });
    const { roundId: round2 } = await insertSyntheticRound({ mode: 'daily' });
    trackRound(round1);
    trackRound(round2);

    await withOwnedTestDaily(dateToAssign, round1, async () => {
      const duplicate = await assignDailyRound(dateToAssign, round2, { source: TEST_DAILY_SOURCE });
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) {
        expect(duplicate.error).toBe('date_already_assigned');
      }
      // The rejected duplicate left the original row untouched.
      const row = await testPool().query('SELECT round_id FROM daily_challenges WHERE utc_date = $1::date', [
        dateToAssign,
      ]);
      expect(row.rows).toEqual([{ round_id: round1 }]);
    });
  });

  it('GET /api/daily returns the assigned daily round with dailyNumber and resetAtUtc', async () => {
    const todayUtc = await dbTodayUtc(testPool());
    const { roundId } = await insertSyntheticRound({ mode: 'daily' });
    trackRound(roundId);

    await withOwnedTestDaily(todayUtc, roundId, async () => {
      const res = await getDaily();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.available).toBe(true);
      expect(body.roundId).toBe(roundId);
      expect(body.utcDate).toBe(todayUtc);
      expect(body.dailyNumber).toBeGreaterThanOrEqual(1);
      expect(new Date(body.resetAtUtc).getTime()).toBe(Date.parse(`${todayUtc}T00:00:00Z`) + 24 * 60 * 60 * 1000);
    });
  });

  it('two independent players playing Daily receive the exact same round and candidates, and track separate attempts', async () => {
    const dailyDate = await dbTodayUtc(testPool());
    const { roundId } = await insertSyntheticRound({
      mode: 'daily',
      returns: { A: 0.15, B: -0.05, C: 0.02 },
    });
    trackRound(roundId);

    await withOwnedTestDaily(dailyDate, roundId, async () => {
      const sessionA = trackSession(new TestSession(randomAnonId()));
      const sessionB = trackSession(new TestSession(randomAnonId()));

      // Player A loads Daily
      const resA = await getRound(sessionA.request(`http://test/api/rounds/${roundId}`), {
        params: Promise.resolve({ id: roundId }),
      });
      sessionA.absorb(resA);
      const dataA = await resA.json();

      // Player B loads Daily
      const resB = await getRound(sessionB.request(`http://test/api/rounds/${roundId}`), {
        params: Promise.resolve({ id: roundId }),
      });
      sessionB.absorb(resB);
      const dataB = await resB.json();

      // Same round, same candidate assets and clues
      expect(dataA.round.id).toBe(roundId);
      expect(dataB.round.id).toBe(roundId);
      expect(dataA.assets.map((a: { slot: string }) => a.slot)).toEqual(['A', 'B', 'C']);
      expect(dataB.assets.map((a: { slot: string }) => a.slot)).toEqual(['A', 'B', 'C']);
      expect(dataA.assets[0].clues).toEqual(dataB.assets[0].clues);

      // Player A locks blind A, B locks blind B
      await postBlind(
        sessionA.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
        { params: Promise.resolve({ id: roundId }) },
      );
      await postBlind(
        sessionB.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'B' } }),
        { params: Promise.resolve({ id: roundId }) },
      );

      // Player A final locks A (stick); Player B final locks A (switch)
      const finalA = await postFinal(
        sessionA.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'A' } }),
        { params: Promise.resolve({ id: roundId }) },
      );
      const finalB = await postFinal(
        sessionB.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'A' } }),
        { params: Promise.resolve({ id: roundId }) },
      );

      const verdictA = (await finalA.json()).verdict;
      const verdictB = (await finalB.json()).verdict;

      expect(verdictA.finalActionType).toBe('stick');
      expect(verdictA.winningSlots).toEqual(['A']);
      expect(verdictB.finalActionType).toBe('switch');
      expect(verdictB.winningSlots).toEqual(['A']);

      // Subsequent visits return the same verdict
      const resultCheck = await getResult(sessionA.request(`http://test/api/rounds/${roundId}/result`), {
        params: Promise.resolve({ id: roundId }),
      });
      const resultCheckJson = await resultCheck.json();
      expect(resultCheckJson.verdict.finalActionType).toBe('stick');
    });
  });

  it('records assignment audit metadata without storing secrets', async () => {
    const auditDate = '2099-07-20';
    const pool = testPool();
    const { roundId } = await insertSyntheticRound({ mode: 'daily' });
    trackRound(roundId);

    await assertDailyDateUnassigned(pool, auditDate);
    const res = await assignDailyRound(auditDate, roundId, {
      source: TEST_DAILY_SOURCE,
      assignedByHash: 'sha256-non-secret-operator-id',
    });
    expect(res.ok).toBe(true);

    try {
      const rows = await pool.query('SELECT * FROM daily_challenges WHERE utc_date = $1::date', [auditDate]);
      expect(rows.rows.length).toBe(1);
      const challenge = rows.rows[0];

      expect(challenge.round_id).toBe(roundId);
      expect(challenge.assignment_source).toBe(TEST_DAILY_SOURCE);
      expect(challenge.assigned_by_hash).toBe('sha256-non-secret-operator-id');
      expect(challenge.assigned_at).toBeDefined();

      // Verify secrets are never recorded in database fields
      const rowStr = JSON.stringify(challenge);
      expect(rowStr).not.toContain('ADMIN_SECRET');
      expect(rowStr).not.toContain('CRON_SECRET');
    } finally {
      await deleteOwnedTestDaily(pool, { utcDate: auditDate, roundId });
    }
  });
});
