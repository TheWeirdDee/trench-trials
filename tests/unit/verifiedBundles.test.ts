import { describe, expect, it } from 'vitest';
import { REPLAY_FORGE_VERSION } from '@/lib/services/replayForge';
import { loadVerifiedBundles, VERIFIED_BUNDLE_FILE } from '@/lib/repo/verifiedBundles';

/**
 * Regression: a fresh clone imports the full approved catalog. The bundles in
 * data/verified-rounds/ must be exactly the six approved rounds, each leak-free, internally
 * consistent and carrying provenance (request IDs and response hashes, never raw bodies).
 */
const APPROVED_CATALOG = [
  'c5e34c58-24aa-4c91-87ef-e063247eb613',
  'd2ecc59b-cefd-46d6-90c0-966720441afe',
  '67d694e4-c82a-46a2-b76a-1579c00c999d',
  'd06b6bc2-b289-4ea0-8e7e-afebd4aa5a44',
  '15b4670e-0152-45d3-83e2-3d52d9b4be7d',
  '50e1edc8-b062-4821-b334-4cc8135aea85',
];
/** Candidates reviewed and not published: their data stays in the database only. */
const NOT_PUBLISHED = ['c0f61751-2f70-47bc-9bb4-1e89843af665'];

const bundles = loadVerifiedBundles();
const sourceIds = bundles.map((b) => (b.bundle as unknown as { source: { round_id: string } }).source.round_id);

describe('Verified bundles — the fresh-clone catalog', () => {
  it('holds exactly the six approved rounds, and no rejected or withdrawn round', () => {
    expect(bundles).toHaveLength(6);
    expect([...sourceIds].sort()).toEqual([...APPROVED_CATALOG].sort());
    for (const id of NOT_PUBLISHED) expect(sourceIds).not.toContain(id);
    expect(VERIFIED_BUNDLE_FILE.test('round-001.json')).toBe(false);
  });

  it('every round is leak-free (Round Forge v4) and its returns and winner recompute', () => {
    for (const { file, bundle } of bundles) {
      const { round } = bundle;
      expect(round.round_forge_version, file).toBeGreaterThanOrEqual(REPLAY_FORGE_VERSION);
      expect(round.mode, file).toBe('replay');
      const returns = Object.fromEntries(
        round.assets.map((a) => {
          const recomputed = a.price.exit_close / a.price.entry_close - 1;
          expect(Math.abs(recomputed - a.return), `${file} ${a.slot}`).toBeLessThan(1e-9);
          return [a.slot, recomputed];
        }),
      );
      const best = Math.max(...Object.values(returns));
      const winners = Object.keys(returns).filter((slot) => best - returns[slot]! <= 0.0001);
      expect(winners, file).toContain(round.winner_slot);
    }
  });

  it('carries provenance only: five receipts each with a unique request ID and SHA-256, and no raw bodies', () => {
    const requestIds = new Set<string>();
    for (const { file, bundle } of bundles) {
      expect(bundle.receipts, file).toHaveLength(5);
      for (const r of bundle.receipts) {
        expect(Object.keys(r).sort(), file).toEqual(
          ['creditsUsed', 'endpoint', 'purpose', 'requestId', 'requestParams', 'responseSha256', 'retrievedAt'].sort(),
        );
        expect(r.responseSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(requestIds.has(r.requestId!), `${file}: request ${r.requestId} reused`).toBe(false);
        requestIds.add(r.requestId!);
      }
      expect(Object.keys(bundle).sort(), file).toEqual(['format', 'note', 'receipts', 'round', 'source']);
    }
    expect(requestIds.size).toBe(30);
  });

  it('no two rounds share two tokens (no near-duplicates in the catalog)', () => {
    const tokenSets = bundles.map(({ file, bundle }) => ({ file, tokens: new Set(bundle.round.assets.map((a) => a.token_address)) }));
    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        const shared = [...tokenSets[i]!.tokens].filter((t) => tokenSets[j]!.tokens.has(t));
        expect(shared.length, `${tokenSets[i]!.file} and ${tokenSets[j]!.file}`).toBeLessThan(2);
      }
    }
  });
});
