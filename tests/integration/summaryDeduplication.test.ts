import { afterAll, describe, expect, it } from 'vitest';
import {
  closeTestPool,
  deleteTestPlayers,
  deleteTestRounds,
  insertSyntheticRound,
  randomAnonId,
  testPool,
} from './fixtures';
import { TestSession } from './testClient';

import { POST as postBlind } from '@/app/api/rounds/[id]/blind/route';
import { POST as postFinal } from '@/app/api/rounds/[id]/final/route';
import { GET as getSummary } from '@/app/api/me/summary/route';
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

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  const pool = testPool();
  await deleteTestRounds(pool, roundIdsToClean);
  await deleteTestPlayers(pool, anonIdsToClean);
  await closeTestPool();
});

maybeDescribe('Summary deduplication guarantees', () => {
  it('does not count the same round twice when played via replay and repeat/daily', async () => {
    const { roundId: canonicalRoundId } = await insertSyntheticRound({
      mode: 'daily',
      returns: { A: 0.3, B: 0.1, C: -0.1 },
    });
    trackRound(canonicalRoundId);

    const { roundId: repeatRoundId } = await insertSyntheticRound({
      mode: 'replay',
      returns: { A: 0.3, B: 0.1, C: -0.1 },
      repeatOf: canonicalRoundId,
    });
    trackRound(repeatRoundId);

    const session = trackSession(new TestSession(randomAnonId()));

    const b1 = await postBlind(
      session.request(`http://test/api/rounds/${canonicalRoundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: canonicalRoundId }) },
    );
    session.absorb(b1);

    const f1 = await postFinal(
      session.request(`http://test/api/rounds/${canonicalRoundId}/final`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: canonicalRoundId }) },
    );
    session.absorb(f1);

    const b2 = await postBlind(
      session.request(`http://test/api/rounds/${repeatRoundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: repeatRoundId }) },
    );
    session.absorb(b2);

    const f2 = await postFinal(
      session.request(`http://test/api/rounds/${repeatRoundId}/final`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: repeatRoundId }) },
    );
    session.absorb(f2);

    const res = await getSummary(session.request('http://test/api/me/summary'));
    expect(res.status).toBe(200);
    const summary = await res.json();

    // The player completed 2 attempts, but only 1 eligible round is counted in Ticker Tax
    expect(summary.eligibleCount).toBe(1);
    expect(summary.repeatedCount).toBe(1);
    expect(summary.tickerTaxDenominator).toBe(1);
  });
});
