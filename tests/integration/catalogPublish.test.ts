import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignTestDaily,
  buildSyntheticRound,
  closeTestPool,
  dbTodayUtc,
  deleteOwnedTestDaily,
  deleteTestPlayers,
  deleteTestRounds,
  insertSyntheticRound,
  TEST_DAILY_SOURCE,
  testPool,
  type OwnedTestDaily,
} from './fixtures';
import { TestSession } from './testClient';

import { GET as getNext } from '@/app/api/rounds/next/route';
import { GET as getRound } from '@/app/api/rounds/[id]/route';
import { POST as postBlind } from '@/app/api/rounds/[id]/blind/route';
import { POST as postFinal } from '@/app/api/rounds/[id]/final/route';
import { ELIGIBILITY_POLICY_VERSION } from '@/lib/domain/assetPolicy';
import { playerFacingSql } from '@/lib/domain/eligibility';
import { PublishRefused, publishReviewedRounds, type PublishPlan } from '@/lib/repo/catalogPublish';
import { insertVerifiedRound } from '@/lib/repo/verifiedRoundImport';
import { REPLAY_FORGE_VERSION } from '@/lib/services/replayForge';

/**
 * Regression: reviewed candidates are published, rejected and scheduled as a Daily in one
 * transaction, only from the exact catalog state the reviewer saw. A refused plan writes
 * nothing; a rejected round is recorded as withdrawn with its reason, keeps its data and is
 * never served; the scheduled Daily round is held out of Replay; approved rounds are served
 * without leaking identities or the outcome before their stage.
 */
const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

const roundIds: string[] = [];
const anonIds: string[] = [];
const dailies: OwnedTestDaily[] = [];
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

let today = '';
let dailyDate = '';
let forDaily = '';
let forReplay = '';
let forReject = '';
let baseline: PublishPlan['expect'] = { approved: [], dailies: {} };

/** A pending Round Forge candidate with one (synthetic, test-only) source receipt. */
async function pendingCandidate(): Promise<string> {
  const round = { ...buildSyntheticRound(), round_forge_version: REPLAY_FORGE_VERSION };
  const { roundId } = await insertVerifiedRound(testPool(), round);
  roundIds.push(roundId);
  await testPool().query(
    `INSERT INTO source_receipts (round_id, endpoint, request_params, retrieved_at, response_sha256)
     VALUES ($1, 'synthetic-test-fixture', '{}'::jsonb, now(), 'synthetic-test-fixture')`,
    [roundId],
  );
  return roundId;
}

function plan(overrides: Partial<PublishPlan> = {}): PublishPlan {
  return {
    expect: baseline,
    approve: [
      { round: forDaily, note: 'integration test: approved' },
      { round: forReplay, note: 'integration test: approved' },
    ],
    reject: [{ round: forReject, note: 'catalog_quality_repeat_winner' }],
    daily: { date: dailyDate, round: forDaily },
    ...overrides,
  };
}

async function statuses(): Promise<Record<string, string>> {
  const res = await testPool().query<{ id: string; eligibility_status: string }>(
    'SELECT id, eligibility_status FROM rounds WHERE id = ANY($1::uuid[])',
    [[forDaily, forReplay, forReject]],
  );
  return Object.fromEntries(res.rows.map((r) => [r.id, r.eligibility_status]));
}

async function expectRefusedAndUntouched(p: PublishPlan, reason: RegExp): Promise<void> {
  const events = await testPool().query('SELECT count(*)::int AS n FROM round_eligibility_events WHERE round_id = ANY($1::uuid[])', [
    [forDaily, forReplay, forReject],
  ]);
  await expect(publishReviewedRounds(p, 'integration-test', { confirm: true, dailySource: TEST_DAILY_SOURCE })).rejects.toThrow(reason);
  expect(Object.values(await statuses())).toEqual(['pending_review', 'pending_review', 'pending_review']);
  const after = await testPool().query('SELECT count(*)::int AS n FROM round_eligibility_events WHERE round_id = ANY($1::uuid[])', [
    [forDaily, forReplay, forReject],
  ]);
  expect(after.rows[0].n).toBe(events.rows[0].n);
  const daily = await testPool().query('SELECT 1 FROM daily_challenges WHERE utc_date = $1::date AND round_id = $2', [dailyDate, forDaily]);
  expect(daily.rowCount).toBe(0);
}

