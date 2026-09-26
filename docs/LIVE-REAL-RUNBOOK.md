# Live — real-data runbook (exactly one round)

Prepared 2026-09-25, updated 2026-09-26.

> **Executed 2026-09-26.**
> - Attempt 1 (16:34 UTC) followed the original §1 design: the *historical* screener with `to_date` = today. It returned no usable rows, so 0 candidates were selected and no round was created (2 requests, 10 credits).
> - Creation was then moved to Nansen's **current** token screener (DATA-CONTRACT.md §1.3).
> - Attempt 2 (16:47 UTC, `MAX_NANSEN_CALLS_PER_LIVE_CREATE=2`) created round **`5a76f497-fac6-4517-9705-8b216e5a2cdb`**, with PUMP / XXXX / TRX (2 requests, 2 credits):
>   - entry closed 16:52:24;
>   - measurement 2026-09-26 16:55 → 2026-09-27 16:55 UTC;
>   - resolution allowed from 17:10 UTC on 2026-09-27.
> - **Superseded by the 2026-09-26 audit.** `5a76f497…` is QUALITY INVALID: TRX is a bridged major, and XXXX traded about $1.3K in 24h. It was marked `invalid` (`quality_ineligible_assets`) with `npm run invalidate:live` and withdrawn. It was **never resolved**, and the 3 reserved requests were not spent. Resolution now refuses any round that is not approved under the current eligibility policy. New Live rounds must pass the Memecoins sector filter and a $100K 24h-volume floor.
> - The request tables below describe the original design. Where they differ, the note above and DATA-CONTRACT §1.3 describe what the code does now.

One Live round = one create (now) + one resolve (≈24 h later). There is no fake fallback anywhere in this flow: if real data is missing, the round fails closed (error or INVALID), never substituted.

---

## 0. Cost at a glance

| Phase | Command | Nansen endpoint | Requests needed | Hard cap (default) | Credits expected / worst case |
| --- | --- | --- | --- | --- | --- |
| Create | `npm run create:live -- --confirm` | `POST /api/v1/token-screener` (current) | 2 (24h + 7d) | 3 — `MAX_NANSEN_CALLS_PER_LIVE_CREATE` | 2 / 3 (1 credit each) |
| Resolve | `npm run resolve:live -- <roundId> --confirm` | `POST /api/v1beta1/tgm/historical-token-ohlcv` | 3 (one per slot, 5m) | 4 — `MAX_NANSEN_CALLS_PER_LIVE_RESOLVE` | 15 / 20 per invocation |

- Happy path: **5 requests, ≈25 credits.** Cost per request is the 5 credits observed at the data gate (DATA-CONTRACT.md §1.1, §1.2).
- **Minimum balance before creating: 25. Recommended: ≥ 45**, which leaves room for one pending resolve retry. If the round is created and credits run out before it resolves, it ends INVALID.
- A cap counts every HTTP attempt, retries included. Allowed values are 1–10. A value below the requests needed (2 / 3) is refused before any request is sent. An invalid value (`abc`, `0`, `25`) is also refused rather than replaced by the default.

---

## 1. Audited creation path

### Entry points

| Entry | Where | Notes |
| --- | --- | --- |
| **Script (use this)** | `scripts/create-live-round.ts` → `npm run create:live` | Dry run by default: prints the exact request bodies, the cap and the active-round check, with **zero** Nansen requests. Spends credits only with `--confirm`. Refuses if a Live round is active. |
| Internal route | `POST /api/internal/live/create` (header `x-internal-secret: $CRON_SECRET`) | Same service and guards. Only one real creation can be in flight per server process; a second gets `409 live_create_in_progress`. `customAssets` is refused with `403 fixture_inputs_disabled` outside the test runner. |

Both entries call `createRealLiveSnapshot` in `src/lib/services/liveSnapshot.ts`.

### Step by step

