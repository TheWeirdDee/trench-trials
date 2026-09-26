import { describe, expect, it } from 'vitest';
import {
  ceilToFiveMinuteBoundary,
  computeLiveSchedule,
  deriveLivePhase,
  isLiveEntryAllowed,
  isLiveFinalLockAllowed,
  isLiveResolutionAllowed,
  isLiveResolutionTimedOut,
  buildLiveInitialManifest,
  buildLiveResolutionManifest,
  createLiveCommitment,
  type LiveCandidateAsset,
} from '@/lib/domain/live';
import { canonicalize, computeCommitment, verifyCommitment } from '@/lib/domain/commitment';
import { computeReturn, determineWinningSlots, TIE_TOLERANCE_PP, TIE_TOLERANCE_RATIO } from '@/lib/domain/returns';
import { switchImpactPp, tickerTaxPp } from '@/lib/domain/scoring';

describe('5-Minute Candle Boundary Alignment (Correction B, Section 10)', () => {
  it('aligns timestamps cleanly to exact 5-minute UTC candle boundaries', () => {
    // Already on 5m boundary -> unchanged
    const b1 = ceilToFiveMinuteBoundary(new Date('2026-09-25T12:00:00.000Z'));
    expect(b1.toISOString()).toBe('2026-09-25T12:00:00.000Z');

    // 1ms past boundary -> rounds up to next 5m boundary
    const b2 = ceilToFiveMinuteBoundary(new Date('2026-09-25T12:00:00.001Z'));
    expect(b2.toISOString()).toBe('2026-09-25T12:05:00.000Z');

    // 12:06:00.629Z -> rounds up to 12:10:00.000Z
    const b3 = ceilToFiveMinuteBoundary(new Date('2026-09-25T12:06:00.629Z'));
    expect(b3.toISOString()).toBe('2026-09-25T12:10:00.000Z');

    // 12:04:59.999Z -> rounds up to 12:05:00.000Z
    const b4 = ceilToFiveMinuteBoundary(new Date('2026-09-25T12:04:59.999Z'));
    expect(b4.toISOString()).toBe('2026-09-25T12:05:00.000Z');

    // Seconds and milliseconds must be zero
    expect(b3.getUTCSeconds()).toBe(0);
    expect(b3.getUTCMilliseconds()).toBe(0);
    expect(b3.getUTCMinutes() % 5).toBe(0);
  });
});

describe('Authoritative Live Phase Derivation & Boundary Tests (Correction A, Section 5, 6)', () => {
  const entryCloseAt = new Date('2026-09-25T12:05:00.000Z');
  const measurementStartAt = new Date('2026-09-25T12:10:00.000Z');
  const measurementEndAt = new Date('2026-09-26T12:10:00.000Z');

  it('reports terminal status immediately regardless of timestamps', () => {
    expect(
      deriveLivePhase({
        status: 'resolved',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: new Date('2026-09-25T12:00:00.000Z'),
      }),
    ).toBe('RESOLVED');

    expect(
      deriveLivePhase({
        status: 'invalid',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: new Date('2026-09-25T12:00:00.000Z'),
      }),
    ).toBe('INVALID');
  });

  it('tests exact boundaries: entryCloseAt -1ms, exact, +1ms', () => {
    // entryCloseAt - 1ms -> ENTRY_OPEN
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: new Date(entryCloseAt.getTime() - 1),
      }),
    ).toBe('ENTRY_OPEN');

    // entryCloseAt -> FINAL_LOCK_WINDOW
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: entryCloseAt,
      }),
    ).toBe('FINAL_LOCK_WINDOW');

    // entryCloseAt + 1ms -> FINAL_LOCK_WINDOW
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: new Date(entryCloseAt.getTime() + 1),
      }),
    ).toBe('FINAL_LOCK_WINDOW');
  });

  it('tests exact boundaries: measurementStartAt -1ms, exact, +1ms', () => {
    // measurementStartAt - 1ms -> FINAL_LOCK_WINDOW
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: new Date(measurementStartAt.getTime() - 1),
      }),
    ).toBe('FINAL_LOCK_WINDOW');

    // measurementStartAt -> MEASURING
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: measurementStartAt,
      }),
    ).toBe('MEASURING');

    // measurementStartAt + 1ms -> MEASURING
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: new Date(measurementStartAt.getTime() + 1),
      }),
    ).toBe('MEASURING');
  });

  it('tests exact boundaries: measurementEndAt -1ms, exact, +1ms', () => {
    // measurementEndAt - 1ms -> MEASURING
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: new Date(measurementEndAt.getTime() - 1),
      }),
    ).toBe('MEASURING');

    // measurementEndAt -> RESOLVING
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: measurementEndAt,
      }),
    ).toBe('RESOLVING');

    // measurementEndAt + 1ms -> RESOLVING
    expect(
      deriveLivePhase({
        status: 'open',
        entryCloseAt,
        measurementStartAt,
        measurementEndAt,
        now: new Date(measurementEndAt.getTime() + 1),
      }),
    ).toBe('RESOLVING');
  });
});

