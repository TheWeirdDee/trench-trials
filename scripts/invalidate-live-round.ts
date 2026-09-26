/**
 * Marks an unresolved Live round invalid WITHOUT resolving it: no Nansen call, no prices,
 * no verdict. Used when an eligibility review finds the round's candidates are not fair
 * comparisons (docs/NANSEN-CONTRACT-AUDIT.md, F3). Only `status` and `invalid_reason`
 * change; the manifest, commitment, assets and receipts are untouched. It also frees the
 * single Live slot for a later round.
 *
 * Usage:
 *   npm run invalidate:live -- --round <uuid> --reason quality_ineligible_assets            # dry run
 *   npm run invalidate:live -- --round <uuid> --reason quality_ineligible_assets --confirm
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { dbSchema, getPool, withTransaction } from '../src/lib/db';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const roundId = arg('round');
  const reason = arg('reason');
  if (!roundId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roundId)) throw new Error('--round <uuid> is required');
  if (!reason || !/^[a-z_]{3,64}$/.test(reason)) throw new Error('--reason <snake_case_reason> is required');

  const pool = getPool();
  const row = (
    await pool.query<{ mode: string; status: string; attempts: number }>(
      `SELECT r.mode, r.status, (SELECT count(*)::int FROM attempts a WHERE a.round_id = r.id) AS attempts FROM rounds r WHERE r.id = $1`,
      [roundId],
    )
  ).rows[0];
  if (!row) throw new Error(`Round ${roundId} not found in schema ${dbSchema() ?? 'public'}`);
  console.log(`Round ${roundId} (schema ${dbSchema() ?? 'public'}): mode ${row.mode}, status ${row.status}, attempts ${row.attempts}`);
  if (row.mode !== 'live') throw new Error('Refusing: not a Live round');
  if (!['open', 'measuring', 'resolving'].includes(row.status)) throw new Error(`Refusing: status is ${row.status}`);
  if (!confirm) {
    console.log(`\nDry run: nothing written. Re-run with --confirm to set status invalid (${reason}) without resolving.`);
    return;
  }
  await withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE rounds SET status = 'invalid', invalid_reason = $2
       WHERE id = $1 AND mode = 'live' AND status IN ('open', 'measuring', 'resolving')`,
      [roundId, reason],
    );
    if (res.rowCount !== 1) throw new Error(`Expected to update exactly 1 row, updated ${res.rowCount}`);
  });
  console.log(`\nRound ${roundId} is invalid (${reason}). Not resolved; no Nansen call.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
