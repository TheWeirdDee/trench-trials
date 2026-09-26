# Trench Trials

**A blind market game powered by Nansen.** Pick the token you think will perform best, see the names, decide again, and find out what recognising the ticker cost you.

> Status (2026-09-26): a contract-and-data audit ([docs/NANSEN-CONTRACT-AUDIT.md](docs/NANSEN-CONTRACT-AUDIT.md)) found that every stored Replay round leaked about 12 hours of its outcome into its clues. All 16 were **withdrawn**, not deleted: their evidence is preserved. Two were **rebuilt offline** as new, leak-free rounds from the preserved Nansen responses, with zero new API calls, and independently verified. Those two are the only playable rounds. Live was built and audited, but its only candidate round failed the eligibility policy, so it is **withheld**. See [Known limitations](#known-limitations).

## The problem

A familiar ticker can override a stronger signal. People anchor on names they know and avoid names they don't. They rarely find out what that costs them, because they never see the same decision made without the name.

## The product

Each round shows three real tokens, labelled A, B and C, with four signals each. The signals come from Nansen data at a historical cutoff. You choose twice on the same data:

1. **Blind Pick.** Names, addresses, dates and prices are hidden. You lock the candidate you think returned the most.
2. **Unmask.** The three token names appear and the outcome stays sealed. A short decision window runs on the server's clock. You keep your pick or switch.
3. **Verdict.** You see the real returns, the winner, your blind and final choices, and your switch impact. A verification panel lets you recompute the round's commitment in the browser.

**Ticker Tax** is what changing your mind after the reveal cost or earned you: blind return minus final return, in percentage points. Keeping your pick costs exactly zero. Your History reports "insufficient evidence" until you have made five explicit decisions.

There are three modes:
- **Replay:** past cutoffs whose outcome is already verified. You are never served the same round twice.
- **Daily:** one verified round per UTC date, the same for everyone. It appears in navigation only on days a round is assigned.
- **Live:** candidates are captured now and measured over the next 24 hours. It appears only while a valid Live round exists.

## Real Nansen dependency

Every round is built from the Nansen API, and there is no fallback data source:

- The **Historical Token Screener** (`/api/v1beta1/token-screener/historical`), read as of the day before the cutoff, decides which tokens qualify and supplies the four signals.
- **Historical Token OHLCV** (`/api/v1beta1/tgm/historical-token-ohlcv`) supplies the exact boundary candles that decide the outcome.
- Each round stores one source receipt per Nansen response, holding the request, response SHA-256, request ID and credits. Every attempted request is written to `api_call_log`.
- If the data a round needs cannot be retrieved and verified, the round is not created. A Live round whose closing candle is missing is marked invalid and never scored.

Details: [DATA-CONTRACT.md](DATA-CONTRACT.md) · [docs/API-USAGE-EVIDENCE.md](docs/API-USAGE-EVIDENCE.md)

## Architecture overview

- Next.js 15 (App Router) with server route handlers.
- PostgreSQL (Supabase) through `pg`, with migrations by `node-pg-migrate`.
- Tailwind for the UI.
- The server decides what each stage may contain. Blind responses carry slot letters and signal buckets only. Names arrive after the blind lock, and prices after the final lock.
- Guests are identified by an HMAC-signed, HttpOnly cookie that is issued on the first Blind Pick. No GET creates state.

Full description: [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup (about 10 minutes)

Requirements: Node 20+ and a PostgreSQL database (a Supabase project works). You need a Nansen API key only to generate new rounds or run Live.

```bash
npm install
cp .env.example .env.local         # then fill in the values below
npm run migrate:up -- --confirm    # creates the schema (without --confirm: prints the target and pending migrations)
npm run import:verified-round -- --confirm   # imports data/verified-rounds/round-001.json as pending review (zero Nansen calls)
npm run verify                     # recomputes every commitment and return
npm run build && npm start         # http://localhost:3000
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. For deployment, use Supabase's **transaction pooler** (port 6543). The session pooler (5432) admits only 15 clients in total. |
| `SESSION_SECRET` | yes in production | At least 32 random characters. Signs guest cookies. Development falls back to a per-process key. |
| `CRON_SECRET` | for internal routes | Shared secret for `/api/internal/*` (Daily assignment, Live create/resolve, usage). Without it those routes refuse every request. |
| `NANSEN_API_KEY` | for generation/Live | Server-only. Never sent to the browser or logged. |
| `DB_POOL_MAX` | no | Pool size per process (default 10). Budget it across processes. |
| `DATABASE_SSL` | no | `require` (default) or `disable`. |
| `DATABASE_SSL_CA_FILE` | no | CA bundle path; when set, the server certificate is verified. |
| `DB_SCHEMA` | tests only | Isolated schema (`tt_test`). Tests refuse to run without it. |
| `TT_TIMING` | no | `1` logs per-request DB timings. Outside production it also adds a `Server-Timing` header. |
| `MAX_NANSEN_CALLS_PER_LIVE_CREATE` / `_RESOLVE` | no | Per-operation request caps for Live (see the runbook). |

Step-by-step detail and troubleshooting: [SETUP.md](SETUP.md).

## Tests

```bash
npm run test:db:setup     # once: migrates the isolated tt_test schema and copies the canonical rounds into it
npm run typecheck
npm test                  # unit + integration (Vitest), always in tt_test
npm run build && npx playwright test   # end-to-end against the production build, in tt_test
```

The suites never touch production rows. `src/lib/db.ts` refuses to connect under Vitest without `DB_SCHEMA=tt_test`, and Playwright forces it. A regression test proves that a real Daily outside the test schema is never read, changed or deleted. Playwright fails on any unexpected browser console error, any server stderr output, or any leftover test row.

## Verified rounds

- **Import** a round file that was already built from real responses: `npm run import:verified-round -- --file=data/verified-rounds/<file>.json --confirm` (refuses a source round that is already imported).
- **Generate** new historical Replay rounds (Round Forge v4: the screener is read as of `cutoff − 1 day`):
  ```bash
  npm run generate:replay -- --count 15             # dry run: plan, caps, zero Nansen requests
  npm run generate:replay -- --count 15 --confirm   # spends credits within the printed caps
  ```
  Dates already attempted (even rejected ones) are skipped, so a resumed run never re-buys data.
  Every real run keeps the raw Nansen responses privately in `.nansen-raw/` (gitignored).

  A round costs 5 requests: two screener calls, then one OHLCV call per slot. Each round runs under its own budget of at most 7 requests, and the whole run is capped at 83 requests and 415 credits for 15 rounds by default. The run stops on any authentication, credit, rate-limit or audit-log failure.
- **Review** eligibility. A round is playable only when approved under the current policy. Withdrawal is a reversible status change, and every decision is logged:
  `npm run review:round -- --round <uuid> --status approved|withdrawn|investigate --note "…" --actor <name> --confirm`.
- **Rebuild** a stored round offline, leak-free, from its preserved responses, as a new round: `npm run rebuild:round -- --from <uuid> [--confirm]`. Check it independently with `npm run verify:rebuilt`.
- **Assign a Daily**: `npm run assign:daily -- --round <uuid> [--date YYYY-MM-DD] --confirm`. To replace an assigned date's round with an audit record: `npm run reassign:daily -- --date … --round … --reason "…" --confirm`.
- **Invalidate a Live round without resolving it**: `npm run invalidate:live -- --round <uuid> --reason <reason> --confirm`.
- **Verify** everything: `npm run verify`. It recomputes every commitment and return, and fails if any round forged before v4 is approved.

Every script that writes is a dry run unless given `--confirm`.
- Live: [docs/LIVE-REAL-RUNBOOK.md](docs/LIVE-REAL-RUNBOOK.md). Daily: [docs/DAILY-REAL-RUNBOOK.md](docs/DAILY-REAL-RUNBOOK.md).

## Screenshots

The Playwright suite captures screenshots of every stage from the production build into `artifacts/screenshots/<viewport>/` (1440×900, 1280×720, 1024×768, 390×844, 375×667). They are generated locally and not committed.

## Deployment

Deployed on Vercel from this repository's `main` branch, with production secrets held in Vercel's environment settings. No Nansen key is configured on the deployment, so it cannot spend credits. Steps: [SETUP.md](SETUP.md#deployment). Submission gate: [docs/SUBMISSION-CHECKLIST.md](docs/SUBMISSION-CHECKLIST.md).

## Known limitations

- **Two playable Replay rounds.** Both are leak-free offline rebuilds, verified independently: 0 failures across provenance, clues, eligibility, candles, returns and winners.
  - `c5e34c58…` (FARTCOIN / DBR / $WIF), cutoff 2026-08-15. It is the 2026-09-26 Daily, so Replay excludes it that day.
  - `d2ecc59b…` (PNUT / JELLYJELLY / MEW), cutoff 2026-08-25.

  A guest who has played both sees an honest "played every verified round" state. No filler round is ever served.
- **16 stored rounds withdrawn.** The historical screener reads `to_date = D` at about D 12:00 UTC, but the rounds entered at D 00:00, so their clues overlapped the outcome window (audit F1). Many also held tokenized stocks, yield/LP tokens, bridged majors, unclassifiable tokens or near-duplicate pairs. Withdrawal is a status change: rounds, receipts and commitments are preserved, and `npm run verify` still checks them.
- **How the rebuilds work.** Each keeps its ancestor's preserved clue snapshot (`to_date = D`) and moves the cutoff to D+1 00:00 UTC. The outcome is read from the same preserved hourly candles. A joint fit of each snapshot's prices to those candles places it before the new cutoff (the audit gives the margins). Token reuse was judged against the catalog that existed when the data was fetched, as the generator did.
- **Daily:** 2026-09-26 is `c5e34c58…`. It was reassigned from the withdrawn `c3a06918…`, before anyone played, with an audit record on the Daily row. Later dates are not assigned yet.
- **Live is withheld.** The pipeline was built and audited: capture, commitment, a 24-hour window and resolution from 5-minute candles. Its only candidate round, `5a76f497…` (PUMP / XXXX / TRX), failed the eligibility policy (TRX is a bridged major; XXXX traded about $1.3K in 24h). It was marked invalid (`quality_ineligible_assets`) and never resolved. The Live policy now requires Nansen's `Memecoins` sector filter, a $100K 24h-volume floor and no bridged majors. `/live` shows no playable round.
- **Nansen usage:** 85 real requests (417 credits) on 2026-09-26, all logged and reconciled, on top of the dashboard's earlier 21. The **expected** dashboard total is 106, pending dashboard confirmation. The rebuilds made zero calls.
- **History is per browser.** There are no accounts. Another browser or device, or clearing cookies, starts a new History.
- **Lighthouse (mobile preset) performance is about 70**, driven by JavaScript blocking time under 4× CPU throttling. Accessibility, best practices and SEO score 100.
- The historical screener is reconstructed at request time, and its `to_date` is not a midnight boundary (F1). Each round stores response hashes, so a later correction on Nansen's side is detectable, not silently trusted.

Not financial advice. Rounds use past and time-boxed market data to measure decisions.