1. **Budget built first:** `NansenCallBudget` (`src/lib/nansen/budget.ts`), operation `live_create`, cap from `MAX_NANSEN_CALLS_PER_LIVE_CREATE` (default 3), required 2. A misconfigured cap throws here, before anything else runs.
2. **Timing config validated** before any request. The route forwards `timingConfig` from the body, and a non-24-hour horizon is refused here with `invalid_timing_config`.
3. **Active-round pre-flight:** if any `mode='live'` round is not `resolved`/`invalid`, it stops with `active_live_round_exists`. **Zero requests.**
4. **Request 1:** current Token Screener, `timeframe: "24h"`.
5. **Request 2:** current Token Screener, `timeframe: "7d"`.
   - Both requests use `chains: ["solana"]`, `per_page: 100` and `order_by liquidity DESC`.
   - Their `filters`:
     - `liquidity.min: 100000` and `token_age_days.min: 30`;
     - `include_stablecoins: false` and `include_native_tokens: false`;
     - `exclude_sectors`: Stablecoin, Tokenized Stocks, Yield Bearing, Liquid Staking, RWAs.
   - Candidates must also pass the shared comparable-asset symbol list (`src/lib/domain/assetPolicy.ts`).
   - The scale of `price_change` is read from the 7-day rows. The creation stops (`ambiguous_price_change_scale`) rather than guess.
   - `npm run create:live` (the dry run) prints both bodies verbatim.
6. **Candidate selection** (no network):
   - Walk the 1-day rows in liquidity order.
   - Skip excluded symbols (USDT, USDC, DAI, WETH, WBTC, USDe, FDUSD, BUSD, TUSD, PYUSD, FRAX, LUSD, CRVUSD).
   - Skip tokens with no matching 7-day row.
   - Skip tokens with zero or missing `buy_volume`, `sell_volume`, `volume` or `liquidity` (1-day), or zero or missing 7-day `volume` or `price_change`.
   - Skip tokens whose four clues cannot be computed.
   - Take the **first 3** that pass. Fewer than 3 → `insufficient_candidates`, no round.
7. **Snapshot published** after both responses are in hand, so API latency never eats the entry window.
8. **One transaction** (`createLiveRound`, `src/lib/repo/live.ts`):
   - Takes the advisory lock `hashtext('trench_trials:live_create')` and re-checks for an active Live round. A concurrent creator loses here without inserting.
   - Inserts a `rounds` row: `mode='live'`, `status='open'`, `initial_manifest` (identities, clue inputs, clues, schedule, price policy), `initial_commitment_hash`, `initial_nonce`.
   - Inserts 3 `round_assets` rows (slots A/B/C).
   - Inserts **2 `source_receipts`** (`purpose='live_snapshot'`). Each carries the full request body, the SHA-256 of the exact response bytes, `retrieved_at`, the Nansen `request_id` and `credits_used`. Receipts come only from served responses; there is no other code path that writes them for a real round.

### Timestamps (all UTC)

| Field | Rule |
| --- | --- |
| `snapshot_published_at` | when both screener responses have arrived |
| `entry_close_at` | published + 5 min |
| `measurement_start_at` | ceil to 5-min boundary of (entry close + 60 s) |
| `measurement_end_at` | measurement start + exactly 24 h |
| real resolve allowed from | measurement end + 15 min (`LIVE_RESOLVE_MIN_DATA_DELAY_SECONDS`); earlier calls make zero requests |
| retry deadline | measurement end + 6 h. A resolve after this with data still missing marks the round INVALID. |

Example: created 10:00:30 → entry closes 10:05:30 → measurement 10:10 → next day 10:10 → resolve from 10:25 → INVALID after 16:10.

### api_call_log

- Every HTTP attempt writes exactly one row, retries and failures included. The write happens through a separate pool connection, so it survives a transaction rollback.
- Create rows have `purpose='live_create'`. Resolve rows have `purpose='live_resolve:<roundId>'`.
- Columns written: `http_status` (`0` = no response: network error or timeout), `is_success`, `nansen_request_id`, `quoted_credits`, `credits_used`, `credits_remaining`, `error_code` (`insufficient_credits` is normalised) and `is_cache_hit`.
- If a row cannot be written, the operation halts with `nansen_audit_log_failed` and sends no further request.

### Failure behaviour (create)

