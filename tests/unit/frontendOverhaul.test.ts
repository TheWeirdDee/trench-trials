import { describe, expect, it } from 'vitest';
import { bucketDirection, bucketLabel, bucketLevel, CLUE_META, CLUE_ORDER } from '@/components/clueDisplay';
import { canonicalize } from '@/lib/domain/canonical';
import { computeCommitment } from '@/lib/domain/commitment';

describe('Clue display', () => {
  it('maps down, neutral and up buckets to meter levels 1, 2 and 3', () => {
    for (const b of ['sell-heavy', 'slowing', 'outward', 'falling']) {
      expect(bucketDirection(b)).toBe('down');
      expect(bucketLevel(b)).toBe(1);
    }
    for (const b of ['balanced', 'steady', 'flat']) {
      expect(bucketDirection(b)).toBe('neutral');
      expect(bucketLevel(b)).toBe(2);
    }
    for (const b of ['buy-heavy', 'accelerating', 'inward', 'rising']) {
      expect(bucketDirection(b)).toBe('up');
      expect(bucketLevel(b)).toBe(3);
    }
  });

  it('labels buckets in sentence case without hyphens', () => {
    expect(bucketLabel('buy-heavy')).toBe('Buy heavy');
    expect(bucketLabel('slowing')).toBe('Slowing');
  });

  it('has a title and a definition for each of the four clues, in display order', () => {
    expect(CLUE_ORDER).toEqual(['buySellBalance', 'tradingAcceleration', 'netflowOverLiquidity', 'recentMomentum']);
    expect(CLUE_META.buySellBalance.hint).toContain('volume');
    expect(CLUE_META.tradingAcceleration.hint).toContain('volume');
    expect(CLUE_META.netflowOverLiquidity.hint).toContain('liquidity');
    expect(CLUE_META.recentMomentum.hint).toContain('seven days');
  });
});

describe('Browser-side canonicalization', () => {
  it('matches the server commitment for the same manifest regardless of key order', () => {
    const nonce = 'ab'.repeat(32);
    const a = { z: 1, a: { y: [3, { k: 'v', b: 2 }], x: null } };
    const b = { a: { x: null, y: [3, { b: 2, k: 'v' }] }, z: 1 };
    expect(canonicalize({ manifest: a, nonce })).toBe(canonicalize({ manifest: b, nonce }));
    expect(computeCommitment(a, nonce)).toBe(computeCommitment(b, nonce));
  });
});