/** A guest who has already played every approved Replay round except the ones this file creates. */
async function primedGuest(): Promise<TestSession> {
  const s = new TestSession();
  anonIds.push(s.cookieHeader());
  const player = await testPool().query<{ id: string }>('INSERT INTO players (anon_id) VALUES ($1) RETURNING id', [s.cookieHeader()]);
  await testPool().query(
    `INSERT INTO attempts (player_id, round_id, stage, is_repeat)
     SELECT $1, r.id, 'blind', false FROM rounds r
     WHERE r.mode = 'replay' AND r.eligibility_status = 'approved' AND r.eligibility_policy_version = $2
       AND r.id <> ALL($3::uuid[])`,
    [player.rows[0]!.id, ELIGIBILITY_POLICY_VERSION, [forDaily, forReplay, forReject]],
  );
  return s;
}

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  const pool = testPool();
  today = await dbTodayUtc(pool);
  dailyDate = addDays(today, 3650);
  forDaily = await pendingCandidate();
  forReplay = await pendingCandidate();
  forReject = await pendingCandidate();
  const facing = await pool.query<{ id: string }>(`SELECT r.id FROM rounds r WHERE ${playerFacingSql('r')}`);
  const scheduled = await pool.query<{ utc_date: string; round_id: string }>(
    'SELECT utc_date::text, round_id FROM daily_challenges WHERE utc_date >= $1::date',
    [today],
  );
  baseline = {
    approved: facing.rows.map((r) => r.id),
    dailies: Object.fromEntries(scheduled.rows.map((r) => [r.utc_date, r.round_id])),
  };
});

afterAll(async () => {
  if (!DB_AVAILABLE) return;
  const pool = testPool();
  for (const d of dailies) await deleteOwnedTestDaily(pool, d);
  await deleteTestRounds(pool, roundIds);
  await deleteTestPlayers(pool, anonIds);
  await closeTestPool();
});

