import {
  test as baseTest,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from '@playwright/test';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { getPool } from '../../src/lib/db';
import { encodeSessionCookie, SESSION_COOKIE } from '../../src/lib/session';

/**
 * The fixtures' connection — schema-guarded exactly like the e2e server's. It is the
 * process-wide pool that repo helpers (createLiveRound, test fixtures) also use, so a
 * worker holds one small pool: the database's session pooler caps concurrent clients.
 */
export function getE2ePool(): Pool {
  if (!/^tt_test[a-z0-9_]*$/.test(process.env.DB_SCHEMA ?? '')) {
    throw new Error('e2e fixtures must run in the isolated test schema (DB_SCHEMA=tt_test)');
  }
  return getPool();
}

export const CANONICAL_ROUNDS = [
  'be497aab-d46e-4d40-a5fb-3fbf0f0d29ca', // Verified Replay round
  'df397565-caab-4208-8737-9b1d208177d7', // Preserved invalid Live round
];

/** Set once per `playwright test` run in playwright.config.ts and inherited by every worker. */
export const E2E_RUN_ID = process.env.E2E_RUN_ID ?? 'adhoc';

/** Prefix shared by every browser identity of this run — globalTeardown's safety net is scoped to it. */
export const E2E_ANON_PREFIX = `test-e2e-${E2E_RUN_ID}-`;

export function newTestAnonId(): string {
  return `${E2E_ANON_PREFIX}${randomUUID()}`;
}

/** What a test owns. Everything registered here is removed after the test, and only that. */
export interface TestOwnership {
  /** A new browser context carrying its own test-owned identity; closed and its player deleted after the test. */
  newContext(options?: BrowserContextOptions): Promise<BrowserContext>;
  /** Registers a round this test created. It is deleted only after every browser request of the test has ended. */
  ownRound(roundId: string): string;
  /** Declares a browser console error this test provokes on purpose (e.g. a deliberately rejected request). */
  allowConsoleError(pattern: RegExp): void;
}

interface AdoptedContext {
  context: BrowserContext;
  anonId: string;
  closed: boolean;
  quiesced: boolean;
}

interface OwnershipInternals extends TestOwnership {
  adopt(context: BrowserContext): Promise<void>;
  quiesceAll(): Promise<void>;
}

/**
 * Waits until the web server has finished every request it received — counted by the
 * proxy in tests/e2e/webServer.mjs until Next has answered, including requests the
 * browser cancelled on reload/navigation (which the browser never reports as finished).
 */
async function waitForServerIdle(origin: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let quietPolls = 0;
  for (;;) {
    const res = await fetch(`${origin}/__e2e/inflight`, { cache: 'no-store' });
    const { inFlight } = (await res.json()) as { inFlight: number };
    quietPolls = inFlight === 0 ? quietPolls + 1 : 0;
    if (quietPolls >= 2) return;
    if (Date.now() > deadline) {
      throw new Error(`Server still processing ${inFlight} request(s) 30s after this test stopped its browsers`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function serverLogSize(): number {
  const path = process.env.E2E_SERVER_LOG;
  return path && existsSync(path) ? statSync(path).size : 0;
}

function serverLogSince(offset: number): string {
  const path = process.env.E2E_SERVER_LOG;
  if (!path || !existsSync(path)) return '';
  return readFileSync(path).subarray(offset).toString('utf8').trim();
}

export const test = baseTest.extend<{ owned: TestOwnership }>({
  owned: [
    async ({ baseURL, browser }, use) => {
      const origin = baseURL || 'http://localhost:3005';
      const adopted: AdoptedContext[] = [];
      const roundIds: string[] = [];
      const allowedConsoleErrors: RegExp[] = [];
      const consoleErrors: string[] = [];
      const serverLogOffset = serverLogSize();

      const adopt = async (context: BrowserContext) => {
        const entry: AdoptedContext = {
          context,
          anonId: newTestAnonId(),
          closed: false,
          quiesced: false,
        };
        await context.addCookies([
          { name: SESSION_COOKIE, value: encodeSessionCookie(entry.anonId), url: origin, httpOnly: true, sameSite: 'Lax' },
        ]);
        context.on('close', () => {
          entry.closed = true;
        });
        // Only what happens while the test runs counts; teardown aborts requests on purpose.
        context.on('console', (msg) => {
          if (!entry.quiesced && msg.type() === 'error') {
            consoleErrors.push(`console.error: ${msg.text()} (${msg.location().url})`);
          }
        });
        context.on('weberror', (err) => {
          if (!entry.quiesced) consoleErrors.push(`uncaught page error: ${err.error().message}`);
        });
        adopted.push(entry);
      };

      // Stops a context from reaching the server: new requests are aborted in the browser,
      // so a polling page cannot fire again.
      const quiesce = async (entry: AdoptedContext) => {
        if (entry.quiesced) return;
        entry.quiesced = true;
        if (entry.closed) return;
        await entry.context.route('**/*', (route) => route.abort());
      };

      const ownership: OwnershipInternals = {
        adopt,
        async newContext(options) {
          const context = await browser.newContext(options);
          await adopt(context);
          return context;
        },
        ownRound(roundId) {
          if (CANONICAL_ROUNDS.includes(roundId)) throw new Error(`Refusing to own canonical round ${roundId}`);
          roundIds.push(roundId);
          return roundId;
        },
        allowConsoleError(pattern) {
          allowedConsoleErrors.push(pattern);
        },
        async quiesceAll() {
          for (const entry of adopted) await quiesce(entry);
          // Then every request that did reach the server must have finished there, so no
          // route handler is still reading a row when this test deletes it.
          await waitForServerIdle(origin);
        },
      };

      await use(ownership);

      // Teardown order is the fix for the "Round not found" / attempts_player_id_fkey races:
      // 1. no request can still be running, 2. contexts closed, 3. only then delete.
      // Cleanup runs even if step 1 fails, so a failing test never leaves rows behind;
      // the failure is reported after cleanup.
      let quiesceError: unknown = null;
      try {
        await ownership.quiesceAll();
      } catch (err) {
        quiesceError = err;
      }
      for (const entry of adopted) {
        if (!entry.closed) await entry.context.close();
      }

      const pool = getE2ePool();
      if (roundIds.length > 0) {
        const deleted = await pool.query('DELETE FROM rounds WHERE id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))', [
          roundIds,
          CANONICAL_ROUNDS,
        ]);
        if (deleted.rowCount !== roundIds.length) {
          throw new Error(`Expected to delete ${roundIds.length} owned round(s), deleted ${deleted.rowCount}`);
        }
      }
      const anonIds = adopted.map((e) => e.anonId);
      if (anonIds.length > 0) {
        await pool.query('DELETE FROM players WHERE anon_id = ANY($1::text[])', [anonIds]);
        const left = await pool.query('SELECT count(*)::int AS n FROM players WHERE anon_id = ANY($1::text[])', [anonIds]);
        if (left.rows[0].n !== 0) throw new Error(`${left.rows[0].n} test player row(s) reappeared after cleanup`);
      }

      const unexpected = consoleErrors.filter((e) => !allowedConsoleErrors.some((p) => p.test(e)));
      const serverErrors = serverLogSince(serverLogOffset);
      const problems = [
        ...(quiesceError ? [String(quiesceError instanceof Error ? quiesceError.message : quiesceError)] : []),
        ...(unexpected.length > 0 ? [`Unexpected browser console errors:\n  ${unexpected.join('\n  ')}`] : []),
        ...(serverErrors ? [`Server errors during this test:\n${serverErrors}`] : []),
      ];
      if (problems.length > 0) throw new Error(problems.join('\n'));
    },
    { auto: true },
  ],
  context: async ({ context, owned }, use) => {
    await (owned as OwnershipInternals).adopt(context);
    await use(context);
  },
  page: async ({ page, owned }, use) => {
    await use(page);
    // Before the page closes: an open page may be polling (the countdown refetches every 2s
    // once its deadline passes), so quiesce while it is still attached. A failure here is
    // re-detected and reported by the `owned` teardown, after it has cleaned up.
    await (owned as OwnershipInternals).quiesceAll().catch(() => {});
  },
});

export { expect };

/**
 * Selects a slot by clicking the card's own padding. The centre of a card can be one of
 * its embedded "Definition of …" buttons, which by design open the definition instead of
 * selecting — a default centre click would test that button, not the card.
 */
export async function selectSlot(page: Page, slot: 'A' | 'B' | 'C', how: 'click' | 'tap' = 'click'): Promise<Locator> {
  const card = page.getByTestId(`slot-card-${slot}`);
  if (how === 'tap') await card.tap({ position: { x: 12, y: 12 } });
  else await card.click({ position: { x: 12, y: 12 } });
  return card;
}

/** The Unmask stage is on screen. (The stage stepper shows the word "Unmask" on every stage.) */
export async function expectUnmaskStage(page: Page): Promise<void> {
  await expect(page.getByText('Now you know the names.')).toBeVisible();
}

/** Discovers a fresh round via the real API (same flow the landing page uses). */
export async function getFreshRoundId(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/rounds/next');
  const body = await res.json();
  if (!body.available) {
    throw new Error(`No round available for this test session: ${body.message}`);
  }
  return body.roundId as string;
}

export const FORBIDDEN_BEFORE_UNMASK = ['POPCAT', 'YZY', 'BOME', '7GCihgDB', 'DrZ26cKJ', 'ukHH6c7m'];
export const FORBIDDEN_BEFORE_VERDICT = [
  'entryPrice',
  'exitPrice',
  'returnRatio',
  'returnPct',
  'entryCandleStart',
  'exitCandleStart',
];

export async function assertNoneInContent(page: Page, forbidden: string[]) {
  const html = await page.content();
  for (const term of forbidden) {
    if (html.includes(term)) {
      throw new Error(`Forbidden term "${term}" found in rendered page content`);
    }
  }
}
