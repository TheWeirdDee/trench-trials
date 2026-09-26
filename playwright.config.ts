import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3005;

// The e2e server and every fixture run in the isolated test schema — never production rows.
if (process.env.DB_SCHEMA && !/^tt_test[a-z0-9_]*$/.test(process.env.DB_SCHEMA)) {
  throw new Error(`Refusing to run e2e tests against schema "${process.env.DB_SCHEMA}"`);
}
process.env.DB_SCHEMA ??= 'tt_test';
// Guest cookies are signed; the e2e server and the fixtures share a per-run key.
process.env.SESSION_SECRET ??= randomBytes(32).toString('hex');
// One id per `playwright test` run, inherited by workers and the web server. Every
// browser identity is test-e2e-<run>-<uuid>, so cleanup can only ever reach this run's rows.
process.env.E2E_RUN_ID ??= randomUUID().slice(0, 8);
process.env.MODE_AVAILABILITY_TTL_MS = '0';
// No e2e server, worker or fixture can spend Nansen credits. The key is set to the empty
// string rather than deleted: `next start` fills only *undefined* variables from
// .env.local, so a deleted key would come back in the server. The client refuses to send
// a request without a key.
process.env.NANSEN_API_KEY = '';
// Connection budget: the Supabase session pooler admits 15 concurrent clients in total.
// The server gets 8; each test process (worker, globalTeardown) gets 3 — at most 11.
process.env.DB_POOL_MAX = '3';
const SERVER_DB_POOL_MAX = '8';
// Server stderr for this run; tests and globalTeardown fail if anything lands in it.
process.env.E2E_SERVER_LOG ??= join(tmpdir(), `trench-trials-e2e-server-${process.env.E2E_RUN_ID}.log`);

export default defineConfig({
  testDir: './tests/e2e',
  globalTeardown: './tests/e2e/globalTeardown.ts',
  webServer: {
    command: `node tests/e2e/webServer.mjs ${PORT}`,
    env: {
      ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
      DB_POOL_MAX: SERVER_DB_POOL_MAX,
    },
    port: PORT,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  expect: { timeout: 20_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
});
