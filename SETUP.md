# Setup

This guide takes a fresh clone to a running production build and a green test suite, with no unexplained local state. Everything the app needs lives in `.env.local` and in the database.

## 1. Prerequisites

- Node.js 20 or newer, and npm.
- A PostgreSQL 15+ database. A Supabase project is what this repo is developed against.
- Optional: a Nansen API key. It is needed only to generate rounds (`generate:replay`) and for Live. Playing, testing and verifying need no key.

## 2. Install and configure

```bash
npm install
npx playwright install chromium     # only for the end-to-end suite
cp .env.example .env.local
```

Fill in `.env.local`:

```ini
DATABASE_URL=postgres://…            # see "Choosing the connection string" below
SESSION_SECRET=…                     # openssl rand -hex 32
CRON_SECRET=…                        # openssl rand -hex 32; guards /api/internal/*
NANSEN_API_KEY=…                     # optional; only for generation and Live
```

`.env.local` is gitignored. The scripts load it through `dotenv`, and so does Next.

### Choosing the connection string

Supabase offers two poolers:

| Pooler | Port | Use it for |
| --- | --- | --- |
| Session | 5432 | Local development, migrations and tests. It admits **15 client connections in total**, counted across every process. |
| Transaction | 6543 | Deployments, especially serverless ones where many instances connect. |

Every process holds its own pool (`DB_POOL_MAX`, default 10). With the session pooler, keep the sum below 15. The Playwright setup already does this: the server gets 8 and each test process 3. When a pool asks for more, connections time out ("Connection terminated due to connection timeout" or `EMAXCONNSESSION`).

TLS is on by default (`DATABASE_SSL=require`). To verify the server certificate, download Supabase's CA bundle and set `DATABASE_SSL_CA_FILE=/path/to/prod-ca.crt`.

## 3. Database

```bash
npm run migrate:up                  # applies migrations/ in order (node-pg-migrate)
npm run import:verified-round -- --confirm   # round-001: a real, verified historical round; zero Nansen calls
npm run verify                      # recomputes commitments, returns and winners; checks receipts
```

`npm run verify` should end with `0 failure(s)`.

## 4. Run

```bash
npm run build
npm start                           # http://localhost:3000
```

`npm run dev` works for development too. Capture evidence and screenshots only from `npm run build && npm start`, never from dev mode.

To see where request time goes, start with `TT_TIMING=1`. Each API request then logs `[timing] … db.acquire=…ms db.round=…ms … total=…ms`. Outside production it also returns a `Server-Timing` header; production responses never carry timings.

## 5. Tests

Tests run in an isolated schema, `tt_test`. They never read or write production rows.

```bash
npm run test:db:setup               # once, and after new migrations: migrates tt_test, copies the canonical rounds into it
npm run typecheck
npm test                            # Vitest: unit + integration
npm run build
npx playwright test                 # end-to-end against `next start`, one worker
```

- `src/lib/db.ts` refuses to connect under Vitest unless `DB_SCHEMA` is an isolated schema. `tests/setup.ts` sets `tt_test`.
- `playwright.config.ts` forces `DB_SCHEMA=tt_test`. Its web server wraps `next start` in a small proxy (`tests/e2e/webServer.mjs`) that counts in-flight requests, so test teardown deletes rows only after the server has finished with them.
- A Playwright run fails if any of these happens:
  - an unexpected browser console error;
  - any output on the server's stderr;
  - a test row left behind.

  Each test owns signed test identities (`test-e2e-<run>-<uuid>`) and removes exactly those.
- Screenshots of the real canonical round are written to `artifacts/screenshots/<viewport>/`. Screens that use test-fixture Live rounds go to `test-results/`, so they cannot be mistaken for product evidence.

## 6. Generating rounds (spends Nansen credits)

```bash
npm run generate:replay -- --count 15                     # dry run: dates, caps, expected output; fetch is disabled
npm run generate:replay -- --count 15 --confirm           # real requests, within the printed caps
npm run generate:replay -- --count 5 --confirm --max-calls 30 --max-credits 150
npm run verify
```

Dates already attempted are skipped (`--retry-attempted` includes them). Raw Nansen responses from real runs are kept in `.nansen-raw/`. That folder is gitignored, and its contents are never served or committed, per Nansen's redistribution terms.

To assign a Daily, run `npm run assign:daily -- --round <uuid>` (dry run), then add `--confirm`. It uses the same checks as the internal API.

A per-run report is written to `artifacts/replay-generation/<timestamp>.json`. It records every round, rejection, request ID, response hash and credit count.

Live rounds have their own runbook: [docs/LIVE-REAL-RUNBOOK.md](docs/LIVE-REAL-RUNBOOK.md). So does assigning a Daily: [docs/DAILY-REAL-RUNBOOK.md](docs/DAILY-REAL-RUNBOOK.md).

## Deployment

Deploy only with explicit authorization, after the local suite is green on the final tree.

1. Host: any Node host that runs `npm run build && npm start`, or Vercel.
2. Set these environment variables on the host:
   - `DATABASE_URL`, pointing at the **transaction pooler**, with `DB_POOL_MAX=1`–`3` per instance;
   - `SESSION_SECRET` (required: production has no fallback key);
   - `CRON_SECRET`;
   - `NANSEN_API_KEY`, only if Live runs from the deployment.
3. Run `npm run migrate:up` against the production database. It is a dry run that names the target schema and pending migrations; add `-- --confirm` to apply them. Migration `1790265000000_api_call_log_legacy_nullable` only records a change production already has.
4. Check after the deploy:
   - `GET /api/health` returns `{"ok":true,"database":"reachable"}`.
   - `GET /api/internal/usage` without the secret returns 401.
   - Responses carry the security headers from `next.config.mjs`: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and `COOP`.
   - No response carries `Server-Timing`.
   - Pages show no development overlay.
5. Production builds ship no browser source maps (Next's default). The Nansen key is read only in server code (`src/lib/nansen/client.ts`).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Connection terminated due to connection timeout`, `EMAXCONNSESSION` | Session-pooler client cap (15) exceeded | Lower `DB_POOL_MAX`, stop stray servers, or use the transaction pooler |
| `self-signed certificate in certificate chain` | `DATABASE_SSL_CA_FILE` points at the wrong bundle | Use Supabase's CA bundle, or unset it to encrypt without verification |
| Tests refuse to start: "isolated test schema" | `DB_SCHEMA` missing or `public` | Run through `npm test` / `npx playwright test`, after `npm run test:db:setup` |
| Integration tests fail on missing canonical rounds | `tt_test` not prepared | `npm run test:db:setup` |
| Guest cookie rejected in production | `SESSION_SECRET` unset or changed | Set a stable secret of at least 32 characters. Changing it starts every guest over. |