describe('Live Schedule & Boundaries (Section 9, 10, 11)', () => {
  const basePublishedAt = new Date('2026-09-25T12:00:00.000Z');

  it('computes exact 5-minute entry close, 5m-aligned measurement start, and +24h measurement end', () => {
    const schedule = computeLiveSchedule(basePublishedAt);

    // 5 minutes = 300 seconds
    expect(schedule.entryCloseAt.toISOString()).toBe('2026-09-25T12:05:00.000Z');

    // Measurement start = ceilToFiveMinuteBoundary(12:05 + 60s = 12:06) -> 12:10:00.000Z
    expect(schedule.measurementStartAt.toISOString()).toBe('2026-09-25T12:10:00.000Z');

    // Measurement end = measurement start + 24 hours -> 2026-09-26T12:10:00.000Z
    expect(schedule.measurementEndAt.toISOString()).toBe('2026-09-26T12:10:00.000Z');

    // Horizon duration is exactly 24 hours (86,400,000 ms)
    const horizonMs = schedule.measurementEndAt.getTime() - schedule.measurementStartAt.getTime();
    expect(horizonMs).toBe(24 * 3600 * 1000);

    // 6 hour retry deadline
    expect(schedule.retryDeadlineAt.toISOString()).toBe('2026-09-26T18:10:00.000Z');
  });

  it('enforces entry allowance strictly within the entry window', () => {
    const schedule = computeLiveSchedule(basePublishedAt);

    // Snapshot publication time: allowed
    expect(isLiveEntryAllowed(schedule, new Date('2026-09-25T12:00:00.000Z'))).toBe(true);

    // 4m 59s: allowed
    expect(isLiveEntryAllowed(schedule, new Date('2026-09-25T12:04:59.000Z'))).toBe(true);

    // Exactly at 5m (entry close): REJECTED
    expect(isLiveEntryAllowed(schedule, new Date('2026-09-25T12:05:00.000Z'))).toBe(false);

    // 5m 01s: REJECTED
    expect(isLiveEntryAllowed(schedule, new Date('2026-09-25T12:05:01.000Z'))).toBe(false);
  });

  it('enforces final lock deadline strictly before measurement start', () => {
    const schedule = computeLiveSchedule(basePublishedAt);

    // During entry window: allowed
    expect(isLiveFinalLockAllowed(schedule, new Date('2026-09-25T12:04:00.000Z'))).toBe(true);

    // In safety buffer before measurement start: allowed
    expect(isLiveFinalLockAllowed(schedule, new Date('2026-09-25T12:09:59.000Z'))).toBe(true);

    // Exactly at measurement start (12:10:00): REJECTED
    expect(isLiveFinalLockAllowed(schedule, new Date('2026-09-25T12:10:00.000Z'))).toBe(false);
  });
});

