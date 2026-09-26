import { afterAll, describe, expect, it } from 'vitest';
import {
  closeTestPool,
  dbTodayUtc,
  deleteOwnedTestDaily,
  assignTestDaily,
  deleteTestPlayers,
  deleteTestRounds,
  insertSyntheticRound,
  TEST_ELIGIBILITY,
  testPool,
} from './fixtures';
import { TestSession } from './testClient';

import { GET as getDaily } from '@/app/api/daily/route';
import { GET as getHistory } from '@/app/api/history/route';
import { GET as getLive } from '@/app/api/live/route';
import { GET as getNext } from '@/app/api/rounds/next/route';
import { GET as getRound } from '@/app/api/rounds/[id]/route';
import { POST as postBlind } from '@/app/api/rounds/[id]/blind/route';
import { POST as postFinal } from '@/app/api/rounds/[id]/final/route';
import { ELIGIBILITY_POLICY_VERSION } from '@/lib/domain/assetPolicy';
import { setRoundEligibility } from '@/lib/repo/eligibility';
import { createLiveRound, resolveLiveRound } from '@/lib/repo/live';
import { assignDailyRound, pickNextReplayRound } from '@/lib/repo/rounds';

/**
 * Eligibility gate (docs/NANSEN-CONTRACT-AUDIT.md, Phase 6): only rounds approved under the
 * CURRENT eligibility policy are player-facing. Pending, under-investigation, withdrawn and
 * older-policy rounds cannot enter Replay, the Daily, Live, a new blind lock, or History
 * metrics — and a withdrawal is a reversible status change, never a deletion.
 */
const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

const roundIds: string[] = [];
const anonIds: string[] = [];
const track = (id: string) => (roundIds.push(id), id);
const session = () => {
  const s = new TestSession();
  anonIds.push(s.cookieHeader());
  return s;
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const withdraw = (id: string, note = 'integration test: withdrawn') =>
  setRoundEligibility(testPool(), id, { status: 'withdrawn', actor: 'test_fixture', note });

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  await deleteTestRounds(testPool(), roundIds);
  await deleteTestPlayers(testPool(), anonIds);
  await closeTestPool();
});

/** Rounds in every non-player-facing state, plus the reason each is not player-facing. */
async function blockedRounds(): Promise<Array<{ label: string; id: string }>> {
  const pending = track((await insertSyntheticRound({ eligibility: null })).roundId);
  const investigate = track((await insertSyntheticRound()).roundId);
  await setRoundEligibility(testPool(), investigate, { status: 'investigate', actor: 'test_fixture', note: 'test' });
  const withdrawn = track((await insertSyntheticRound()).roundId);
  await withdraw(withdrawn);
  const olderPolicy = track((await insertSyntheticRound()).roundId);
  // Approved, but under a previous policy version: no silent grandfathering.
  await testPool().query('UPDATE rounds SET eligibility_policy_version = $2 WHERE id = $1', [
    olderPolicy,
    ELIGIBILITY_POLICY_VERSION - 1,
  ]);
  return [
    { label: 'pending review', id: pending },
    { label: 'under investigation', id: investigate },
    { label: 'withdrawn', id: withdrawn },
    { label: 'approved under an older policy version', id: olderPolicy },
  ];
}

