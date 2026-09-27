import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAllTestFixtures,
  closeTestPool,
  deletePlayers,
  deleteRounds,
  insertRealRound001,
  insertSyntheticRound,
  randomAnonId,
  testPool,
} from './fixtures';
import { extractSessionCookie, guestIdFromCookie, makeRequest, TestSession } from './testClient';

import { GET as getRound } from '@/app/api/rounds/[id]/route';
import { POST as postBlind } from '@/app/api/rounds/[id]/blind/route';
import { POST as postFinal } from '@/app/api/rounds/[id]/final/route';
import { GET as getResult } from '@/app/api/rounds/[id]/result/route';
import { GET as getNext } from '@/app/api/rounds/next/route';
import { GET as getSummary } from '@/app/api/me/summary/route';
import { GET as getHistory } from '@/app/api/history/route';
import { computeCommitment } from '@/lib/domain/commitment';

/**
 * Requires a real DATABASE_URL with migrations applied. Skips cleanly (not a
 * failure) when DATABASE_URL is unset, so `npm test` stays green without a database
 * — see SETUP.md for how to point this at a dedicated test database.
 */
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

maybeDescribe('Replay flow — one real end-to-end round from round-001.json (real Nansen data)', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertRealRound001();
    roundId = trackRound(id);
  });

  it('blind stage: no identity, no prices, no returns anywhere in the response', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    const res = await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    session.absorb(res);
    const json = await res.json();
    const raw = JSON.stringify(json);

    expect(json.attempt.stage).toBe('blind');
    expect(json.assets).toHaveLength(3);
    for (const asset of json.assets) {
      expect(Object.keys(asset).sort()).toEqual(['clues', 'slot']);
    }
    expect(raw).not.toMatch(/POPCAT|YZY|BOME/);
    expect(raw).not.toMatch(/7GCihgDB|DrZ26cKJ|ukHH6c7m/); // addresses
    expect(raw).not.toMatch(/entryPrice|exitPrice|returnRatio|returnPct/);
    expect(raw).not.toMatch(/provenance|manifest|nonce/); // the sealed commitment stays sealed
    // No exact cutoff or resolution before verdict, in any field — only a coarse period.
    expect(json.round.exactCutoff).toBeUndefined();
    expect(raw).not.toMatch(/2026-08-20|2026-08-27/);
    expect(json.round.entryCloseAt).toBeNull();
    expect(json.round.measurementEndAt).toBeNull();
    expect(json.round.coarsePeriod).toBe('August 2026');
  });

  it('lock blind (slot B / YZY, the non-winner) -> identities revealed, still no prices', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    const initial = await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    session.absorb(initial);

    const res = await postBlind(session.request(`http://test/api/rounds/${roundId}/blind`, {
      method: 'POST',
      body: { slot: 'B' },
    }), { params: Promise.resolve({ id: roundId }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.attempt.stage).toBe('unmasked');
    expect(json.attempt.blindSlot).toBe('B');
    expect(json.attempt.finalDeadlineAt).toBeTruthy();

    const raw = JSON.stringify(json);
    const slotB = json.assets.find((a: { slot: string }) => a.slot === 'B');
    expect(slotB.tokenSymbol).toBe('YZY');
    // Identity is now present, but outcome and exact dates still must not leak.
    expect(raw).not.toMatch(/entryPrice|exitPrice|returnRatio|returnPct|entryCandleStart/);
    expect(raw).not.toMatch(/2026-08-20|2026-08-27/);
    expect(raw).not.toMatch(/provenance|manifest|nonce/);
  });

  it('switch to slot A (POPCAT, the real winner) at final lock -> verdict reveals the real +38.18% return and helped', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    const afterGet = await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    session.absorb(afterGet);

    await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'B' } }),
      { params: Promise.resolve({ id: roundId }) },
    );

    const finalRes = await postFinal(
      session.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    const finalJson = await finalRes.json();

    expect(finalRes.status).toBe(200);
    expect(finalJson.attempt.stage).toBe('final_locked');
    expect(finalJson.verdict.finalActionType).toBe('switch');
    expect(finalJson.verdict.winningSlots).toEqual(['A']);
    expect(finalJson.verdict.finalReturnPct).toBeCloseTo(38.17681251464389, 6);
    expect(finalJson.verdict.blindReturnPct).toBeCloseTo(2.068354937005612, 6);
    expect(finalJson.verdict.switchImpactPp).toBeCloseTo(36.1, 1);
    expect(finalJson.verdict.switchOutcome).toBe('helped');
    expect(finalJson.verdict.pointsAwarded).toBe(100);
    // Verdict reveals the exact cutoff.
    expect(finalJson.round.exactCutoff).toBe('2026-08-20T00:00:00.000Z');

    // ...and opens the sealed commitment: anyone can recompute it from what the verdict returns.
    const [reveal, ...others] = finalJson.provenance.commitments;
    expect(others).toEqual([]);
    expect(reveal.kind).toBe('initial');
    expect(reveal.hash).toBe(finalJson.provenance.commitmentHash);
    expect(computeCommitment(reveal.manifest, reveal.nonce)).toBe(reveal.hash);
    expect(reveal.manifest.assets.map((a: { token_symbol: string }) => a.token_symbol)).toEqual(['POPCAT', 'YZY', 'BOME']);

    // GET /result independently returns the same verdict.
    const resultRes = await getResult(session.request(`http://test/api/rounds/${roundId}/result`), {
      params: Promise.resolve({ id: roundId }),
    });
    const resultJson = await resultRes.json();
    expect(resultRes.status).toBe(200);
    expect(resultJson.verdict.switchImpactPp).toBeCloseTo(36.1, 1);
  });
});

