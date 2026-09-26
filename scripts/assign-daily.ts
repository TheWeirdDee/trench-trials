/**
 * Assigns a verified canonical round as the Daily for a UTC date — the same
 * assignDailyRound path as POST /api/internal/daily/assign (see docs/DAILY-REAL-RUNBOOK.md),
 * for operators working from a shell. Makes zero Nansen calls.
 *
 * Usage:
 *   npm run assign:daily -- --round <uuid>                      # dry run: checks only, writes nothing
 *   npm run assign:daily -- --round <uuid> --confirm            # assigns for today (UTC, database clock)
 *   npm run assign:daily -- --round <uuid> --date YYYY-MM-DD --confirm
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { dbSchema, getPool } from '../src/lib/db';
import { assignDailyRound, getRoundById } from '../src/lib/repo/rounds';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const roundId = arg('round');
  if (!roundId || !/^[0-9a-f-]{36}$/i.test(roundId)) throw new Error('--round <uuid> is required');
  const pool = getPool();
  const today = (await pool.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS d`)).rows[0]!.d;
  const date = arg('date') ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD (got "${date}")`);
  if (date < today) throw new Error(`Refusing to backfill a past date (${date} < ${today}); see the runbook`);

  const round = await getRoundById(roundId);
  if (!round) throw new Error(`Round ${roundId} not found in schema ${dbSchema() ?? 'public'}`);
  const tokens = await pool.query<{ slot: string; token_symbol: string }>(
    'SELECT slot, token_symbol FROM round_assets WHERE round_id = $1 ORDER BY slot',
    [roundId],
  );
  const existingForDate = await pool.query('SELECT round_id FROM daily_challenges WHERE utc_date = $1::date', [date]);
  const usedBefore = await pool.query('SELECT utc_date::text FROM daily_challenges WHERE round_id = $1', [roundId]);

  console.log('Daily assignment plan');
  console.log(`  schema:            ${dbSchema() ?? 'public'}`);
  console.log(`  UTC date:          ${date}${date === today ? ' (today)' : ''}`);
  console.log(`  round:             ${roundId} (${round.mode}, ${round.status}, cutoff ${round.cutoff.toISOString().slice(0, 10)})`);
  console.log(`  tokens:            ${tokens.rows.map((t) => `${t.slot}:${t.token_symbol}`).join(' ')}`);
  console.log(`  date already has:  ${existingForDate.rows[0]?.round_id ?? 'nothing'}`);
  console.log(`  round used before: ${usedBefore.rows.map((r) => r.utc_date).join(', ') || 'never'}`);

  if (!confirm) {
    console.log('\nDry run: nothing written. Re-run with --confirm to assign.');
    return;
  }
  const result = await assignDailyRound(date, roundId, { source: 'admin_script' });
  if (!result.ok) {
    console.error(`\nNot assigned: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAssigned: ${result.utcDate} → ${result.roundId}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
