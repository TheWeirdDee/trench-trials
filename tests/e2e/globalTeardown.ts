import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { existsSync, readFileSync } from 'node:fs';
import { createPool } from '../../src/lib/db';

/**
 * Safety net after the whole run. Each test already removes exactly what it created
 * (tests/e2e/helpers.ts); anything this finds is a leak and fails the run. Scope is
 * this run's identities in the isolated test schema only — never other runs', never
 * non-test rows, never production.
 */
export default async function globalTeardown() {
  const problems: string[] = [];

  const runId = process.env.E2E_RUN_ID;
  if (process.env.DATABASE_URL && runId && /^tt_test[a-z0-9_]*$/.test(process.env.DB_SCHEMA ?? '')) {
    const pool = createPool();
    try {
      const leaked = await pool.query('DELETE FROM players WHERE anon_id LIKE $1 RETURNING anon_id', [
        `test-e2e-${runId}-%`,
      ]);
      if (leaked.rowCount) {
        problems.push(`${leaked.rowCount} test player row(s) outlived their test and were removed now`);
      }
    } finally {
      await pool.end();
    }
  }

  const logPath = process.env.E2E_SERVER_LOG;
  const serverErrors = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf8').trim() : '';
  if (serverErrors) problems.push(`Server wrote to stderr during the run:\n${serverErrors}`);

  if (problems.length > 0) throw new Error(problems.join('\n'));
}