maybeDescribe('Session cookie issuance', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertSyntheticRound();
    roundId = trackRound(id);
  });

  it('a first visit issues no cookie and creates nothing; the first Blind Pick issues a signed HttpOnly cookie', async () => {
    const first = await getRound(makeRequest(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toBeNull();
    expect((await first.json()).attempt).toMatchObject({ id: null, stage: 'blind' });

    const lock = await postBlind(
      makeRequest(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(lock.status).toBe(200);
    const issued = lock.headers.get('set-cookie') ?? '';
    expect(issued).toMatch(/tt_anon_id=v1\.[^.;]+\.[^;]+/);
    expect(issued).toMatch(/HttpOnly/i);
    expect(issued).toMatch(/SameSite=lax/i);
    const guestId = guestIdFromCookie(extractSessionCookie(lock)!);
    expect(guestId).toBeTruthy();
    anonIdsToClean.push(guestId!);

    const session = new TestSession(guestId!);
    const again = await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    expect(again.headers.get('set-cookie')).toBeNull(); // no re-issue for a known cookie
    expect((await again.json()).attempt.stage).toBe('unmasked'); // refresh recovers the attempt
  });

  it('never adopts a forged or unsigned cookie as an identity', async () => {
    const forgedId = randomAnonId();
    const forged = await postBlind(
      makeRequest(`http://test/api/rounds/${roundId}/blind`, {
        method: 'POST',
        body: { slot: 'B' },
        rawCookie: forgedId,
      }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(forged.status).toBe(200);
    const issuedId = guestIdFromCookie(extractSessionCookie(forged)!);
    expect(issuedId).toBeTruthy();
    expect(issuedId).not.toBe(forgedId);
    anonIdsToClean.push(issuedId!);

    const adopted = await testPool().query('SELECT 1 FROM players WHERE anon_id = $1', [forgedId]);
    expect(adopted.rowCount).toBe(0);
  });
});

maybeDescribe('Reads never create state (lazy guest creation)', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertSyntheticRound();
    roundId = trackRound(id);
  });

  it('GET round, next, result, summary and history create no player or attempt, with or without a cookie', async () => {
    const counts = async () =>
      (
        await testPool().query<{ players: number; attempts: number }>(
          'SELECT (SELECT count(*)::int FROM players) AS players, (SELECT count(*)::int FROM attempts) AS attempts',
        )
      ).rows[0];
    const before = await counts();

    const unseenGuest = new TestSession(randomAnonId()); // valid signed cookie, no player row
    for (const req of [makeRequest, (url: string) => unseenGuest.request(url)]) {
      await getRound(req(`http://test/api/rounds/${roundId}`), { params: Promise.resolve({ id: roundId }) });
      await getResult(req(`http://test/api/rounds/${roundId}/result`), { params: Promise.resolve({ id: roundId }) });
      await getNext(req('http://test/api/rounds/next'));
      await getSummary(req('http://test/api/me/summary'));
      await getHistory(req('http://test/api/history'));
    }

    expect(await counts()).toEqual(before);
    const created = await testPool().query('SELECT 1 FROM players WHERE anon_id = $1', [unseenGuest.cookieHeader()]);
    expect(created.rowCount).toBe(0);
  });
});

maybeDescribe('Immutability and idempotency', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertSyntheticRound();
    roundId = trackRound(id);
  });

  it('cannot change the blind choice after it is locked', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });

    const first = await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(first.status).toBe(200);

    const second = await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'C' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(second.status).toBe(409);

    const check = await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    const checkJson = await check.json();
    expect(checkJson.attempt.blindSlot).toBe('A'); // unchanged
  });

  it('resubmitting the same blind choice is idempotent (duplicate request / second tab)', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });

    const first = await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'B' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    const firstJson = await first.json();

    const second = await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'B' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    const secondJson = await second.json();

    expect(second.status).toBe(200);
    expect(secondJson.attempt.finalDeadlineAt).toBe(firstJson.attempt.finalDeadlineAt);
  });

  it('refresh/reopen does not reset the decision deadline', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    const lockRes = await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    const lockJson = await lockRes.json();

    await new Promise((r) => setTimeout(r, 50));

    const refreshRes = await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    const refreshJson = await refreshRes.json();

    expect(refreshJson.attempt.finalDeadlineAt).toBe(lockJson.attempt.finalDeadlineAt);
  });

  it('final choice cannot be changed after it is locked', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    const first = await postFinal(
      session.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(first.status).toBe(200);

    const second = await postFinal(
      session.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'B' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    const secondJson = await second.json();
    expect(secondJson.attempt.finalSlot).toBe('A'); // unchanged despite requesting B
  });
});

