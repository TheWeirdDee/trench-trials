import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Regression: a genuine Daily assignment outside the test schema is never read, changed
 * or deleted by the Daily test suite — and does not turn it red.
 *
 * A throwaway schema stands in for production: it holds a Daily assignment for today
 * (source 'admin_api'). The Daily suite then runs in a child process in the isolated
 * test schema. Afterwards the stand-in row must be identical and its table's scan and
 * tuple counters unchanged — nothing looked at it. Production itself is never touched.
 */

const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

maybeDescribe('A genuine Daily assignment outside the test schema survives the Daily test suite', () => {
  const standInSchema = `tt_test_prodsim_${randomBytes(4).toString('hex')}`;
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const readRow = async () =>
    (await client.query(`SELECT * FROM ${standInSchema}.daily_challenges ORDER BY utc_date`)).rows;
  const readCounters = async () => {
    await client.query('SELECT pg_stat_force_next_flush()');
    await new Promise((r) => setTimeout(r, 1500));
    return (
      await client.query(
        `SELECT seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del
         FROM pg_stat_user_tables WHERE schemaname = $1 AND relname = 'daily_challenges'`,
        [standInSchema],
      )
    ).rows[0];
  };

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${standInSchema}`);
    await client.query(
      `CREATE TABLE ${standInSchema}.daily_challenges (LIKE tt_test.daily_challenges INCLUDING DEFAULTS INCLUDING INDEXES)`,
    );
    await client.query(
      `INSERT INTO ${standInSchema}.daily_challenges (utc_date, round_id, assignment_source)
       VALUES ((now() AT TIME ZONE 'UTC')::date, $1, 'admin_api')`,
      [randomUUID()],
    );
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${standInSchema} CASCADE`);
    await client.end();
  });

  it('the Daily suite runs fully green and never reads, changes or deletes it', async () => {
    const rowBefore = await readRow();
    const countersBefore = await readCounters();

    const env: NodeJS.ProcessEnv = { ...process.env, DB_SCHEMA: 'tt_test', NO_COLOR: '1', FORCE_COLOR: '0' };
    for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key];
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/integration/dailyFlow.test.ts'],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 240_000 },
    );
    const output = stripAnsi(`${run.stdout}\n${run.stderr}`);

    expect(run.status, output).toBe(0);
    expect(output).toMatch(/Tests\s+11 passed \(11\)/);

    expect(await readCounters()).toEqual(countersBefore);
    expect(await readRow()).toEqual(rowBefore);
  }, 300_000);
});
