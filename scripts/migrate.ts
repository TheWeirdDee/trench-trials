/**
 * Applies pending migrations — only with `--confirm`. The dry run names the target
 * (schema and a fingerprint of the host, never the connection string) and every pending
 * migration, so production is never migrated by accident.
 *
 * Usage:
 *   npm run migrate:up              # dry run: target and pending migrations, writes nothing
 *   npm run migrate:up -- --confirm # apply them
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import runner from 'node-pg-migrate';
import { Client } from 'pg';

async function main() {
  const confirm = process.argv.includes('--confirm');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  const schema = process.env.DB_SCHEMA ?? 'public';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA must be a plain lowercase identifier');
  const connection = { connectionString: url, ssl: { rejectUnauthorized: false } };

  const client = new Client(connection);
  await client.connect();
  let applied: string[];
  try {
    applied = (await client.query<{ name: string }>(`SELECT name FROM ${schema}.pgmigrations ORDER BY run_on`)).rows.map((r) => r.name);
  } finally {
    await client.end();
  }
  const files = readdirSync('migrations').filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')).sort();
  const pending = files.filter((f) => !applied.includes(f));

  console.log(`Migration target: schema "${schema}"${schema === 'public' ? ' (PRODUCTION)' : ''}, host fingerprint ${createHash('sha256').update(host).digest('hex').slice(0, 12)}`);
  console.log(`Applied: ${applied.length}. Pending: ${pending.length ? pending.join(', ') : 'none'}`);
  if (pending.length === 0) return;
  if (!confirm) {
    console.log('\nDry run: nothing applied. Re-run with --confirm to apply the pending migrations.');
    return;
  }
  await runner({
    databaseUrl: connection,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema,
    migrationsSchema: schema,
    count: Infinity,
    log: (msg: string) => console.log(`[migrate:${schema}] ${msg}`),
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