maybeDescribe('Timeout handling', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertSyntheticRound({ decisionWindowSeconds: 1 });
    roundId = trackRound(id);
  });

  it('retains the blind choice and records timeout, not an explicit stick, when the window expires', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'B' } }),
      { params: Promise.resolve({ id: roundId }) },
    );

    await new Promise((r) => setTimeout(r, 1200)); // let the 1s window expire

    const lateAttempt = await postFinal(
      session.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'C' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(lateAttempt.status).toBe(409);
    const lateJson = await lateAttempt.json();
    expect(lateJson.attempt.finalActionType).toBe('timeout');
    expect(lateJson.attempt.finalSlot).toBe('B'); // retained, NOT the late 'C' click

    const result = await getResult(session.request(`http://test/api/rounds/${roundId}/result`), {
      params: Promise.resolve({ id: roundId }),
    });
    const resultJson = await result.json();
    expect(result.status).toBe(200);
    expect(resultJson.verdict.finalActionType).toBe('timeout');
    expect(resultJson.verdict.switchOutcome).toBeNull();
  });
});

maybeDescribe('Cross-player isolation', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertSyntheticRound();
    roundId = trackRound(id);
  });

  it("player B cannot read player A's result by requesting the same round", async () => {
    const playerA = trackSession(new TestSession(randomAnonId()));
    await getRound(playerA.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    await postBlind(
      playerA.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    await postFinal(
      playerA.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );

    // Player B has a completely different session cookie and their own attempt, locked
    // at Blind Pick only — entirely separate from A's completed one.
    const playerB = trackSession(new TestSession(randomAnonId()));
    await postBlind(
      playerB.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'B' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    const resultForB = await getResult(playerB.request(`http://test/api/rounds/${roundId}/result`), {
      params: Promise.resolve({ id: roundId }),
    });
    expect(resultForB.status).toBe(403); // B's own attempt is not final_locked; A's verdict is never served
    const bodyForB = await resultForB.json();
    expect(bodyForB.stage).toBe('unmasked');
    expect(bodyForB.verdict).toBeUndefined();

    // Merely viewing the round creates nothing, so a viewer's result lookup is a clean 404.
    const viewerB2 = trackSession(new TestSession(randomAnonId()));
    await getRound(viewerB2.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    const resultForViewer = await getResult(viewerB2.request(`http://test/api/rounds/${roundId}/result`), {
      params: Promise.resolve({ id: roundId }),
    });
    expect(resultForViewer.status).toBe(404);
    expect(JSON.stringify(await resultForViewer.json())).not.toMatch(/TESTA|TESTB|TESTC/);

    // And without ever having viewed the round at all, B's result lookup is a clean 404 — not an error revealing anything about A's attempt.
    const strangerC = trackSession(new TestSession(randomAnonId()));
    const resultForC = await getResult(strangerC.request(`http://test/api/rounds/${roundId}/result`), {
      params: Promise.resolve({ id: roundId }),
    });
    expect(resultForC.status).toBe(404);
  });
});

maybeDescribe('Simultaneous requests', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertSyntheticRound();
    roundId = trackRound(id);
  });

  it('two concurrent blind-lock requests for the same attempt converge on one winner, not two', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });

    const [resA, resB] = await Promise.all([
      postBlind(
        session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'A' } }),
        { params: Promise.resolve({ id: roundId }) },
      ),
      postBlind(
        session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'B' } }),
        { params: Promise.resolve({ id: roundId }) },
      ),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one request wins (200); the other is rejected as already-locked (409).
    expect(statuses).toEqual([200, 409]);

    const finalCheck = await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    const finalJson = await finalCheck.json();
    expect(['A', 'B']).toContain(finalJson.attempt.blindSlot);
  });

  it('two concurrent final-lock requests for the same attempt do not create duplicate decisions', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'C' } }),
      { params: Promise.resolve({ id: roundId }) },
    );

    const [resA, resB] = await Promise.all([
      postFinal(
        session.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'C' } }),
        { params: Promise.resolve({ id: roundId }) },
      ),
      postFinal(
        session.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'A' } }),
        { params: Promise.resolve({ id: roundId }) },
      ),
    ]);

    // One request locks the final choice; the other observes it already locked
    // (idempotent replay) — both return 200, but only one FinalActionType sticks.
    expect([resA.status, resB.status]).toEqual([200, 200]);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA.attempt.finalSlot).toBe(bodyB.attempt.finalSlot); // identical authoritative outcome
    expect(['A', 'C']).toContain(bodyA.attempt.finalSlot);

    const finalLockEvents = await testPool().query(
      `SELECT de.slot FROM decision_events de
       JOIN attempts a ON a.id = de.attempt_id
       WHERE a.round_id = $1 AND de.event_type = 'final_lock'`,
      [roundId],
    );
    expect(finalLockEvents.rows.length).toBe(1); // exactly one final_lock event, never two
  });
});

