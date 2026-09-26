import { describe, it, expect, afterAll } from 'vitest';
import {
  testPool,
  closeTestPool,
  CANONICAL_ROUND_IDS,
  deleteTestRounds,
  deleteTestPlayers,
  assignTestDaily,
  deleteOwnedTestDaily,
  insertSyntheticRound,
  randomAnonId,
} from './fixtures';

describe('Cleanup Safety and Protection Tests', () => {
  const pool = testPool();

  afterAll(async () => {
    await closeTestPool();
  });

  it('strictly refuses to delete the verified Replay round', async () => {
    const replayId = 'be497aab-d46e-4d40-a5fb-3fbf0f0d29ca';
    // Attempting to delete the canonical Replay round must be a no-op
    await deleteTestRounds(pool, [replayId]);

    const res = await pool.query('SELECT id, mode, status FROM rounds WHERE id = $1', [replayId]);
    expect(res.rows.length).toBe(1);
    expect(['ready', 'resolved']).toContain(res.rows[0].status);

    const assets = await pool.query('SELECT count(*) FROM round_assets WHERE round_id = $1', [replayId]);
    expect(Number(assets.rows[0].count)).toBe(3);

    const receipts = await pool.query('SELECT count(*) FROM source_receipts WHERE round_id = $1', [replayId]);
    expect(Number(receipts.rows[0].count)).toBe(9);
  });

  it('strictly refuses to delete the invalid Live audit round', async () => {
    const liveId = 'df397565-caab-4208-8737-9b1d208177d7';
    // Attempting to delete the canonical Live audit round must be a no-op
    await deleteTestRounds(pool, [liveId]);

    const res = await pool.query('SELECT id, mode, status, invalid_reason FROM rounds WHERE id = $1', [liveId]);
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].status).toBe('invalid');
    expect(res.rows[0].invalid_reason).toBe('invalid_price_boundary_policy');

    const assets = await pool.query('SELECT count(*) FROM round_assets WHERE round_id = $1', [liveId]);
    expect(Number(assets.rows[0].count)).toBe(3);

    const receipts = await pool.query('SELECT count(*) FROM source_receipts WHERE round_id = $1', [liveId]);
    expect(Number(receipts.rows[0].count)).toBe(2);
  });

  it('strictly throws and refuses to delete a player not in the test-* namespace', async () => {
    const productionAnonId = '80aab5ba-2d96-4190-b74a-5fdcba05d352';

    await expect(deleteTestPlayers(pool, [productionAnonId])).rejects.toThrow(
      /SAFETY REFUSAL: Cannot delete non-test player/,
    );
  });

  it('only deletes exact test-created rounds and preserves future real rounds', async () => {
    // Insert a test round
    const { roundId: testRoundId } = await insertSyntheticRound({ mode: 'replay' });

    // Verify it exists
    const before = await pool.query('SELECT id FROM rounds WHERE id = $1', [testRoundId]);
    expect(before.rows.length).toBe(1);

    // Delete ONLY this test round
    await deleteTestRounds(pool, [testRoundId]);

    const after = await pool.query('SELECT id FROM rounds WHERE id = $1', [testRoundId]);
    expect(after.rows.length).toBe(0);

    // Verify canonical rounds still exist
    for (const canonicalId of CANONICAL_ROUND_IDS) {
      const canonical = await pool.query('SELECT id FROM rounds WHERE id = $1', [canonicalId]);
      expect(canonical.rows.length).toBe(1);
    }
  });

  it('deletes only the exact test-owned Daily row and refuses any other', async () => {
    const testDate = '2099-12-31';
    const { roundId: testRoundId } = await insertSyntheticRound({ mode: 'daily' });
    const { roundId: otherRoundId } = await insertSyntheticRound({ mode: 'daily' });
    const rowsOnDate = async () =>
      (await pool.query('SELECT round_id FROM daily_challenges WHERE utc_date = $1::date', [testDate])).rows;

    try {
      const owned = await assignTestDaily(pool, testDate, testRoundId);

      // Same date, different round: not the row this test created — refused, nothing deleted.
      await expect(deleteOwnedTestDaily(pool, { utcDate: testDate, roundId: otherRoundId })).rejects.toThrow(
        /SAFETY REFUSAL/,
      );
      // An occupied date fails closed instead of being displaced.
      await expect(assignTestDaily(pool, testDate, otherRoundId)).rejects.toThrow(/SAFETY REFUSAL/);
      expect(await rowsOnDate()).toEqual([{ round_id: testRoundId }]);

      await deleteOwnedTestDaily(pool, owned);
      expect(await rowsOnDate()).toEqual([]);
    } finally {
      await deleteTestRounds(pool, [testRoundId, otherRoundId]);
    }
  });
});