maybeDescribe('Eligibility gate — only rounds approved under the current policy are player-facing', () => {
  it('a new round is pending review by default: nothing is grandfathered', async () => {
    const id = track((await insertSyntheticRound({ eligibility: null })).roundId);
    const row = await testPool().query('SELECT eligibility_status, eligibility_policy_version FROM rounds WHERE id = $1', [id]);
    expect(row.rows[0]).toEqual({ eligibility_status: 'pending_review', eligibility_policy_version: null });
  });

  it('Replay never picks a non-player-facing round, and approval/withdrawal is reversible', async () => {
    const blocked = await blockedRounds();
    const s = session();
    const pool = testPool();
    // This guest has "played" every player-facing Replay round, so only blocked rounds remain unplayed.
    const player = await pool.query<{ id: string }>('INSERT INTO players (anon_id) VALUES ($1) RETURNING id', [s.cookieHeader()]);
    await pool.query(
      `INSERT INTO attempts (player_id, round_id, stage, is_repeat)
       SELECT $1, r.id, 'blind', false FROM rounds r
       WHERE r.mode = 'replay' AND r.eligibility_status = 'approved' AND r.eligibility_policy_version = $2`,
      [player.rows[0]!.id, ELIGIBILITY_POLICY_VERSION],
    );
    expect(await pickNextReplayRound(s.cookieHeader())).toBeNull();
    // Blocked rounds exist and are unplayed, yet the guest is told they have played every approved round.
    const next = await (await getNext(s.request('http://localhost/api/rounds/next'))).json();
    expect(next).toMatchObject({ available: false, reason: 'all_played' });

    // Reversible: approving a withdrawn round makes it pickable again; withdrawing hides it again.
    const withdrawn = blocked.find((b) => b.label === 'withdrawn')!.id;
    await setRoundEligibility(pool, withdrawn, { ...TEST_ELIGIBILITY, note: 'integration test: reinstated' });
    expect((await pickNextReplayRound(s.cookieHeader()))?.id).toBe(withdrawn);
    await withdraw(withdrawn, 'integration test: withdrawn again');
    expect(await pickNextReplayRound(s.cookieHeader())).toBeNull();

    const events = await pool.query<{ from_status: string; to_status: string }>(
      'SELECT from_status, to_status FROM round_eligibility_events WHERE round_id = $1 ORDER BY created_at, id',
      [withdrawn],
    );
    expect(events.rows.map((e) => `${e.from_status}→${e.to_status}`)).toEqual([
      'pending_review→approved',
      'approved→withdrawn',
      'withdrawn→approved',
      'approved→withdrawn',
    ]);
    // Withdrawal deleted nothing: the round and its assets are intact.
    const assets = await pool.query('SELECT count(*)::int AS n FROM round_assets WHERE round_id = $1', [withdrawn]);
    expect(assets.rows[0].n).toBe(3);
  });

  it('a non-player-facing round cannot be opened or blind-locked by a new guest, and creates nothing', async () => {
    for (const { label, id } of await blockedRounds()) {
      const s = session();
      const get = await getRound(s.request(`http://localhost/api/rounds/${id}`), params(id));
      expect(get.status, label).toBe(404);
      expect((await get.json()).error, label).toBe('round_not_available');

      const blind = await postBlind(s.request(`http://localhost/api/rounds/${id}/blind`, { method: 'POST', body: { slot: 'A' } }), params(id));
      expect(blind.status, label).toBe(409);
      expect((await blind.json()).reason, label).toBe('round_not_available');

      const created = await testPool().query(
        `SELECT (SELECT count(*)::int FROM attempts WHERE round_id = $1) AS attempts,
                (SELECT count(*)::int FROM players WHERE anon_id = $2) AS players`,
        [id, s.cookieHeader()],
      );
      expect(created.rows[0], label).toEqual({ attempts: 0, players: 0 });
    }
  });

  it('an invalid round stays readable as a void audit record, but can never be locked', async () => {
    const id = track((await insertSyntheticRound({ eligibility: null })).roundId);
    await testPool().query(`UPDATE rounds SET status = 'invalid', invalid_reason = 'integration test' WHERE id = $1`, [id]);
    const s = session();
    const get = await getRound(s.request(`http://localhost/api/rounds/${id}`), params(id));
    expect(get.status).toBe(200);
    expect((await get.json()).round.status).toBe('invalid');
    const blind = await postBlind(s.request(`http://localhost/api/rounds/${id}/blind`, { method: 'POST', body: { slot: 'A' } }), params(id));
    expect(blind.status).toBe(404);
    const created = await testPool().query('SELECT count(*)::int AS n FROM attempts WHERE round_id = $1', [id]);
    expect(created.rows[0].n).toBe(0);
  });

  it('a guest who played before a withdrawal keeps their attempt, but it leaves every metric', async () => {
    const id = track((await insertSyntheticRound()).roundId);
    const s = session();
    const blind = await postBlind(s.request(`http://localhost/api/rounds/${id}/blind`, { method: 'POST', body: { slot: 'A' } }), params(id));
    expect(blind.status).toBe(200);
    s.absorb(blind);
    const final = await postFinal(s.request(`http://localhost/api/rounds/${id}/final`, { method: 'POST', body: { slot: 'A' } }), params(id));
    expect(final.status).toBe(200);

    const before = await (await getHistory(s.request('http://localhost/api/history'))).json();
    expect(before.entries[0].status).toBe('completed');
    expect(before.summary.eligibleCount).toBe(1);

    await withdraw(id);

    const own = await getRound(s.request(`http://localhost/api/rounds/${id}`), params(id));
    expect(own.status).toBe(200);
    const after = await (await getHistory(s.request('http://localhost/api/history'))).json();
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0].status).toBe('withdrawn');
    expect(after.entries[0].outcome).toBeNull();
    expect(after.summary.eligibleCount).toBe(0);
    expect(after.summary.historical.invalidCount).toBe(1);
  });

  it('the Daily refuses non-approved rounds, and a withdrawn Daily round stops being shown', async () => {
    for (const { label, id } of await blockedRounds()) {
      expect(await assignDailyRound('2099-12-31', id, { source: 'integration-test' }), label).toEqual({
        ok: false,
        error: 'round_not_approved',
      });
    }
    const daily = track((await insertSyntheticRound({ mode: 'daily' })).roundId);
    const owned = await assignTestDaily(testPool(), await dbTodayUtc(testPool()), daily);
    try {
      expect((await getDaily()).status).toBe(200);
      await withdraw(daily);
      const res = await getDaily();
      expect(res.status).toBe(404);
      expect((await res.json()).available).toBe(false);
    } finally {
      await deleteOwnedTestDaily(testPool(), owned);
    }
  });

  it('a Live round that is not approved is neither shown nor resolved (zero Nansen requests)', async () => {
    const fetchSpy = global.fetch;
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('no network in this test');
    }) as typeof fetch;
    try {
      const assets = (['A', 'B', 'C'] as const).map((slot) => ({
        slot,
        tokenSymbol: `TEST${slot}`,
        tokenAddress: `TEST_FIXTURE_ADDRESS_${slot}`,
        chain: 'solana',
        sectors: ['TestFixture'],
        clueInputs: {},
        clues: {
          buy_sell_balance: { value: 0, bucket: 'balanced' },
          trading_acceleration: { value: 1, bucket: 'steady' },
          netflow_over_liquidity: { value: 0, bucket: 'balanced' },
          recent_momentum: { value: 0, bucket: 'flat' },
        },
      }));
      const pending = await createLiveRound({ chain: 'solana', assets, snapshotPublishedAt: new Date(Date.now() - 3 * 86_400_000) });
      track(pending.roundId);
      const live = await (await getLive()).json();
      expect(live.live?.roundId).not.toBe(pending.roundId);

      const resolved = await resolveLiveRound(pending.roundId, { now: new Date() });
      expect(resolved).toMatchObject({ ok: false, error: 'round_not_approved' });
      expect(fetchCalls).toBe(0);
      const row = await testPool().query('SELECT status FROM rounds WHERE id = $1', [pending.roundId]);
      expect(row.rows[0].status).toBe('open');
    } finally {
      global.fetch = fetchSpy;
    }
  });
});
