/**
 * One command from a fresh clone to a playable local copy — no Nansen key needed.
 *
 *   npm run setup:demo              # dry run: target, pending migrations and the import plan
 *   npm run setup:demo -- --confirm # apply
 *
 * With --confirm it:
 *   1. validates the environment (DATABASE_URL is required; NANSEN_API_KEY is not);
 *   2. names the database target (schema and a host fingerprint, never credentials);
 *   3. applies pending migrations;
 *   4. imports every verified round bundle in data/verified-rounds/ (rebuild-*.json and
 *      forge-v4-*.json: the full approved catalog) — frozen, authenticated Nansen-derived
 *      rounds, not synthetic data;
 *   5. approves them under the current eligibility policy;
 *   6. assigns one as today's (UTC) Daily when no Daily exists;
 *   7. runs npm run verify;
 *   8. prints how to start the app.
 * Idempotent: a bundle already imported, an approved round or an existing Daily is left as
 * it is. Any failure stops the run with a non-zero exit code.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import runner from 'node-pg-migrate';
import { dbSchema, getPool, withTransaction } from '../src/lib/db';
import { ELIGIBILITY_POLICY_VERSION } from '../src/lib/domain/assetPolicy';
import { isPlayerFacing } from '../src/lib/domain/eligibility';
import { setRoundEligibility } from '../src/lib/repo/eligibility';
import { assignDailyRound } from '../src/lib/repo/rounds';
import { loadVerifiedBundles, type VerifiedBundle } from '../src/lib/repo/verifiedBundles';
import { insertVerifiedRound } from '../src/lib/repo/verifiedRoundImport';

function fail(message: string): never {
  throw new Error(`setup:demo stopped: ${message}`);
}

function loadBundles(): Array<{ file: string; bundle: VerifiedBundle }> {
  try {
    return loadVerifiedBundles();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set (copy .env.example to .env.local and fill it in)');
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    fail('DATABASE_URL is not a valid connection URL');
  }
  const schema = dbSchema() ?? 'public';
  const bundles = loadBundles();

  console.log(`Target: schema "${schema}", host fingerprint ${createHash('sha256').update(host).digest('hex').slice(0, 12)}`);
  console.log(`NANSEN_API_KEY: ${process.env.NANSEN_API_KEY ? 'set (not needed for this setup)' : 'not set (not needed for this setup)'}`);
  console.log(`SESSION_SECRET: ${process.env.SESSION_SECRET ? 'set' : 'not set: development uses a temporary key; production requires one'}`);
  // File names and receipt counts only: token names would spoil the rounds for whoever runs this.
  console.log(`Bundles: ${bundles.length} (${bundles.map((b) => `${b.file}, ${b.bundle.receipts.length} receipts`).join('; ')})`);

  if (!confirm) {
    console.log('\nDry run: nothing written. Re-run with --confirm to migrate, import, approve, assign the Daily and verify.');
    return;
  }

  // 3. Migrations
  await runner({
    databaseUrl: { connectionString: url, ssl: { rejectUnauthorized: false } },
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema,
    createSchema: schema !== 'public',
    migrationsSchema: schema,
    createMigrationsSchema: schema !== 'public',
    count: Infinity,
    log: (msg: string) => console.log(`[migrate:${schema}] ${msg}`),
  });

  // 4–5. Import and approve
  const pool = getPool();
  const imported: string[] = [];
  for (const { file, bundle } of bundles) {
    const existing = await pool.query<{ id: string; eligibility_status: string; eligibility_policy_version: number | null }>(
      `SELECT id, eligibility_status, eligibility_policy_version FROM rounds WHERE initial_manifest->>'round_id_source' = $1`,
      [bundle.round.round_id],
    );
    let roundId = existing.rows[0]?.id;
    if (!roundId) {
      roundId = await withTransaction(async (client) => {
        const { roundId: id } = await insertVerifiedRound(client, bundle.round, { receipts: bundle.receipts });
        return id;
      });
      console.log(`Imported ${file} as ${roundId}`);
    } else {
      console.log(`${file}: already imported as ${roundId}`);
    }
    const row = (await pool.query(`SELECT eligibility_status, eligibility_policy_version FROM rounds WHERE id = $1`, [roundId])).rows[0];
    if (!isPlayerFacing(row)) {
      await setRoundEligibility(pool, roundId, {
        status: 'approved',
        actor: 'setup_demo',
        note: `bundled verified round (${file}) approved under eligibility policy v${ELIGIBILITY_POLICY_VERSION}`,
      });
      console.log(`Approved ${roundId}`);
    }
    imported.push(roundId);
  }

  // 6. Today's Daily, only if none exists
  const today = (await pool.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS d`)).rows[0]!.d;
  const daily = await pool.query(`SELECT round_id FROM daily_challenges WHERE utc_date = $1::date`, [today]);
  if (daily.rowCount) {
    console.log(`Daily ${today}: already assigned`);
  } else {
    let assigned = false;
    for (const id of imported) {
      const result = await assignDailyRound(today, id, { source: 'setup_demo' });
      if (result.ok) {
        console.log(`Daily ${today}: ${id}`);
        assigned = true;
        break;
      }
      if (result.error !== 'round_already_daily') fail(`could not assign the Daily (${result.error})`);
    }
    if (!assigned) console.log(`Daily ${today}: every bundled round has already served as a Daily; none assigned`);
  }
  await pool.end();
  poolEnded = true;

  // 7. Verify
  const verify = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'verify.ts')], {
    stdio: 'inherit',
    env: process.env,
  });
  if (verify.status !== 0) fail('npm run verify reported failures');

  // 8. Next step
  console.log('\nReady. Start the app with:\n  npm run build && npm start\nthen open http://localhost:3000');
}

let poolEnded = false;

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!poolEnded) await getPool().end().catch(() => undefined);
  });
