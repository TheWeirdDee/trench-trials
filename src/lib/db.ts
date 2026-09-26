import { readFileSync } from 'node:fs';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { timed } from './timing';

/**
 * Server-only Postgres access. Never import this from a client component.
 *
 * One pool per process, kept on globalThis so every route bundle shares it. Connections
 * are expensive here (a remote Supabase session pooler: ~0.8s to connect, ~1.6s with TLS,
 * ~170ms per round trip), so idle connections are kept warm and a checkout that cannot
 * get a connection fails after 10s instead of hanging a request indefinitely.
 *
 * DB_SCHEMA selects an isolated schema through search_path on every new connection.
 * The test suites and the e2e server run in `tt_test`; production leaves it unset.
 */

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function dbSchema(): string | null {
  const schema = process.env.DB_SCHEMA;
  if (!schema) return null;
  if (!SCHEMA_PATTERN.test(schema)) throw new Error('DB_SCHEMA must be a plain lowercase identifier');
  return schema;
}

function sslConfig(): PoolConfig['ssl'] {
  const mode = process.env.DATABASE_SSL ?? 'require';
  if (mode === 'disable') return undefined;
  const caFile = process.env.DATABASE_SSL_CA_FILE;
  // With the provider's CA the server certificate is verified; without it the link is
  // still encrypted, but the certificate is not verified (see SETUP.md).
  return caFile ? { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false };
}

/** Builds a pool with the project's connection policy. Prefer getPool(); scripts may own one. */
export function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const schema = dbSchema();
  if (process.env.VITEST && (!schema || schema === 'public')) {
    // Fail before any connection: tests must never touch the production schema.
    throw new Error('Tests must run against the isolated test schema (DB_SCHEMA=tt_test); refusing to connect.');
  }

  const pool = new Pool({
    connectionString,
    ssl: sslConfig(),
    // Every process's pool counts against the pooler's client cap (15 in Supabase
    // session mode), so DB_POOL_MAX must be budgeted across all running processes.
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: 'trench-trials',
    // Applied by the server at connection start, before any query can run.
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  // node-postgres emits 'error' on the pool when an *idle* client hits a network
  // problem (e.g. a pooler-side connection drop). Pool is an EventEmitter, so an
  // unhandled 'error' event is a Node uncaughtException that can take the whole
  // server process down. This listener just lets the pool evict and replace the
  // dead client on the next query, which is its normal, safe recovery behavior.
  pool.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client', err);
  });
  return pool;
}

const globalForPool = globalThis as unknown as { __trenchTrialsPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__trenchTrialsPool) globalForPool.__trenchTrialsPool = createPool();
  return globalForPool.__trenchTrialsPool;
}

/** Runs `fn` inside a transaction, committing on success and rolling back on throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await timed('db.acquire', () => getPool().connect());
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
