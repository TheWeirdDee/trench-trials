# Architecture

Trench Trials is one Next.js 15 application backed by PostgreSQL. The server holds every decision about what a player may see. The browser renders what it is given and keeps no game state of its own.

```
Browser ──► Next.js route handlers (src/app/api) ──► repositories (src/lib/repo) ──► PostgreSQL
                     │                                        ▲
                     └─► stage view (src/lib/api/roundView)    │
                                                              │
Scripts (scripts/) ──► services (src/lib/services) ──► Nansen client (src/lib/nansen) ──► Nansen API
```

## Directory map

| Path | Holds |
| --- | --- |
| `src/app/(site)` | Public pages: landing, `/docs`. Static where possible. |
| `src/app/(app)` | Game pages: `/play`, `/round/[id]`, `/history`, `/daily`, `/live`. The layout reads which optional modes exist, to build the navigation. |
| `src/app/api` | Route handlers. Public: rounds, next round, history, daily, live, health. `api/internal/*` requires `CRON_SECRET`. |
| `src/components` | UI: `site/` (landing), `app/` (navigation), `game/` (cards, timer, verdict, verification), `brand/`. |
| `src/lib/domain` | Pure logic with no I/O: clues, returns and ties, scoring, attempt state machine, Live schedule, commitments, History definitions, share text. |
| `src/lib/repo` | SQL: rounds, attempts, History, Live, catalog, API call log. |
| `src/lib/api` | Response types and the single stage-view builder. |
| `src/lib/nansen` | The only Nansen client, and the per-operation request budget. |
| `src/lib/services` | Multi-step operations that call Nansen: the Live snapshot, and Round Forge (Replay generation). |
| `migrations/` | Schema (node-pg-migrate). |
| `scripts/` | Operator commands: import, generate, Live create/resolve, verify, test-schema setup. |
| `tests/unit`, `tests/integration`, `tests/e2e` | Vitest (domain and routes against `tt_test`), and Playwright (the production build against `tt_test`). |

## Data model

- `rounds`: one per verified round. Holds `mode` (replay, daily or live), `status`, cutoff and resolution, and the committed manifest with its hash and secret nonce. Live rounds add their schedule, plus a resolution manifest and commitment.
- `round_assets`: three per round, one for each slot. Holds identity, clue values and buckets, boundary prices, and the return.
- `source_receipts`: one per Nansen response a round was built from. Holds the endpoint, request, SHA-256, request ID, credits and purpose.
- `players`: one per guest. `anon_id` is the opaque guest ID inside the signed cookie.
- `attempts`: at most one per player per round. Records the stage, blind and final slots, the action (stick, switch or timeout), the server-set decision deadline and recognition answers.
- `decision_events`: an append-only audit trail of `blind_lock`, `identity_disclosure` and `final_lock`.
- `daily_challenges`: `utc_date` (primary key) → canonical `round_id`, plus assignment audit fields. A round is a Daily at most once.
- `api_call_log`: one row per Nansen attempt (network or cache). Holds status, request ID, credits and purpose. It never holds keys, URLs or bodies.

## A round, end to end

1. **Blind stage.** `GET /api/rounds/:id` loads the round with its assets and receipts in one query. Immutable rounds are cached in-process for 5 minutes. The response is built by `buildRoundStageResponse`, which applies the allowlists in `src/lib/allowlist.ts`: slot letters and clue buckets only. No GET creates a player or an attempt.
2. **Blind lock.** `POST /api/rounds/:id/blind` is the first write. In one transaction it:
   - creates the guest player and the attempt if they are missing;
   - locks the attempt row;
   - reads the database clock;
   - applies the state machine;
   - writes `final_deadline_at = clock + decision window` and both audit events in one statement.

   The response carries `serverNow` and the deadline. The client counts down on the server clock offset, never on its own clock alone. On this first lock, the signed cookie is issued.
3. **Unmask.** The same stage view now includes token identities, but still no prices or returns. A read after the deadline shows a virtual timeout without writing anything. The next write persists it.
4. **Final lock.** `POST /api/rounds/:id/final` records stick or switch (or the timeout) and returns the verdict: returns, winners (ties within 0.01 pp share), points, switch impact and Ticker Tax contribution. It also returns provenance: receipts, plus the commitment manifest and nonce, so the browser can recompute the SHA-256.
5. **Live.** A Live round shows no verdict until it is resolved. Before then, the attempt is `pending` and returns no prices. An invalid round is shown as an audit record and never scored.

## Integrity

