/**
 * Replaces the round of an already-assigned Daily date, keeping an audit record on the
 * row itself (`prior_round_id`, `replaced_at`, `replacement_reason`) and in the log. Used
 * when an eligibility review withdraws the round a Daily pointed at.
 *
 * Refuses unless: the new round is player-facing (approved under the current policy), is
 * a canonical Replay round never used as a Daily, and NO attempt exists on the old round —
 * so nobody's Daily result can change underneath them.
 *
 * Usage:
 *   npm run reassign:daily -- --date YYYY-MM-DD --round <new uuid> --reason "..."            # dry run
 *   npm run reassign:daily -- --date YYYY-MM-DD --round <new uuid> --reason "..." --confirm
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { dbSchema, getPool, withTransaction } from '../src/lib/db';
import { playerFacingSql } from '../src/lib/domain/eligibility';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const date = arg('date');
  const roundId = arg('round');
  const reason = arg('reason');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date YYYY-MM-DD is required');
  if (!roundId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roundId)) throw new Error('--round <uuid> is required');
  if (!reason?.trim()) throw new Error('--reason is required');

  const pool = getPool();
  const current = (
    await pool.query<{ round_id: string; attempts: number }>(
      `SELECT dc.round_id, (SELECT count(*)::int FROM attempts a WHERE a.round_id = dc.round_id) AS attempts
       FROM daily_challenges dc WHERE dc.utc_date = $1::date`,
      [date],
    )
  ).rows[0];
  if (!current) throw new Error(`No Daily is assigned for ${date}; use npm run assign:daily`);
  console.log(`Daily ${date} (schema ${dbSchema() ?? 'public'}): ${current.round_id} → ${roundId}; attempts on the current round: ${current.attempts}`);
  if (!confirm) {
    console.log('\nDry run: nothing written. Re-run with --confirm to reassign.');
    return;
  }

  await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('trench_trials.daily_assignment'))`);
    const locked = await client.query<{ round_id: string }>(`SELECT round_id FROM daily_challenges WHERE utc_date = $1::date FOR UPDATE`, [date]);
    const oldRound = locked.rows[0]?.round_id;
    if (!oldRound) throw new Error('The Daily row disappeared');
    const attempts = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM attempts WHERE round_id = $1`, [oldRound]);
    if (attempts.rows[0]!.n !== 0) throw new Error(`Refusing: ${attempts.rows[0]!.n} attempt(s) exist on ${oldRound}`);
    const ok = await client.query(
      `SELECT 1 FROM rounds r WHERE r.id = $1 AND r.mode = 'replay' AND r.repeat_of IS NULL
         AND r.status IN ('ready', 'resolved') AND ${playerFacingSql('r')}
         AND EXISTS (SELECT 1 FROM source_receipts sr WHERE sr.round_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM daily_challenges dc WHERE dc.round_id = r.id)`,
      [roundId],
    );
    if (!ok.rowCount) throw new Error('Refusing: the new round is not an approved, sourced, canonical Replay round unused as a Daily');
    const res = await client.query(
      `UPDATE daily_challenges
       SET prior_round_id = round_id, round_id = $2, replaced_at = now(), replacement_reason = $3,
           assignment_source = 'admin_script'
       WHERE utc_date = $1::date AND round_id = $4`,
      [date, roundId, reason.trim(), oldRound],
    );
    if (res.rowCount !== 1) throw new Error(`Expected to update exactly 1 row, updated ${res.rowCount}`);
  });
  console.log(`[daily-reassignment] utc_date=${date} round_id=${roundId} prior=${current.round_id} replaced_at=${new Date().toISOString()}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
