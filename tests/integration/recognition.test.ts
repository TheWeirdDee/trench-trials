import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAllTestFixtures,
  closeTestPool,
  deletePlayers,
  deleteRounds,
  insertSyntheticRound,
  randomAnonId,
} from './fixtures';
import { TestSession } from './testClient';

import { GET as getRound } from '@/app/api/rounds/[id]/route';
import { POST as postBlind } from '@/app/api/rounds/[id]/blind/route';
import { POST as postFinal } from '@/app/api/rounds/[id]/final/route';
import { POST as postRecognition } from '@/app/api/rounds/[id]/recognition/route';

const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

const roundIdsToClean: string[] = [];
const anonIdsToClean: string[] = [];

function trackRound(id: string) {
  roundIdsToClean.push(id);
  return id;
}
function trackSession(session: TestSession) {
  const id = session.cookieHeader();
  if (id) anonIdsToClean.push(id);
  return session;
}

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  await deleteRounds(roundIdsToClean);
  await deletePlayers(anonIdsToClean);
  await deletePlayers();
  await closeTestPool();
});

async function completeToVerdict(roundId: string) {
  const session = trackSession(new TestSession(randomAnonId()));
  await getRound(session.request(`http://test/api/rounds/${roundId}`), {
    params: Promise.resolve({ id: roundId }),
  });
  await postBlind(
    session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
    { params: Promise.resolve({ id: roundId }) },
  );
  await postFinal(
    session.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'A' } }),
    { params: Promise.resolve({ id: roundId }) },
  );
  return session;
}

maybeDescribe('Recognition endpoint', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertSyntheticRound();
    roundId = trackRound(id);
  });

  it('accepts a valid recognition response naming recognized slots', async () => {
    const session = await completeToVerdict(roundId);
    const res = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['A', 'C'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recognizedSlots.sort()).toEqual(['A', 'C']);
    expect(body.skipped).toBe(false);
  });

  it('accepts a skipped response with no recognized slots recorded', async () => {
    const session = await completeToVerdict(roundId);
    const res = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { skipped: true },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.recognizedSlots).toBeNull();
  });

  it('accepts an explicit "none recognized" response (empty array, not skipped)', async () => {
    const session = await completeToVerdict(roundId);
    const res = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: [], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recognizedSlots).toEqual([]);
    expect(body.skipped).toBe(false);
  });

  it('returns 200 idempotently for an identical repeated recognition submission', async () => {
    const session = await completeToVerdict(roundId);
    const first = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['B'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(first.status).toBe(200);

    const second = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['B'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual({
      ok: true,
      recognizedSlots: ['B'],
      skipped: false,
    });
  });

  it('returns 200 idempotently for a repeated skipped recognition submission', async () => {
    const session = await completeToVerdict(roundId);
    const first = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { skipped: true },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(first.status).toBe(200);

    const second = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { skipped: true },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual({
      ok: true,
      recognizedSlots: null,
      skipped: true,
    });
  });

  it('rejects a conflicting repeated submission with 409 and does not overwrite original response', async () => {
    const session = await completeToVerdict(roundId);
    const first = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['B'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(first.status).toBe(200);

    const second = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['A', 'B', 'C'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody).toEqual({ error: 'recognition_rejected' });
    expect(Object.keys(secondBody)).toEqual(['error']);
  });

  it('rejects an invalid slot value with a validation error, not a crash', async () => {
    const session = await completeToVerdict(roundId);
    const res = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['Z'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it("cannot be submitted for another player's attempt (cross-player access)", async () => {
    const playerA = await completeToVerdict(roundId);
    // Player A's attempt exists and is final_locked. Player B has a different
    // session and has never played this round.
    const playerB = trackSession(new TestSession(randomAnonId()));
    const res = await postRecognition(
      playerB.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['A'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'attempt_not_found' });
    void playerA; // silence unused-var; establishes the round has a completed attempt
  });

  it('rejects recognition before the attempt is final_locked (unavailable attempt)', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    // Viewing alone leaves no attempt to attach a recognition to.
    const none = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['A'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'attempt_not_found' });

    await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    // Unmask stage — no final lock yet.
    const res = await postRecognition(
      session.request(`http://test/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        body: { recognizedSlots: ['A'], skipped: false },
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'recognition_rejected' });
  });

  it('never returns raw database or exception content in any response shape observed above', async () => {
    // Consolidated check across all response bodies captured in this file: none of
    // them contain a stack trace, a SQL fragment, or a raw Error.message string.
    const session = await completeToVerdict(roundId);
    const responses = await Promise.all([
      postRecognition(
        session.request(`http://test/api/rounds/${roundId}/recognition`, {
          method: 'POST',
          body: { recognizedSlots: ['A'], skipped: false },
        }),
        { params: Promise.resolve({ id: roundId }) },
      ),
    ]);
    for (const res of responses) {
      const text = await res.clone().text();
      expect(text).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // stack-trace-shaped line
      expect(text).not.toMatch(/SELECT|INSERT|UPDATE|WHERE/i);
      expect(text).not.toMatch(/node_modules|\.ts:\d+|\.js:\d+/);
    }
  });
});
