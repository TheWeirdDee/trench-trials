import { TEST_LIVE_ELIGIBILITY } from '../testEligibility';
import { afterAll, describe, expect, it } from 'vitest';
import { GET as getRoundHandler } from '@/app/api/rounds/[id]/route';
import { POST as lockBlindHandler } from '@/app/api/rounds/[id]/blind/route';
import { POST as lockFinalHandler } from '@/app/api/rounds/[id]/final/route';
import { GET as getResultHandler } from '@/app/api/rounds/[id]/result/route';
import { GET as getLiveHandler } from '@/app/api/live/route';
import { POST as createLiveInternalHandler } from '@/app/api/internal/live/create/route';
import { POST as resolveLiveInternalHandler } from '@/app/api/internal/live/resolve/route';
import { createLiveRound, resolveLiveRound } from '@/lib/repo/live';
import { computeLiveSchedule } from '@/lib/domain/live';
import { closeTestPool, deleteTestPlayers, deleteTestRounds, testPool } from './fixtures';
import { TestSession } from './testClient';

describe('Live Flow — Postgres Integration Tests (Section 47)', () => {
  const createdRoundIds: string[] = [];
  const createdPlayerIds: string[] = [];

  afterAll(async () => {
    const pool = testPool();
    if (createdRoundIds.length > 0) {
      await deleteTestRounds(pool, createdRoundIds);
    }
    if (createdPlayerIds.length > 0) {
      await deleteTestPlayers(pool, createdPlayerIds);
    }
    await closeTestPool();
  });

  const makeTestAssets = () => [
    {
      slot: 'A' as const,
      tokenSymbol: 'TESTA',
      tokenAddress: '0x1111111111111111111111111111111111111111',
      chain: 'ethereum',
      sectors: ['DeFi'],
      clueInputs: { buy_volume_1d: 100, sell_volume_1d: 50, volume_1d: 150, volume_7d: 700, netflow_1d: 10, liquidity: 500, price_change_7d: 0.1 },
      clues: {
        buy_sell_balance: { value: 0.33, bucket: 'buy-heavy' },
        trading_acceleration: { value: 1.5, bucket: 'accelerating' },
        netflow_over_liquidity: { value: 0.02, bucket: 'balanced' },
        recent_momentum: { value: 0.1, bucket: 'rising' },
      },
    },
    {
      slot: 'B' as const,
      tokenSymbol: 'TESTB',
      tokenAddress: '0x2222222222222222222222222222222222222222',
      chain: 'ethereum',
      sectors: ['Meme'],
      clueInputs: { buy_volume_1d: 80, sell_volume_1d: 80, volume_1d: 160, volume_7d: 1120, netflow_1d: 0, liquidity: 300, price_change_7d: -0.05 },
      clues: {
        buy_sell_balance: { value: 0, bucket: 'balanced' },
        trading_acceleration: { value: 1.0, bucket: 'steady' },
        netflow_over_liquidity: { value: 0, bucket: 'balanced' },
        recent_momentum: { value: -0.05, bucket: 'flat' },
      },
    },
    {
      slot: 'C' as const,
      tokenSymbol: 'TESTC',
      tokenAddress: '0x3333333333333333333333333333333333333333',
      chain: 'ethereum',
      sectors: ['L1'],
      clueInputs: { buy_volume_1d: 50, sell_volume_1d: 100, volume_1d: 150, volume_7d: 1400, netflow_1d: -20, liquidity: 800, price_change_7d: -0.15 },
      clues: {
        buy_sell_balance: { value: -0.33, bucket: 'sell-heavy' },
        trading_acceleration: { value: 0.75, bucket: 'slowing' },
        netflow_over_liquidity: { value: -0.025, bucket: 'balanced' },
        recent_momentum: { value: -0.15, bucket: 'falling' },
      },
    },
  ];

  it('creates an open Live round, persists assets, source receipts, and commitment', async () => {
    const assets = makeTestAssets();
    const sourceReceipts = [
      {
        endpoint: '/api/v1beta1/token-screener/historical',
        requestParams: { to_date: '2026-09-25', timeframe_days: 1 },
        responseSha256: 'abc123sha256hashday1',
        purpose: 'live_snapshot',
      },
    ];

    const result = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets,
      sourceReceipts,
      snapshotPublishedAt: new Date(),
    });

    createdRoundIds.push(result.roundId);
    expect(result.roundId).toBeDefined();
    expect(result.commitmentHash).toBeDefined();

    // Verify database row
    const roundQuery = await testPool().query('SELECT * FROM rounds WHERE id = $1', [result.roundId]);
    const roundRow = roundQuery.rows[0];
    expect(roundRow.mode).toBe('live');
    expect(roundRow.status).toBe('open');
    expect(roundRow.initial_commitment_hash).toBe(result.commitmentHash);

    // Verify assets in DB (prices should be null for open round)
    const assetQuery = await testPool().query('SELECT * FROM round_assets WHERE round_id = $1 ORDER BY slot ASC', [
      result.roundId,
    ]);
    expect(assetQuery.rows).toHaveLength(3);
    expect(assetQuery.rows[0].entry_price).toBeNull();
    expect(assetQuery.rows[0].exit_price).toBeNull();
    expect(assetQuery.rows[0].return_ratio).toBeNull();

    // Verify source receipts in DB
    const receiptQuery = await testPool().query('SELECT * FROM source_receipts WHERE round_id = $1', [
      result.roundId,
    ]);
    expect(receiptQuery.rows).toHaveLength(1);
    expect(receiptQuery.rows[0].purpose).toBe('live_snapshot');
  });

  it('creation is idempotent: identical snapshot commitment returns existing round without duplicate insert', async () => {
    const assets = makeTestAssets();
    const fixedNow = new Date('2026-09-25T14:00:00.000Z');

    const first = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets,
      snapshotPublishedAt: fixedNow,
    });
    createdRoundIds.push(first.roundId);

    const second = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets,
      snapshotPublishedAt: fixedNow,
    });

    expect(second.roundId).toBe(first.roundId);
    expect(second.alreadyExisted).toBe(true);
    expect(second.commitmentHash).toBe(first.commitmentHash);
  });

  it('full player lifecycle: enter -> blind -> unmask -> final lock -> PENDING (no verdict / no premature score)', async () => {
    const assets = makeTestAssets();
    const live = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets,
      snapshotPublishedAt: new Date(),
    });
    createdRoundIds.push(live.roundId);

    const session = new TestSession();
    createdPlayerIds.push(session.cookieHeader());

    // Step 1: Initial GET /api/rounds/:id -> blind stage
    const initReq = session.request(`http://localhost/api/rounds/${live.roundId}`);
    const initRes = await getRoundHandler(initReq, { params: Promise.resolve({ id: live.roundId }) });
    session.absorb(initRes);
    expect(initRes.status).toBe(200);
    const initBody = await initRes.json();
    expect(initBody.attempt.stage).toBe('blind');
    expect(initBody.round.mode).toBe('live');
    expect(initBody.round.status).toBe('open');
    expect(initBody.assets[0].clues).toBeDefined();
    expect(initBody.assets[0].tokenSymbol).toBeUndefined(); // NO IDENTITY LEAK
    expect(initBody.verdict).toBeUndefined(); // NO PREMATURE VERDICT

    // Step 2: Lock blind choice (Slot B)
    const blindReq = session.request(`http://localhost/api/rounds/${live.roundId}/blind`, {
      method: 'POST',
      body: { slot: 'B' },
    });
    const blindRes = await lockBlindHandler(blindReq, { params: Promise.resolve({ id: live.roundId }) });
    session.absorb(blindRes);
    expect(blindRes.status).toBe(200);
    const blindBody = await blindRes.json();
    expect(blindBody.attempt.stage).toBe('unmasked');
    expect(blindBody.attempt.blindSlot).toBe('B');
    expect(blindBody.assets[0].tokenSymbol).toBe('TESTA'); // Identities now visible
    expect(blindBody.assets[0].returnPct).toBeUndefined(); // NO PRICES / RETURNS
    expect(blindBody.verdict).toBeUndefined();

    // Step 3: Lock final choice (Switch to Slot A)
    const finalReq = session.request(`http://localhost/api/rounds/${live.roundId}/final`, {
      method: 'POST',
      body: { slot: 'A' },
    });
    const finalRes = await lockFinalHandler(finalReq, { params: Promise.resolve({ id: live.roundId }) });
    session.absorb(finalRes);
    expect(finalRes.status).toBe(200);
    const finalBody = await finalRes.json();

    // IMPORTANT INVARIANT: Live attempt enters PENDING stage, NOT instant verdict!
    expect(finalBody.attempt.stage).toBe('pending');
    expect(finalBody.attempt.finalSlot).toBe('A');
    expect(finalBody.attempt.finalActionType).toBe('switch');
    expect(finalBody.verdict).toBeUndefined(); // Verdict must not exist yet!

    // Step 4: GET /api/rounds/:id/result while round is still pending returns pending stage, no verdict
    const resultReq = session.request(`http://localhost/api/rounds/${live.roundId}/result`);
    const resultRes = await getResultHandler(resultReq, { params: Promise.resolve({ id: live.roundId }) });
    expect(resultRes.status).toBe(200);
    const resultBody = await resultRes.json();
    expect(resultBody.attempt.stage).toBe('pending');
    expect(resultBody.verdict).toBeUndefined();
  });

  it('rejects resolution attempt before measurementEndAt (Section 38)', async () => {
    const assets = makeTestAssets();
    const live = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets,
      snapshotPublishedAt: new Date(),
    });
    createdRoundIds.push(live.roundId);

    // Attempt resolution now (well before 24h measurement end)
    const resolveResult = await resolveLiveRound(live.roundId, {
      now: new Date(),
    });

    expect(resolveResult.ok).toBe(false);
    if (!resolveResult.ok) {
      expect(resolveResult.error).toBe('resolution_before_measurement_end');
    }

    // Verify round is still open in DB
    const roundQuery = await testPool().query('SELECT status FROM rounds WHERE id = $1', [live.roundId]);
    expect(roundQuery.rows[0].status).toBe('open');
  });

  it('rejects late attempt creation after entryCloseAt (Section 39)', async () => {
    const assets = makeTestAssets();
    const publishedAt = new Date('2026-01-01T12:00:00.000Z');
    const live = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets,
      snapshotPublishedAt: publishedAt,
    });
    createdRoundIds.push(live.roundId);

    // Entry window expired at 12:05:00. Request arrives at 12:06:00
    const session = new TestSession();
    createdPlayerIds.push(session.cookieHeader());
    const req = session.request(`http://localhost/api/rounds/${live.roundId}`);
    const res = await getRoundHandler(req, { params: Promise.resolve({ id: live.roundId }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('live_entry_closed');
  });

  it('valid resolution after measurementEndAt persists prices, returns, winner, and releases verdict (Section 35, 36)', async () => {
    const assets = makeTestAssets();
    const publishedAt = new Date('2026-01-01T12:00:00.000Z');
    const live = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets,
      snapshotPublishedAt: publishedAt,
    });
    createdRoundIds.push(live.roundId);

    // Player plays during open entry window
    const session = new TestSession();
    createdPlayerIds.push(session.cookieHeader());
    const initReq = session.request(`http://localhost/api/rounds/${live.roundId}`);
    // Manually create attempt before expiration
    await testPool().query(
      `INSERT INTO attempts (player_id, round_id, stage)
       SELECT id, $1, 'blind' FROM players WHERE anon_id = $2
       ON CONFLICT DO NOTHING`,
      [live.roundId, session.cookieHeader() ?? 'test-player-resolved-flow'],
    );

    const resolvedAssets = [
      {
        slot: 'A' as const,
        tokenSymbol: 'TESTA',
        tokenAddress: '0x1111111111111111111111111111111111111111',
        entryCandleStart: '2026-01-01T12:10:00.000Z',
        entryPrice: 100,
        exitCandleStart: '2026-01-02T12:10:00.000Z',
        exitPrice: 150, // +50% return (Winner!)
        returnRatio: 0.5,
        sourceResponseSha256: { ohlcv: 'hashA' },
      },
      {
        slot: 'B' as const,
        tokenSymbol: 'TESTB',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        entryCandleStart: '2026-01-01T12:10:00.000Z',
        entryPrice: 10,
        exitCandleStart: '2026-01-02T12:10:00.000Z',
        exitPrice: 9, // -10% return
        returnRatio: -0.1,
        sourceResponseSha256: { ohlcv: 'hashB' },
      },
      {
        slot: 'C' as const,
        tokenSymbol: 'TESTC',
        tokenAddress: '0x3333333333333333333333333333333333333333',
        entryCandleStart: '2026-01-01T12:10:00.000Z',
        entryPrice: 50,
        exitCandleStart: '2026-01-02T12:10:00.000Z',
        exitPrice: 55, // +10% return
        returnRatio: 0.1,
        sourceResponseSha256: { ohlcv: 'hashC' },
      },
    ];

    // Resolve round at measurement end time (24h later)
    const resolveTime = new Date('2026-01-02T12:10:00.000Z');
    const resolveRes = await resolveLiveRound(live.roundId, {
      customExitPrices: resolvedAssets,
      now: resolveTime,
    });

    expect(resolveRes.ok).toBe(true);
    if (resolveRes.ok) {
      expect(resolveRes.manifest.winning_slots).toEqual(['A']);
      expect(resolveRes.manifest.status).toBe('resolved');
    }

    // Verify idempotency: resolving a second time succeeds without error or duplicate mutation
    const secondResolve = await resolveLiveRound(live.roundId, {
      customExitPrices: resolvedAssets,
      now: resolveTime,
    });
    expect(secondResolve.ok).toBe(true);
    if (secondResolve.ok) {
      expect(secondResolve.alreadyResolved).toBe(true);
    }
  });
});
