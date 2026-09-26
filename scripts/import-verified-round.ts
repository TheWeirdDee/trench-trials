/**
 * Loads a verified round file — a round already generated from real, authenticated
 * Nansen responses (see DATA-CONTRACT.md §6) — into the database as a playable
 * round. This performs zero Nansen API calls; it only persists data that was already
 * fetched and validated during the data-validation gate.
 *
 * Without --confirm this is a dry run: it prints what would be imported and writes nothing.
 * A source round that is already in the database is refused, so it is never duplicated.
 *
 * Usage:
 *   npm run import:verified-round                                  # dry run, round-001.json
 *   npm run import:verified-round -- --confirm                     # import round-001.json as recorded (replay)
 *   npm run import:verified-round -- --file=data/verified-rounds/round-002.json --confirm
 *   npm run import:verified-round -- --mode=daily --repeat-of=<replay round uuid> --confirm
 *
 * --mode overrides the file's mode (replay | daily); --repeat-of links the new row to
 * an existing round with the same underlying data so the personal summary counts it
 * once (docs/DAILY-REAL-RUNBOOK.md). Market data is never overridden.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { insertVerifiedRound, type VerifiedRound } from '../src/lib/repo/verifiedRoundImport';

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const fileFlag = flag('file');
  const filePath = fileFlag
    ? resolve(fileFlag)
    : join(__dirname, '..', 'data', 'verified-rounds', 'round-001.json');
  const round: VerifiedRound = JSON.parse(readFileSync(filePath, 'utf8'));

  const mode = flag('mode');
  if (mode !== undefined) {
    if (mode !== 'replay' && mode !== 'daily') throw new Error(`--mode must be replay or daily (got "${mode}")`);
    round.mode = mode;
  }
  const repeatOf = flag('repeat-of');
  if (repeatOf !== undefined) {
    if (!/^[0-9a-f-]{36}$/i.test(repeatOf)) throw new Error(`--repeat-of must be a round uuid (got "${repeatOf}")`);
    round.repeat_of = repeatOf;
  }

  console.log(`Importing ${filePath} (source round ${round.round_id}) as mode=${round.mode} repeat_of=${round.repeat_of ?? 'none'}`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const existing = await pool.query(
    `SELECT id FROM rounds WHERE initial_manifest->>'round_id_source' = $1 AND repeat_of IS NOT DISTINCT FROM $2`,
    [round.round_id, round.repeat_of ?? null],
  );
  if (existing.rowCount) {
    console.error(`Refusing: source round ${round.round_id} is already imported as ${existing.rows[0].id}.`);
    process.exitCode = 1;
    await pool.end();
    return;
  }
  if (!process.argv.includes('--confirm')) {
    console.log('Dry run: nothing written. Re-run with --confirm to import.');
    await pool.end();
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (round.repeat_of) {
      const target = await client.query('SELECT 1 FROM rounds WHERE id = $1', [round.repeat_of]);
      if (target.rowCount === 0) throw new Error(`--repeat-of round ${round.repeat_of} does not exist`);
    }
    const { roundId, commitmentHash } = await insertVerifiedRound(client, round);
    await client.query('COMMIT');
    console.log('Imported verified round as rounds.id =', roundId);
    console.log('Commitment hash:', commitmentHash);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