describe('Live Commitment Determinism & Canonical Serialization (Section 14, 26, 27)', () => {
  const dummyAssets: LiveCandidateAsset[] = [
    {
      slot: 'A',
      tokenSymbol: 'PEPE',
      tokenAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      chain: 'solana',
      sectors: ['Meme'],
      clueInputs: { buy_volume_1d: 100, sell_volume_1d: 80, volume_1d: 180, volume_7d: 1000, netflow_1d: 20, liquidity: 500, price_change_7d: 0.1 },
      clues: {
        buy_sell_balance: { value: 0.111, bucket: 'buy-heavy' },
        trading_acceleration: { value: 1.26, bucket: 'accelerating' },
        netflow_over_liquidity: { value: 0.04, bucket: 'balanced' },
        recent_momentum: { value: 0.1, bucket: 'rising' },
      },
    },
    {
      slot: 'B',
      tokenSymbol: 'UNI',
      tokenAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      chain: 'solana',
      sectors: ['DeFi', 'DEX'],
      clueInputs: { buy_volume_1d: 200, sell_volume_1d: 220, volume_1d: 420, volume_7d: 2800, netflow_1d: -10, liquidity: 2000, price_change_7d: -0.02 },
      clues: {
        buy_sell_balance: { value: -0.047, bucket: 'balanced' },
        trading_acceleration: { value: 1.05, bucket: 'steady' },
        netflow_over_liquidity: { value: -0.005, bucket: 'balanced' },
        recent_momentum: { value: -0.02, bucket: 'flat' },
      },
    },
    {
      slot: 'C',
      tokenSymbol: 'LINK',
      tokenAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      chain: 'solana',
      sectors: ['Infrastructure', 'Oracle'],
      clueInputs: { buy_volume_1d: 150, sell_volume_1d: 100, volume_1d: 250, volume_7d: 1400, netflow_1d: 30, liquidity: 1200, price_change_7d: 0.08 },
      clues: {
        buy_sell_balance: { value: 0.2, bucket: 'buy-heavy' },
        trading_acceleration: { value: 1.25, bucket: 'steady' },
        netflow_over_liquidity: { value: 0.025, bucket: 'balanced' },
        recent_momentum: { value: 0.08, bucket: 'rising' },
      },
    },
  ];

  const schedule = computeLiveSchedule(new Date('2026-09-25T12:00:00.000Z'));

  it('produces identical commitment hash regardless of object key order', () => {
    const manifest1 = buildLiveInitialManifest({
      chain: 'solana',
      schedule,
      assets: dummyAssets,
    });

    const manifest2 = JSON.parse(JSON.stringify(manifest1)); // cloned

    const fixedNonce = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const hash1 = computeCommitment(manifest1, fixedNonce);
    const hash2 = computeCommitment(manifest2, fixedNonce);

    expect(hash1).toBe(hash2);
    expect(verifyCommitment(manifest1, fixedNonce, hash1)).toBe(true);
  });

  it('commitment changes if any committed field changes (Section 27)', () => {
    const manifest = buildLiveInitialManifest({
      chain: 'solana',
      schedule,
      assets: dummyAssets,
    });
    const fixedNonce = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const originalHash = computeCommitment(manifest, fixedNonce);

    // Tamper 1: candidate identity
    const t1 = JSON.parse(JSON.stringify(manifest));
    t1.assets[0].token_symbol = 'SHIB';
    expect(computeCommitment(t1, fixedNonce)).not.toBe(originalHash);

    // Tamper 2: candidate order / slot
    const t2 = JSON.parse(JSON.stringify(manifest));
    t2.assets[0].slot = 'B';
    t2.assets[1].slot = 'A';
    expect(computeCommitment(t2, fixedNonce)).not.toBe(originalHash);

    // Tamper 3: clue bucket
    const t3 = JSON.parse(JSON.stringify(manifest));
    t3.assets[0].clues.buy_sell_balance.bucket = 'sell-heavy';
    expect(computeCommitment(t3, fixedNonce)).not.toBe(originalHash);

    // Tamper 4: measurementStartAt
    const t4 = JSON.parse(JSON.stringify(manifest));
    t4.measurement_start_at = '2026-09-25T12:15:00.000Z';
    expect(computeCommitment(t4, fixedNonce)).not.toBe(originalHash);

    // Tamper 5: measurementEndAt
    const t5 = JSON.parse(JSON.stringify(manifest));
    t5.measurement_end_at = '2026-09-26T12:15:00.000Z';
    expect(computeCommitment(t5, fixedNonce)).not.toBe(originalHash);

    // Tamper 6: price timeframe
    const t6 = JSON.parse(JSON.stringify(manifest));
    t6.price_policy.timeframe = '1h';
    expect(computeCommitment(t6, fixedNonce)).not.toBe(originalHash);

    // Tamper 7: price field
    const t7 = JSON.parse(JSON.stringify(manifest));
    t7.price_policy.price_field = 'close';
    expect(computeCommitment(t7, fixedNonce)).not.toBe(originalHash);

    // Tamper 8: provider
    const t8 = JSON.parse(JSON.stringify(manifest));
    t8.price_policy.provider = 'Other';
    expect(computeCommitment(t8, fixedNonce)).not.toBe(originalHash);

    // Tamper 9: tie tolerance
    const t9 = JSON.parse(JSON.stringify(manifest));
    t9.price_policy.tie_tolerance_pp = 0.05;
    expect(computeCommitment(t9, fixedNonce)).not.toBe(originalHash);
  });
});

describe('Return, Switch Impact & Winner Calculations (Section 26-30)', () => {
  it('computes exact unrounded returns with validation', () => {
    const r = computeReturn(100, 138.18);
    expect(r).toBeCloseTo(0.3818, 6);

    expect(() => computeReturn(0, 100)).toThrow('Invalid entry price: 0');
    expect(() => computeReturn(-10, 100)).toThrow('Invalid entry price: -10');
    expect(() => computeReturn(100, -5)).toThrow('Invalid exit price: -5');
    expect(() => computeReturn(100, NaN)).toThrow('Invalid exit price: NaN');
  });

  it('calculates switch impact with exact sign and units', () => {
    const rBlind = 0.0207; // +2.07%
    const rFinal = 0.3818; // +38.18%
    const impact = switchImpactPp(rBlind, rFinal);
    expect(impact).toBeCloseTo(36.11, 2);
  });

  it('calculates ticker tax with exact sign matching PRD', () => {
    const rBlind = 0.3818;
    const rFinal = 0.0207;
    const tax = tickerTaxPp(rBlind, rFinal);
    expect(tax).toBeCloseTo(36.11, 2);
  });

  it('determines single winner from unrounded returns', () => {
    const returns = {
      A: 0.3818,
      B: 0.0207,
      C: 0.2089,
    };
    expect(determineWinningSlots(returns)).toEqual(['A']);
  });

  it('handles 0.01 percentage point tie tolerance (Section 29)', () => {
    // 0.01pp = 0.0001 return ratio
    const returnsWithTie = {
      A: 0.25005,
      B: 0.25000, // 0.00005 below max, within 0.0001 (0.01pp) tie tolerance
      C: 0.10000,
    };
    const winners = determineWinningSlots(returnsWithTie);
    expect(winners).toContain('A');
    expect(winners).toContain('B');
    expect(winners).not.toContain('C');
  });
});