maybeDescribe('Decision event audit trail', () => {
  let roundId: string;

  beforeAll(async () => {
    const { roundId: id } = await insertRealRound001();
    roundId = trackRound(id);
  });

  it('persists exactly one blind_lock, one identity_disclosure, and one final_lock event in chronological order', async () => {
    const session = trackSession(new TestSession(randomAnonId()));
    const initial = await getRound(session.request(`http://test/api/rounds/${roundId}`), {
      params: Promise.resolve({ id: roundId }),
    });
    expect((await initial.json()).attempt.id).toBeNull(); // viewing creates no attempt

    const blindRes = await postBlind(
      session.request(`http://test/api/rounds/${roundId}/blind`, { method: 'POST', body: { slot: 'B' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(blindRes.status).toBe(200);
    const attemptId = (await blindRes.json()).attempt.id;

    const finalRes = await postFinal(
      session.request(`http://test/api/rounds/${roundId}/final`, { method: 'POST', body: { slot: 'A' } }),
      { params: Promise.resolve({ id: roundId }) },
    );
    expect(finalRes.status).toBe(200);

    const events = await testPool().query(
      `SELECT event_type, slot, action_type, occurred_at FROM decision_events
       WHERE attempt_id = $1 ORDER BY occurred_at ASC, event_type ASC`,
      [attemptId],
    );

    const byType = new Map(events.rows.map((r) => [r.event_type, r]));
    expect(events.rows.filter((r) => r.event_type === 'blind_lock')).toHaveLength(1);
    expect(events.rows.filter((r) => r.event_type === 'identity_disclosure')).toHaveLength(1);
    expect(events.rows.filter((r) => r.event_type === 'final_lock')).toHaveLength(1);

    expect(byType.get('blind_lock')?.slot).toBe('B');
    expect(byType.get('final_lock')?.slot).toBe('A');
    expect(byType.get('final_lock')?.action_type).toBe('switch');

    // Chronology proves the player genuinely saw identity-revealing evidence
    // (identity_disclosure) before locking the final choice — this is the auditable
    // trail the switch-impact measurement depends on for its epistemic claim.
    const blindAt = new Date(byType.get('blind_lock').occurred_at).getTime();
    const disclosureAt = new Date(byType.get('identity_disclosure').occurred_at).getTime();
    const finalAt = new Date(byType.get('final_lock').occurred_at).getTime();
    expect(disclosureAt).toBeGreaterThanOrEqual(blindAt);
    expect(finalAt).toBeGreaterThanOrEqual(disclosureAt);
  });
});