| Code (route status) | When | Requests spent | State left |
| --- | --- | --- | --- |
| `nansen_budget_invalid` / `nansen_budget_below_required` (422) | bad cap env | 0 | nothing |
| `invalid_timing_config` (422) | non-24 h horizon etc. | 0 | nothing |
| `active_live_round_exists` (409) | another Live round is open/resolving | 0 | nothing |
| `nansen_insufficient_credits` (502) | 402, or 403 naming credits | 1–2 | api_call_log rows only; operation halted; **no retry** |
| `nansen_auth_rejected` (502) | 401, or 403 not naming credits | 1–2 | api_call_log rows only; operation halted; no retry |
| `nansen_request_failed` (502) | other 4xx (e.g. 422, never retried), 429/5xx after bounded retries, network failure, malformed 2xx body | ≤ cap | api_call_log rows only |
| `nansen_budget_exhausted` (500) | retries hit the cap | = cap | api_call_log rows only |
| `nansen_audit_log_failed` (500) | api_call_log insert failed | as logged | operation halted |
| `insufficient_candidates` (422) | < 3 valid candidates | 2 | api_call_log rows only; **no round, no receipts** |
| `round_persist_failed` (500) | DB insert failed (whole transaction rolled back) | 2 | api_call_log rows only |

Every failure carries `nansen` (network calls, credits used, last remaining) so you know exactly what was spent.

### Why no loop can silently burn credits

- Create sends exactly two logical requests. Resolve sends one per slot (three). There is no pagination loop and no candidate-refetch loop.
- A retry happens only on 429/502/503/504 or a network error, at most 3 attempts per request. Backoff honours `Retry-After`, capped at 10 s.
- Every attempt reserves a slot in the operation's cap *before* `fetch`. Past the cap it throws without I/O.
- 401/402/403 are never retried. They halt the operation, so later requests in the same operation are refused without I/O.
- A malformed 2xx body is not retried: the call was already served and billed.
- An identical request repeated within one operation is served from memory as a cache hit (`is_cache_hit=true`) and does not use a network slot.
- A duplicate creation is refused before any request by the active-round check, and at insert time by the advisory lock.
- Resolve before measurement end + 15 min makes zero requests.
- The vitest setup deletes `NANSEN_API_KEY` and blocks any real `nansen.ai` fetch, so the test suite cannot spend credits.

Proven with mocks only in:

- `tests/unit/nansenBudget.test.ts`
- `tests/unit/liveCreateCreditGuard.test.ts`
- `tests/unit/liveResolveCreditGuard.test.ts`
- `tests/unit/liveRouteFixtureGate.test.ts`

**Residual risk.** Two operators running create from *different* processes at the same moment would both spend their requests. The loser is refused at insert, so only one round is created. Mitigation: one operator, one terminal.

---

## 2. PRE-FLIGHT

Save everything under `artifacts/live-real/` (untracked). In PowerShell, append `2>&1 | Tee-Object -FilePath artifacts/live-real/<file>.txt` to capture output.

1. **Credits confirmed restored** by the account owner. Record the **starting balance** from the Nansen dashboard (app.nansen.ai → API). Do **not** spend an API call to check it. After create, the exact post-request balance is in `api_call_log.credits_remaining`.
2. **Code is green** (this suite cannot reach Nansen):
   ```
   npm run typecheck
   npm test
   npm run verify
   ```
