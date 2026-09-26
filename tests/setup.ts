import { config } from 'dotenv';

config({ path: '.env.local' });

// Tests run only in the isolated test schema (see scripts/test-db-setup.ts). src/lib/db.ts
// refuses to connect under Vitest without it, and every test connection's search_path
// holds this schema alone, so no unqualified table name can reach production rows.
if (process.env.DB_SCHEMA && !/^tt_test[a-z0-9_]*$/.test(process.env.DB_SCHEMA)) {
  throw new Error(`Refusing to run tests against schema "${process.env.DB_SCHEMA}"`);
}
process.env.DB_SCHEMA ??= 'tt_test';

// The Supabase session pooler admits 15 concurrent clients in total; the Daily survival
// test runs a second Vitest process, so each process keeps a small pool.
process.env.DB_POOL_MAX ??= '5';

// Guest sessions are HMAC-signed; tests sign and verify with their own key.
process.env.SESSION_SECRET = 'test-only-session-secret-0123456789abcdef';

// No test may reach the real Nansen API. .env.local carries a live key, so drop it:
// tests that exercise the client set a fake key and mock global.fetch themselves.
// Anything that still reaches api.nansen.ai through the real fetch fails loudly.
delete process.env.NANSEN_API_KEY;

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/([^/]*\.)?nansen\.ai(\/|:|$)/i.test(url)) {
    return Promise.reject(new Error(`Blocked real Nansen request from a test: ${url}`));
  }
  return realFetch(input, init);
}) as typeof fetch;
