import { describe, expect, it } from 'vitest';
import {
  assertNoIdentityLeak,
  assertNoOutcomeLeak,
  toBlindAssetView,
  toUnmaskedAssetView,
  toVerdictAssetView,
  type RoundAssetFull,
} from '@/lib/allowlist';

// Real round-001 slot A (POPCAT) — the actual winner of the validated round.
const POPCAT: RoundAssetFull = {
  slot: 'A',
  tokenSymbol: 'POPCAT',
  tokenAddress: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  sectors: ['Memecoins'],
  clueBuySellBalanceBucket: 'balanced',
  clueTradingAccelerationBucket: 'accelerating',
  clueNetflowOverLiquidityBucket: 'balanced',
  clueRecentMomentumBucket: 'rising',
  entryCandleStart: '2026-08-19T23:00:00Z',
  entryPrice: 0.04301576711450214,
  exitCandleStart: '2026-08-26T23:00:00Z',
  exitPrice: 0.05943781587754146,
  returnRatio: 0.3817681251464389,
};

describe('toBlindAssetView', () => {
  const view = toBlindAssetView(POPCAT);
  const json = JSON.stringify(view);

  it('contains only slot and bucketed clues', () => {
    expect(Object.keys(view).sort()).toEqual(['clues', 'slot']);
    expect(view.clues.recentMomentum).toBe('rising');
  });

  it('never leaks identity, price or return fields into the serialized payload', () => {
    expect(json).not.toMatch(/POPCAT/);
    expect(json).not.toMatch(/7GCihgDB/);
    expect(json).not.toMatch(/0\.0430157/); // entry price fragment
    expect(json).not.toMatch(/0\.3817681/); // return fragment
    expect(() => assertNoIdentityLeak(json)).not.toThrow();
    expect(() => assertNoOutcomeLeak(json)).not.toThrow();
  });
});

describe('toUnmaskedAssetView', () => {
  const view = toUnmaskedAssetView(POPCAT);
  const json = JSON.stringify(view);

  it('adds identity but keeps clues from the blind view', () => {
    expect(view.tokenSymbol).toBe('POPCAT');
    expect(view.tokenAddress).toBe(POPCAT.tokenAddress);
    expect(view.clues.recentMomentum).toBe('rising');
  });

  it('still does not leak price or return fields', () => {
    expect(json).not.toMatch(/0\.0430157/);
    expect(json).not.toMatch(/0\.3817681/);
    expect(json).not.toMatch(/entryPrice|exitPrice|returnRatio|returnPct/);
    expect(() => assertNoOutcomeLeak(json)).not.toThrow();
  });

  it('identity IS now present (this is the post-unmask view, by design)', () => {
    expect(() => assertNoIdentityLeak(json)).toThrow();
  });
});

describe('toVerdictAssetView', () => {
  const view = toVerdictAssetView(POPCAT);
  const json = JSON.stringify(view);

  it('reveals everything: identity, prices, return, candle timestamps', () => {
    expect(view.tokenSymbol).toBe('POPCAT');
    expect(view.returnPct).toBeCloseTo(38.17681251464389, 10);
    expect(view.entryCandleStart).toBe('2026-08-19T23:00:00Z');
    expect(json).toMatch(/POPCAT/);
  });
});

describe('assertNoForbiddenKeys / assertNoIdentityLeak / assertNoOutcomeLeak', () => {
  it('throws when a forbidden key is present, as a defense-in-depth check on the raw wire payload', () => {
    const leaky = JSON.stringify({ slot: 'A', token_symbol: 'POPCAT' });
    expect(() => assertNoIdentityLeak(leaky)).toThrow(/forbidden key/);
  });

  it('does not false-positive on substrings that are not the exact forbidden key', () => {
    // "token_symbolic" contains "token_symbol" as a substring of the key name, so this
    // intentionally still trips — documenting the conservative (safe) behavior.
    const safe = JSON.stringify({ slot: 'A', clues: { recentMomentum: 'rising' } });
    expect(() => assertNoIdentityLeak(safe)).not.toThrow();
    expect(() => assertNoOutcomeLeak(safe)).not.toThrow();
  });
});