- **Commitment.** `SHA-256(canonical JSON {manifest, nonce})` is computed at creation. The manifest holds candidates, clues and policy. A historical round's outcome is already known when it is created, so its manifest also holds outcome prices, returns and receipts. A Live round seals its outcome in a second commitment when it resolves. The nonce stays secret until a verdict opens it. `npm run verify` recomputes every commitment, return and winner, and checks the receipts. The verdict page recomputes the commitment in the browser.
- **Leakage.** The allowlist is the only path from a database row to a response. Unit, integration and e2e tests assert that blind and Unmask payloads contain no names, addresses, prices, returns, exact cutoff or commitment contents.
- **Fail closed.**
  - A missing clue input rejects a candidate.
  - A missing boundary candle rejects a generated round. For a Live round, it invalidates the round after its retry window.
  - Nothing is interpolated or substituted.

## Sessions and History

- The cookie is `tt_anon_id = v1.<guestId>.<HMAC-SHA256>`: HttpOnly, SameSite=Lax, Secure in production, and valid for one year. A forged or unsigned value is ignored, never adopted. The client never sees a database player ID.
- History (`src/lib/domain/history.ts`) counts only **decided** attempts. An abandoned Blind Pick or an open Unmask window counts for nothing.
  - Metrics use first plays of each canonical round. Repeats are listed but not counted.
  - Live predictions are counted separately.
  - An attempt started on its round's Daily date is labelled Daily and feeds the Daily streak.

## Nansen access

- `src/lib/nansen/client.ts` is the only module that reads `NANSEN_API_KEY` or calls Nansen. Every request needs a `NansenCallBudget` (`budget.ts`), which:
  - reserves a slot before each HTTP attempt, retries included, so every operation has a hard cap;
  - records every attempt in `api_call_log`; an attempt that cannot be recorded halts the operation;
  - halts the operation on an insufficient-credits or authentication rejection;
  - serves a repeated identical request in the same operation from memory.
- Retries are bounded: three attempts, for network errors, 429 and 5xx only. A malformed 2xx body is never retried.
- **Comparable assets** (`src/lib/domain/assetPolicy.ts`), shared by Live and Round Forge. Never candidates:
  - stablecoins and stable-yield wrappers;
  - wrapped or bridged majors;
  - liquid-staking and LP tokens;
  - tokenized stocks and yield-bearing tokens (by Nansen sector).

  Two catalog rounds may never share two tokens.
- **Live snapshot** (`src/lib/services/liveSnapshot.ts`) uses Nansen's current token screener (`/api/v1/token-screener`, trailing 24h and 7d). It reads the scale of `price_change` from the data, and refuses to guess if the scale is ambiguous.
- **Round Forge v4** (`src/lib/services/replayForge.ts`, `npm run generate:replay`) builds each round in five requests:
  1. two screener windows as of the day **before** the cutoff (`to_date = cutoff − 1 day`). The screener reads `to_date = D` at about D 12:00 UTC (audit F1);
  2. candidate selection and slot assignment, fixed before any outcome is fetched;
  3. one OHLCV request per slot.

  Global request and credit caps apply on top of each round's budget. The dry run disables `fetch` entirely. Every request and response is checked against a runtime schema (`src/lib/nansen/contracts.ts`) before any credit is reserved or any caller sees the data.
- **Rebuild** (`scripts/rebuild-round.ts`) turns a stored round into a new, leak-free round from its preserved responses, with zero Nansen calls. It keeps the ancestor's clue snapshot (`to_date = D`), moves the cutoff to D+1 00:00 UTC and reads the outcome from the same preserved candles. The new round has its own manifest and commitment, and `rebuilt_from` points at the ancestor. `scripts/verify-rebuilt.ts` re-checks it without importing any production code.
- **Eligibility gate** (`src/lib/domain/eligibility.ts`). A round is player-facing only when `eligibility_status = 'approved'` under the current policy version. Replay selection, the Daily, Live navigation, new blind locks and History metrics all use the same predicate. Withdrawal is a logged, reversible status change (`round_eligibility_events`); nothing is deleted. An invalid round stays readable as a void record, but can never be played.

## Performance

- Each API route is wrapped in `withRequestTiming`. With `TT_TIMING=1`, it logs spans such as `db.acquire`, `db.round`, `db.attempt`, `db.blind.lock`, `db.final.lock`, `view.unmask` and `view.verdict`. Outside production, it also returns them as `Server-Timing`.
- A gameplay transition takes one or two database round trips: a single CTE per write, and a single `json_agg` read per round.
- There is one pool per process (`globalThis`), and its size is budgeted under the pooler's client cap.
- Navigation availability (Daily assigned? valid Live?) is cached for 30 s and fails closed to "hidden".

## Security

- Security headers (`next.config.mjs`): `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and COOP. No `X-Powered-By` header is sent.
- `/api/internal/*` compares `CRON_SECRET` in constant time and refuses every request while the secret is unset.
- `GET /api/health` reports only reachable or unreachable, never configuration or error text.
- Tests cannot reach Nansen: `tests/setup.ts` removes the key and blocks `*.nansen.ai`.