3. **Database is clean.** Run `npx tsx scripts/db-status.ts`. Expect only the canonical Replay round `be497aab-…` (ready) and the old Live round `df397565-…` (invalid). No `players`, `attempts`, `decision_events`, or test rounds. Note the `api_call_log` count as the baseline.
4. **No active Live round, and the plan looks right.** Run `npm run create:live` (dry run):
   - `active Live round: none`
   - `NANSEN_API_KEY set: yes`
   - `max network requests: 3`
   - the screener requests use the current Token Screener with `timeframe` `24h` and `7d`, `filters.sectors: ["Memecoins"]` and no dates. (The historical screener's `to_date = T` is *not* a T 00:00 UTC boundary: it reads at about T 12:00 UTC. See F1 in [NANSEN-CONTRACT-AUDIT.md](NANSEN-CONTRACT-AUDIT.md).)
5. **Set the caps explicitly** in `.env.local` so the plan output shows them:
   ```
   MAX_NANSEN_CALLS_PER_LIVE_CREATE=3
   MAX_NANSEN_CALLS_PER_LIVE_RESOLVE=4
   ```
   Re-run the dry run and confirm both values.
6. **Pick the creation time** so you are available between measurement end + 15 min and + 6 h the next day. Example: create ≈10:00 UTC → resolve ≈10:25–16:10 UTC the next day.
7. **Record T0**, the exact UTC time before creating:
   ```
   node -e "console.log(new Date().toISOString())"
   ```

## 3. CREATE

1. Run exactly once:
   ```
   npm run create:live -- --confirm
   ```
   Add `--to-date=YYYY-MM-DD` only if you decided on a date other than today UTC.
2. Expected output:
   - `✅ Live round created successfully!`, the round ID, commitment hash, 3 candidate symbols, and the schedule.
   - `Nansen: {"operation":"live_create","maxNetworkCalls":3,"networkCalls":2,…,"haltedReason":null,…}`.
   - Two `Call n:` lines, each with a request ID, `attempts=1`, `creditsUsed=5` and `creditsRemaining`.
3. **If it fails, do not re-run.** Read the code against §1 *Failure behaviour* and §7 *Abort conditions*.
4. Verify immediately:
   ```
   npx tsx scripts/live-evidence.ts <roundId> --since=<T0>
   npm run verify
   ```
   `live-evidence` must show:
   - status `open`
   - 3 assets
   - 2 `live_snapshot` receipts, each with a request ID
   - `live_create: network=2 succeeded=2 failed=0 cache_hits=0 credits_used=10`
   - `CHECKS: OK`

   `npm run verify` checks the commitment, the 24 h horizon, the 5-min boundaries and the receipts.
5. Open `/live` during the 5-minute entry window. Optionally play it for real (a genuine attempt) and take screenshots (§6).

## 4. WAIT

- Do **not** resolve early. Before measurement end the code refuses with `resolution_before_measurement_end`. Before measurement end + 15 min it refuses with `market_data_not_yet_expected`. Both make zero requests.
- `npm run resolve:live -- <roundId>` (no `--confirm`) is always safe. It prints the schedule, the exact OHLCV request bodies and whether real resolution is allowed yet.
- `npm test` and `npx playwright test` are safe while the round measures. Their synthetic `open` Live rounds exist only in the isolated `tt_test` schema, so they never become the production "current" round and cannot block a real create.
- Take screenshots of the real round from a normal browser session against the production build. Never create fixture rounds in the production database to stage a screen.
- Take MEASURING-phase screenshots (§6).

## 5. RESOLVE

1. After **real data not before** (measurement end + 15 min; +30 min recommended for the first attempt):
   ```
   npm run resolve:live -- <roundId>              # dry run: confirm the plan and the time
   npm run resolve:live -- <roundId> --confirm
   ```
   Each OHLCV request body is `{chain, token_address, date_from: <measurement start date>, as_of_date: <measurement end date>, timeframe: "5m"}`. The price used is the `open` of the candles whose `interval_start` equals measurement start and measurement end exactly.
2. Expected: `✅ Round resolved successfully!`, the manifest (entry/exit prices, returns, winning slots) and `Nansen: {…"networkCalls":3…}`.
3. If it did not resolve:

   | Result | Meaning | Action |
   | --- | --- | --- |
   | `market_data_not_yet_expected` / `resolution_before_measurement_end` | too early; 0 requests | wait |
   | `market_data_pending` | a boundary candle is not indexed yet; ≥ 1 request spent | wait ≥ 30 min, retry; each retry re-fetches every slot (≤ 4 requests) and re-adds receipts for slots it fetched. After the 6 h deadline the next resolve marks INVALID. |
   | `ohlcv_response_truncated` | Nansen truncated the window | **abort** (API mismatch, §7) |
   | `nansen_request_rejected` / `nansen_response_malformed` | 4xx validation error / unparseable body | **abort** (API mismatch, §7) |
   | `nansen_insufficient_credits` | out of credits | **abort**; top up; one retry before the deadline |
   | `nansen_auth_rejected` | 401/403 | **abort**; check the key |
   | `nansen_budget_exhausted` | 429/5xx storm reached the cap | **abort**; investigate; do not raise the cap blindly |
   | `round_invalidated` | terminal | record it honestly |

   In all of these the round stays `resolving` (not INVALID) until the 6 h deadline, so a fixed problem can still be resolved in time.

4. Verify the final state:
   ```
   npx tsx scripts/live-evidence.ts <roundId> --since=<T0>
   npm run verify
   ```
   Expect:
   - status `resolved`
   - resolution commitment present
   - winning slot(s)
   - entry/exit/return for all 3 slots
   - 3 `resolution` receipts with request IDs
   - `live_resolve:<id>: network=3 succeeded=3`
   - `CHECKS: OK`

   Then open `/live` and `/round/<roundId>`; both show the resolved verdict.

## 6. POST-FLIGHT — evidence to keep

| Evidence | Source |
| --- | --- |
| Exact credits consumed | `live-evidence` TOTALS (`credits_used` per purpose, summed from `x-nansen-credits-used`), cross-checked as starting balance − `last_remaining` |
| Exact api_call_log rows | `live-evidence` API CALL LOG section — expected 2 `live_create` + 3 `live_resolve:<id>` on the happy path |
| source_receipts | `live-evidence` SOURCE RECEIPTS — 2 `live_snapshot` + 3 `resolution`, each tied to a logged request ID |
| Round state | `live-evidence` ROUND and ASSETS; `npm run verify` output |
| DB counts | `npx tsx scripts/db-status.ts` |
| Screenshots (take manually in a normal browser; the screenshot scripts insert synthetic rounds) | `/live` ENTRY_OPEN · `/round/<id>` blind · unmasked · final-locked · MEASURING · RESOLVED verdict · one at phone width |

Store the evidence in `artifacts/live-real/`. Only hashes of provider responses are ever stored, never raw bodies.

## 7. ABORT CONDITIONS

Stop and **do not** retry, re-create or improvise when any of these occur. **No fake fallback.** Never:

- use `customAssets`, `customExitPrices` or a `now` override (the routes refuse them outside the test runner);
- type in prices;
- relax filters or change `to_date` just to find candidates without a recorded decision (each re-create costs ≈ 10 credits).

| Condition | How it shows up | What the code already did | What you do |
| --- | --- | --- | --- |
| Insufficient credits | `nansen_insufficient_credits`; api_call_log `error_code='insufficient_credits'` | stopped after that request, halted the operation, no retry, no round | stop; top up; restart from PRE-FLIGHT |
| No valid candidate set | `insufficient_candidates (found N, required 3)` | 2 requests spent, no round, no receipts | stop; decide explicitly on a different chain/date/filter before spending again |
| API mismatch | create: 422/400 `nansen_request_failed` or malformed body; resolve: `nansen_request_rejected`, `nansen_response_malformed`, `ohlcv_response_truncated`; unexpected fields | no retry | stop; update DATA-CONTRACT.md before any new attempt |
| Incomplete receipts | `live-evidence` shows ≠ 2 `live_snapshot` receipts, a receipt without `request_id`, or a receipt with no successful api_call_log row | — | stop; invalidate the round (below) |
| Unexpected repeated calls | api_call_log rows for the operation > requests needed, or `networkCalls` > 2 (create) / 3 (resolve) | capped at the configured budget | stop; investigate the failing attempts before any retry |
| Invalid future candle data | missing/zero/non-finite `open`, no exact `interval_start` match, truncated window | stays `resolving`; INVALID at the 6 h deadline | never enter prices manually; let it expire INVALID or invalidate it |

**Manual invalidation** (explicit decision only; frees the single Live slot; there is no API for it):

```sql
UPDATE rounds SET status = 'invalid', invalid_reason = '<reason>'
WHERE id = '<roundId>' AND mode = 'live' AND status IN ('open', 'resolving');
```

## 8. Not yet validated against the real API

State these honestly in any report on the run:

1. **5m OHLCV timeframe and the candle `open` field.** Only `1h` and `close` were exercised at the data gate (DATA-CONTRACT.md §1.2).
2. **`as_of_date` inclusivity for 5m.** It is inferred from the 1h observation (covers through the end of that UTC day). The resolve request now sends `as_of_date`, which the contract lists as required. Before this change it was omitted.
3. **Live freshness.** The PRD's source table ("Current Live snapshot — current screener/flow sources — validate coverage and snapshot freshness") is not yet validated. Live uses the *historical* screener with `to_date` = today. If Nansen rejects that date, the result is a 422: per DATA-CONTRACT it is not billed, and it produces `nansen_request_failed` with no round. Clues may be up to ≈ 24 h older than the publish time.
4. **5m candle indexing delay** is unknown. The 15-min guard is a conservative guess, and the first attempt is recommended at +30 min.
5. **Cost per request** is assumed to be the 5 credits observed at the gate. The first real response's `x-nansen-credits-used` confirms it.
6. **The daily free-credit reset at 00:00 UTC** has not been observed.
