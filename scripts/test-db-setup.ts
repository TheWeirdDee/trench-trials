/**
 * Prepares the isolated test schema the automated suites run in (default `tt_test`):
 *   1. applies every migration into that schema (its own pgmigrations table);
 *   2. copies the two canonical rounds — the verified Replay round and the invalid Live
 *      audit round — from `public` with their assets and source receipts, byte-for-byte,
 *      so tests exercise real evidence without ever touching production rows;
 *   3. marks the Replay copy eligible *in the test schema only*, so the mechanics suites
 *      have a playable round (production eligibility is a separate, reviewed decision).
 *
 * Reads `public` only; never writes to it. Idempotent. Zero Nansen calls.
 *
 * Usage: npm run test:db:setup
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import runner from 'node-pg-migrate';
import { Client } from 'pg';
import { ELIGIBILITY_POLICY_VERSION } from '../src/lib/domain/assetPolicy';

const SCHEMA = process.env.TEST_DB_SCHEMA ?? 'tt_test';
const CANONICAL_ROUND_IDS = [
  'be497aab-d46e-4d40-a5fb-3fbf0f0d29ca', // verified Replay round
  'df397565-caab-4208-8737-9b1d208177d7', // invalid Live audit round
];
const COPIED_TABLES: Array<{ table: string; key: 'id' | 'round_id' }> = [
  { table: 'rounds', key: 'id' },
  { table: 'round_assets', key: 'round_id' },
  { table: 'source_receipts', key: 'round_id' },
];

async function main() {
  if (!/^tt_test[a-z0-9_]*$/.test(SCHEMA)) {
    throw new Error(`Refusing: test schema must start with tt_test (got "${SCHEMA}")`);
  }
  const connection = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };

  await runner({
    databaseUrl: connection,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: SCHEMA,
    createSchema: true,
    migrationsSchema: SCHEMA,
    createMigrationsSchema: true,
    count: Infinity,
    log: (msg: string) => console.log(`[migrate:${SCHEMA}] ${msg}`),
  });

  const client = new Client(connection);
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const { table, key } of COPIED_TABLES) {
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
         INTERSECT
         SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $2`,
        [SCHEMA, table],
      );
      const list = cols.rows.map((c) => `"${c.column_name}"`).join(', ');
      const copied = await client.query(
        `INSERT INTO ${SCHEMA}.${table} (${list})
         SELECT ${list} FROM public.${table} WHERE ${key} = ANY($1::uuid[])
         ON CONFLICT DO NOTHING`,
        [CANONICAL_ROUND_IDS],
      );
      console.log(`${table}: ${copied.rowCount} row(s) copied`);
    }
    await client.query('COMMIT');

    // The copies must be identical to the canonical evidence, column for column, over the
    // columns both schemas have (the test schema may be migrated ahead of production).
    for (const { table, key } of COPIED_TABLES) {
      const only = async (a: string, b: string) =>
        (
          await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $3
             EXCEPT
             SELECT column_name FROM information_schema.columns WHERE table_schema = $2 AND table_name = $3`,
            [a, b, table],
          )
        ).rows.map((r) => r.column_name);
      const testOnly = ['created_at', ...(await only(SCHEMA, 'public'))];
      const publicOnly = ['created_at', ...(await only('public', SCHEMA))];
      const diff = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           (SELECT to_jsonb(t) - $2::text[] AS r FROM public.${table} t WHERE ${key} = ANY($1::uuid[])
            EXCEPT SELECT to_jsonb(t) - $3::text[] FROM ${SCHEMA}.${table} t WHERE ${key} = ANY($1::uuid[]))
           UNION ALL
           (SELECT to_jsonb(t) - $3::text[] FROM ${SCHEMA}.${table} t WHERE ${key} = ANY($1::uuid[])
            EXCEPT SELECT to_jsonb(t) - $2::text[] FROM public.${table} t WHERE ${key} = ANY($1::uuid[]))
         ) d`,
        [CANONICAL_ROUND_IDS, publicOnly, testOnly],
      );
      if (diff.rows[0]!.n !== 0) throw new Error(`${SCHEMA}.${table} differs from public for the canonical rounds`);
    }

    // Test schema only: the Replay copy is playable for the mechanics suites.
    await client.query(
      `UPDATE ${SCHEMA}.rounds
       SET eligibility_status = 'approved', eligibility_policy_version = $2, eligibility_reviewed_at = now(),
           eligibility_note = 'test schema only: approved so mechanics suites have a playable round'
       WHERE id = $1 AND (eligibility_status <> 'approved' OR eligibility_policy_version IS DISTINCT FROM $2)`,
      [CANONICAL_ROUND_IDS[0], ELIGIBILITY_POLICY_VERSION],
    );
    console.log(`${SCHEMA} is migrated and holds exact copies of the canonical rounds.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