maybeDescribe('Catalog publishing — approvals, rejections and the Daily commit together, from the reviewed state only', () => {
  it('refuses the whole plan, writing nothing, when the catalog differs from the reviewed state', async () => {
    // Another round became player-facing since review.
    const extra = (await insertSyntheticRound()).roundId;
    roundIds.push(extra);
    await expectRefusedAndUntouched(plan(), /player-facing rounds are/);
    await testPool().query(`UPDATE rounds SET eligibility_status = 'withdrawn' WHERE id = $1`, [extra]);

    // A pending candidate is left undecided.
    await expectRefusedAndUntouched(plan({ reject: [] }), /pending v4 candidates|pending v\d+ candidates/);

    // The Daily date is already taken: never replaced.
    const occupant = (await insertSyntheticRound()).roundId;
    roundIds.push(occupant);
    const owned = await assignTestDaily(testPool(), dailyDate, occupant);
    try {
      await expectRefusedAndUntouched(plan({ expect: { ...baseline, dailies: { ...baseline.dailies, [dailyDate]: occupant } } }), /already has a Daily/);
      await expectRefusedAndUntouched(plan(), /unexpected Daily rows/);
    } finally {
      await deleteOwnedTestDaily(testPool(), owned);
    }
    await testPool().query(`UPDATE rounds SET eligibility_status = 'withdrawn' WHERE id = $1`, [occupant]);

    // A Daily in the past, or for a round that would not be player-facing.
    await expectRefusedAndUntouched(plan({ daily: { date: addDays(today, -1), round: forDaily } }), /before today/);
    await expectRefusedAndUntouched(plan({ daily: { date: dailyDate, round: forReject } }), /would not be player-facing/);
  });

  it('the dry run checks everything and writes nothing', async () => {
    const report = await publishReviewedRounds(plan(), 'integration-test', { confirm: false });
    expect(report.written).toBe(false);
    expect(Object.values(await statuses())).toEqual(['pending_review', 'pending_review', 'pending_review']);
  });

  it('approves, rejects and schedules the Daily in one transaction, keeping the rejected round’s data', async () => {
    const receiptsBefore = await testPool().query('SELECT count(*)::int AS n FROM source_receipts WHERE round_id = $1', [forReject]);
    const report = await publishReviewedRounds(plan(), 'integration-test', { confirm: true, dailySource: TEST_DAILY_SOURCE });
    dailies.push({ utcDate: dailyDate, roundId: forDaily });
    expect(report.written).toBe(true);
    expect(report.playerFacing.sort()).toEqual([...baseline.approved, forDaily, forReplay].sort());
    expect(await statuses()).toEqual({ [forDaily]: 'approved', [forReplay]: 'approved', [forReject]: 'withdrawn' });

    const rejected = await testPool().query(
      `SELECT r.eligibility_note, r.initial_commitment_hash, e.from_status, e.to_status, e.note
       FROM rounds r JOIN round_eligibility_events e ON e.round_id = r.id WHERE r.id = $1`,
      [forReject],
    );
    expect(rejected.rows).toHaveLength(1);
    expect(rejected.rows[0]).toMatchObject({
      eligibility_note: 'catalog_quality_repeat_winner',
      from_status: 'pending_review',
      to_status: 'withdrawn',
      note: 'catalog_quality_repeat_winner',
    });
    expect(rejected.rows[0].initial_commitment_hash).toMatch(/^[0-9a-f]{64}$/);
    const receiptsAfter = await testPool().query('SELECT count(*)::int AS n FROM source_receipts WHERE round_id = $1', [forReject]);
    expect(receiptsAfter.rows[0].n).toBe(receiptsBefore.rows[0].n);
    const assets = await testPool().query('SELECT count(*)::int AS n FROM round_assets WHERE round_id = $1', [forReject]);
    expect(assets.rows[0].n).toBe(3);

    const daily = await testPool().query('SELECT round_id, assignment_source FROM daily_challenges WHERE utc_date = $1::date', [dailyDate]);
    expect(daily.rows).toEqual([{ round_id: forDaily, assignment_source: TEST_DAILY_SOURCE }]);
    for (const [date, id] of Object.entries(baseline.dailies)) {
      const row = await testPool().query('SELECT round_id FROM daily_challenges WHERE utc_date = $1::date', [date]);
      expect(row.rows[0]?.round_id).toBe(id);
    }

    // A second run of the same plan is refused: the state it was reviewed against is gone.
    await expect(publishReviewedRounds(plan(), 'integration-test', { confirm: true, dailySource: TEST_DAILY_SOURCE })).rejects.toBeInstanceOf(
      PublishRefused,
    );
  });

  it('Replay then serves only the unscheduled approved round; the scheduled Daily is held and the rejected round never served', async () => {
    const s = await primedGuest();
    const first = await (await getNext(s.request('http://localhost/api/rounds/next'))).json();
    expect(first).toMatchObject({ available: true, roundId: forReplay });
    expect(first.progress.reservedForDaily).toBeGreaterThanOrEqual(1);

    const blind = await postBlind(
      s.request(`http://localhost/api/rounds/${forReplay}/blind`, { method: 'POST', body: { slot: 'A' } }),
      params(forReplay),
    );
    expect(blind.status).toBe(200);
    s.absorb(blind);
    expect((await postFinal(s.request(`http://localhost/api/rounds/${forReplay}/final`, { method: 'POST', body: { slot: 'A' } }), params(forReplay))).status).toBe(200);

    const after = await (await getNext(s.request('http://localhost/api/rounds/next'))).json();
    expect(after.available).toBe(false);
    expect(after.roundId).toBeUndefined();

    const fresh = new TestSession();
    anonIds.push(fresh.cookieHeader());
    expect((await getRound(fresh.request(`http://localhost/api/rounds/${forReject}`), params(forReject))).status).toBe(404);
    const lock = await postBlind(
      fresh.request(`http://localhost/api/rounds/${forReject}/blind`, { method: 'POST', body: { slot: 'A' } }),
      params(forReject),
    );
    expect(lock.status).not.toBe(200);
    const attempts = await testPool().query('SELECT count(*)::int AS n FROM attempts WHERE round_id = $1', [forReject]);
    expect(attempts.rows[0].n).toBe(0);
  });

  it('a newly approved round leaks no identity, cutoff or outcome before its stage', async () => {
    const s = new TestSession();
    anonIds.push(s.cookieHeader());
    const res = await getRound(s.request(`http://localhost/api/rounds/${forDaily}`), params(forDaily));
    expect(res.status).toBe(200);
    s.absorb(res);
    const blind = await res.json();
    expect(blind.attempt.stage).toBe('blind');
    for (const asset of blind.assets) expect(Object.keys(asset).sort()).toEqual(['clues', 'slot']);
    expect(blind.round.exactCutoff).toBeUndefined();
    const blindRaw = JSON.stringify(blind);
    expect(blindRaw).not.toMatch(/TESTA|TESTB|TESTC|TEST_FIXTURE_ADDRESS/);
    expect(blindRaw).not.toMatch(/entryPrice|exitPrice|returnRatio|returnPct|provenance|manifest|nonce/);
    expect(blindRaw).not.toMatch(/2026-01-01|2026-01-08/);

    const unmask = await postBlind(s.request(`http://localhost/api/rounds/${forDaily}/blind`, { method: 'POST', body: { slot: 'B' } }), params(forDaily));
    expect(unmask.status).toBe(200);
    const unmaskRaw = JSON.stringify(await unmask.json());
    expect(unmaskRaw).toMatch(/TESTB/);
    expect(unmaskRaw).not.toMatch(/entryPrice|exitPrice|returnRatio|returnPct|entryCandleStart|provenance|manifest|nonce/);
    expect(unmaskRaw).not.toMatch(/2026-01-01|2026-01-08/);
  });
});
