import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignTestDaily,
  closeTestPool,
  dbTodayUtc,
  deleteOwnedTestDaily,
  deleteTestPlayers,
  deleteTestRounds,
  insertSyntheticRound,
  testPool,
  type OwnedTestDaily,
} from './fixtures';
import { makeRequest, TestSession } from './testClient';

import { GET as getNext } from '@/app/api/rounds/next/route';
import { GET as getRound } from '@/app/api/rounds/[id]/route';
import { POST as postBlind } from '@/app/api/rounds/[id]/blind/route';
import { POST as postFinal } from '@/app/api/rounds/[id]/final/route';
import { ELIGIBILITY_POLICY_VERSION } from '@/lib/domain/assetPolicy';

/**
 * Regression: an empty Replay queue must be explained honestly. The Daily round is held
 * out of Replay on its day (and before it), returns to Replay after its day, and a guest's
 * progress counts only what they actually played.
 */
const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

const roundIds: string[] = [];
const anonIds: string[] = [];
const dailies: OwnedTestDaily[] = [];
let dailyRound = '';
let replayRound = '';
let today = '';

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface NextBody {
  available: boolean;
  roundId?: string;
  reason?: string;
  progress: {
    catalogSize: number;
    completedCount: number;
    reservedForDaily: number;
    daily: { available: boolean; roundId: string | null; completed: boolean; nextScheduled: boolean };
  };
}

async function next(session?: TestSession): Promise<NextBody> {
  const req = session ? session.request('http://localhost/api/rounds/next') : makeRequest('http://localhost/api/rounds/next');
  return (await getNext(req)).json();
}

/** A guest who has already played every approved round except the ones this file creates. */
async function primedGuest(exclude: string[]): Promise<TestSession> {
  const s = new TestSession();
  anonIds.push(s.cookieHeader());
  const pool = testPool();
  const player = await pool.query<{ id: string }>('INSERT INTO players (anon_id) VALUES ($1) RETURNING id', [s.cookieHeader()]);
  await pool.query(
    `INSERT INTO attempts (player_id, round_id, stage, is_repeat)
     SELECT $1, r.id, 'blind', false FROM rounds r
     WHERE r.mode = 'replay' AND r.eligibility_status = 'approved' AND r.eligibility_policy_version = $2
       AND r.id <> ALL($3::uuid[])`,
    [player.rows[0]!.id, ELIGIBILITY_POLICY_VERSION, exclude],
  );
  return s;
}

async function play(s: TestSession, id: string): Promise<void> {
  const blind = await postBlind(s.request(`http://localhost/api/rounds/${id}/blind`, { method: 'POST', body: { slot: 'A' } }), params(id));
  expect(blind.status).toBe(200);
  s.absorb(blind);
  const final = await postFinal(s.request(`http://localhost/api/rounds/${id}/final`, { method: 'POST', body: { slot: 'A' } }), params(id));
  expect(final.status).toBe(200);
}

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  const pool = testPool();
  today = await dbTodayUtc(pool);
  dailyRound = (await insertSyntheticRound()).roundId;
  replayRound = (await insertSyntheticRound()).roundId;
  roundIds.push(dailyRound, replayRound);
  dailies.push(await assignTestDaily(pool, today, dailyRound));
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  const pool = testPool();
  for (const d of dailies) await deleteOwnedTestDaily(pool, d);
  await deleteTestRounds(pool, roundIds);
  await deleteTestPlayers(pool, anonIds);
  await closeTestPool();
});

maybeDescribe('Player progress — honest Daily and Replay exhaustion', () => {
  it('a fresh browser has played nothing and is offered a Replay round; today’s Daily is not that round', async () => {
    const body = await next();
    expect(body.progress.completedCount).toBe(0);
    expect(body.progress.daily).toMatchObject({ available: true, roundId: dailyRound, completed: false });
    if (body.available) expect(body.roundId).not.toBe(dailyRound);
  });

  it('Daily played, Replay remaining: the next round is the Replay round and the Daily reads complete', async () => {
    const s = await primedGuest([dailyRound, replayRound]);
    await play(s, dailyRound);
    const body = await next(s);
    expect(body).toMatchObject({ available: true, roundId: replayRound });
    expect(body.progress.daily.completed).toBe(true);
  });

  it('Replay played, Daily remaining: no Replay round, and the reason points to today’s Daily', async () => {
    const s = await primedGuest([dailyRound, replayRound]);
    await play(s, replayRound);
    const body = await next(s);
    expect(body).toMatchObject({ available: false, reason: 'daily_only' });
    expect(body.progress.daily).toMatchObject({ available: true, completed: false });
    expect(body.progress.reservedForDaily).toBe(1);
  });

  it('both completed: the catalog is exhausted and every approved round counts as completed', async () => {
    const s = await primedGuest([dailyRound, replayRound]);
    await play(s, dailyRound);
    await play(s, replayRound);
    const body = await next(s);
    expect(body).toMatchObject({ available: false, reason: 'all_played' });
    expect(body.progress.completedCount).toBe(body.progress.catalogSize);
    expect(body.progress.daily.completed).toBe(true);
  });

  it('a completed Daily reloads to its verdict, not to a dead end', async () => {
    const s = await primedGuest([dailyRound, replayRound]);
    await play(s, dailyRound);
    const res = await getRound(s.request(`http://localhost/api/rounds/${dailyRound}`), params(dailyRound));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBeTruthy();
    expect(body.attempt.stage).toBe('final_locked');
  });

  it('UTC rollover: a past Daily returns to Replay, while an upcoming Daily stays held back', async () => {
    const pool = testPool();
    const past = (await insertSyntheticRound()).roundId;
    const upcoming = (await insertSyntheticRound()).roundId;
    roundIds.push(past, upcoming);
    dailies.push(await assignTestDaily(pool, addDays(today, -1), past));
    dailies.push(await assignTestDaily(pool, addDays(today, 1), upcoming));

    const s = await primedGuest([dailyRound, past, upcoming]);
    const first = await next(s);
    expect(first).toMatchObject({ available: true, roundId: past });
    expect(first.progress.daily.nextScheduled).toBe(true);

    await play(s, past);
    const second = await next(s);
    // Today's Daily and tomorrow's are both held back from Replay.
    expect(second).toMatchObject({ available: false, reason: 'daily_only' });
    expect(second.progress.reservedForDaily).toBe(2);
  });
});
