# Nansen contract and data audit

Audit date: 2026-09-26, 18:00–19:00 UTC.

**Method.** The authority for every contract statement is the current official Nansen documentation, read on 2026-09-26. The project's own assumptions (DATA-CONTRACT.md, code comments) are compared against it, not trusted.

Data evidence comes from three sources:
- the production database, read-only;
- the 83 raw responses in `.nansen-raw/`;
- `api_call_log` and `source_receipts`.

No Nansen request and no production write was made for this audit. The one-off analysis scripts were kept locally and are not part of the repository; the reusable checks are `scripts/verify.ts` and `scripts/verify-rebuilt.ts`.

Official pages used:

| Ref | Page |
| --- | --- |
| [HS] | Historical Token Screener: https://docs.nansen.ai/api/backtesting-data/historical-token-screener |
| [CS] | Token Screener (current): https://docs.nansen.ai/api/token-god-mode/token-screener |
| [HO] | Historical Token OHLCV: https://docs.nansen.ai/api/backtesting-data/historical-token-ohlcv |
| [PO] | Token OHLCV (current), not used by this project: https://docs.nansen.ai/api/token-god-mode/price-ohlcv |
| [CR] | Credits: https://docs.nansen.ai/getting-started/credits |
| [RL] | Rate limits: https://docs.nansen.ai/getting-started/rate-limits |
| [RG] | Redistribution guide: https://docs.nansen.ai/guides/redistribution-guide |

---

## Findings at a glance

| # | Finding | Severity |
| --- | --- | --- |
| F1 | **Historical-screener anchoring:** `to_date = D` reflects the market around D ≈ 12:00 UTC, not D 00:00. Every Replay round takes its entry price at D 00:00, so its clues overlap about the first 12 hours of the outcome window: partial future leakage. Under a leak-free window, 3 winners change, including today's Daily. | **Submission blocker / correctness** |
| F2 | The previously reported "`date_from` must be a full datetime" defect **does not exist**. [HO] accepts a date or a datetime. The earlier change to the datetime form was cosmetic, and no stored value is affected. | Documentation (an earlier report's error) |
| F3 | The Live round `5a76f497…` contains XXXX (24h volume about $1.3K) and TRX (a bridged Tron asset). The current screener returns no sectors, so the snapshot could not classify anything. | Data quality: **QUALITY INVALID** |
| F4 | 13 of 16 Replay rounds fail asset or coverage rules. They contain tokenized stocks, RWAs, yield/LP tokens, bridged majors, unclassified tokens, a 47% single-hour discontinuity (FO), 36 missing candles (YZY), and volume below $100K. | Data quality |
| F5 | Today's Daily (`c3a06918…`) contains FO: no sector tag, and a −47% one-hour crash that dominates its outcome. | Data quality (player-facing now) |
| F6 | Four near-duplicate pairs share 2 of 3 tokens. | Data quality |
| F7 | No request or response schema validation existed. An invalid payload would reserve budget and hit the network. An HTTP 200 with a wrong shape is only caught by downstream code. | Correctness |
| F8 | [HS] `market_cap_usd` "falls back to FDV if zero". The project's policy text claimed "no FDV fallback", which it cannot guarantee from this field. | Documentation / data quality |
| F9 | Pagination: only page 1 is requested, and `is_last_page` is never read. A token present in the 1d page but beyond the 7d page is silently dropped. That is fail-closed, but undocumented. | Correctness (minor) |
| F10 | Live-create and Live-resolve had call caps but no explicit credit caps. Credit safety relied on the documented per-call price. | Operations |
| F11 | Redistribution: [RG] lists the current Token Screener as "Allowed, attribution required". The historical endpoints are **not listed** in the current guide. The project recorded them as "allowed with attribution" on 2026-09-24. | Documentation, to re-confirm with Nansen |
| F12 | [CS] documents `price_change` as a "percentage", but the observed values are ratios (median \|7d change\| 0.087). The Live code already detects the scale and refuses to guess. | Documentation (Nansen-side inconsistency) |
| F13 | There was no eligibility status. A weak round could only be deleted (destroying evidence) or kept player-facing, and History had no way to exclude it. Fixed offline: reversible status, gate and events (Phase 6). | Correctness |
| F14 | `/play` told a player "You have played every verified round" whenever `/next` found nothing, including when no round is approved. Fixed. | Documentation (player-facing claim) |
| F15 | An `open` Live round, eligible or not, holds the single Live slot: a replacement cannot be created until `5a76f497` is closed (M3). | Operations |
| F16 | RAY carries a "Yield Bearing" sector tag, so policy v2 excludes it. The `e2f5e059` successor therefore cannot pass without an explicit override. | Data quality (decision) |
| S1 | The e2e web server inherited the real `NANSEN_API_KEY` (and `next start` would re-read it from `.env.local` even if deleted). No credit was ever spent by it. Fixed. | Security |
| S2 | The gated code needs migration `1790266000000`, which production does not have yet: deploy and migrate together. | Correctness (deployment order) |
| S3 | `npm run migrate:up` changes `DATABASE_URL` with no confirmation step. Not changed. | Security / operations |
| S4 | `SESSION_SECRET` and `CRON_SECRET` are not set in `.env.local`. Both fail closed (tested), and deployment must set them. | Operations |

---

## Phase 1: call-site inventory

Every Nansen request goes through `nansenPost` in `src/lib/nansen/client.ts`, and it is the only code that reads `NANSEN_API_KEY`. There are three operations and three endpoints. `POST /api/v1/tgm/token-ohlcv` [PO] is **not used**.

### Shared client behaviour (all call sites)

| Item | Behaviour |
| --- | --- |
| Base URL | `https://api.nansen.ai`. Header `apikey`. JSON `POST`. 15 s timeout. |
| Budget | A `NansenCallBudget` reserves a slot **before** each HTTP attempt, retries included. The call cap is an integer from 1 to 10 per operation. |
| Logging | Every attempt writes an `api_call_log` row before the next request. If logging fails, the operation halts. |
| Retry | Up to 3 attempts, only for network errors, 429, 502, 503 and 504. Backoff is `Retry-After` when numeric, else 250 ms × 2^(n−1), capped at 10 s. A 401/403 or insufficient-credits response halts the operation. A malformed 2xx body is never retried. |
| Dedup | An identical request within one operation is served from memory and logged as a cache hit, using no slot. |
| Raw evidence | With `NANSEN_RAW_RESPONSE_DIR` set (operator scripts under `--confirm`), each body is kept verbatim with its request, status, request ID and SHA-256. |
| Rate limits [RL] | Free: 15/s, 300/min. Pro: 75/s, 1,500/min. The project sends at most 7 requests per operation, sequentially. |

### A. Live creation: current Token Screener

| # | Item | Value |
| --- | --- | --- |
| 1 | Source | `src/lib/services/liveSnapshot.ts`: `createRealLiveSnapshot` / `buildLiveScreenerRequests`. Entry points: `scripts/create-live-round.ts` (`--confirm`) and `POST /api/internal/live/create` (`CRON_SECRET`). |
| 2 | Endpoint | `POST https://api.nansen.ai/api/v1/token-screener` (v1) |
| 3 | Purpose | Candidates and 4 clues for a Live round, measured over the trailing 24h and 7d at the moment the round opens |
| 4 | Request sent (2026-09-26 16:47) | `{"chains":["solana"],"timeframe":"24h"\|"7d","filters":{"liquidity":{"min":100000},"token_age_days":{"min":30},"include_stablecoins":false,"include_native_tokens":false,"exclude_sectors":["Stablecoin","Tokenized Stocks","Yield Bearing","Liquid Staking","RWAs"]},"pagination":{"page":1,"per_page":100},"order_by":[{"field":"liquidity","direction":"DESC"}]}` |
| 5 | Docs | [CS] |
| 6 | Fields | Required: `chains`, and `timeframe` (recommended) or the deprecated `date`. Optional: `filters` (`liquidity`, `market_cap_usd`, `token_age_days`, `price_change`, volumes, `sectors`, `exclude_sectors`, `include_stablecoins`, `include_native_tokens`, …), `pagination`, `order_by`. |
| 7 | Dates | `timeframe` ∈ {5m, 10m, 1h, 6h, 24h, 7d, 30d}. The deprecated `date.from/to` takes ISO 8601 "2025-01-01T00:00:00Z or 2025-01-01". The project uses `timeframe` only ✓. |
| 8 | UTC and bounds | "Results reflect data as of request time". Retention: minute data 130 min, hourly 50 h, daily 50 days. |
| 9 | Pagination | `page` from 1; the project reads page 1 only (F9). |
| 10 | Max page size | 1000 (default 10). The project uses 100. |
| 11 | Credits | 1 per call [CR]. Observed `x-nansen-credits-used: 1`. |
| 12 | Retry | Shared. Cap `MAX_NANSEN_CALLS_PER_LIVE_CREATE`: default 3, run at 2. |
| 13 | Redistribution | [RG]: allowed, attribution required ("Powered by Nansen API" is shown). |
| 14 | Response | `{data:[{chain, token_address, token_symbol, token_age_days, token_age_hours, token_deployment_date, market_cap_usd, liquidity, price_usd, price_change, fdv, fdv_mc_ratio, buy_volume, sell_volume, volume, netflow, inflow_fdv_ratio, outflow_fdv_ratio}], pagination}`. **No `sectors`.** `price_change` is observed as a ratio (F12). |
| 15 | Null / omission | Tokens absent from one timeframe page are dropped (fail closed). Rows with missing clue inputs are rejected. |
| 16 | Pre-spend checks | Cap range. 24-hour timing invariants. No active Live round. *(Added in Phase 6: request schema.)* |
| 17 | Post-response checks | JSON parse. `price_change` scale detection (refuse if ambiguous). Symbol and sector exclusions. Clue computability. Exactly 3 candidates. *(Added: response schema, positive classification, volume floor.)* |

### B. Replay generation: Historical Token Screener

| # | Item | Value |
| --- | --- | --- |
| 1 | Source | `src/lib/services/replayForge.ts`: `forgeReplayRound` / `buildReplayScreenerRequests`. Entry point: `scripts/generate-replay.ts` (`--confirm`, global call and credit caps). |
| 2 | Endpoint | `POST https://api.nansen.ai/api/v1beta1/token-screener/historical` (v1beta1, beta) |
| 3 | Purpose | Eligible candidates and clue inputs at a historical cutoff, from a 7-day and a 1-day window |
| 4 | Request sent | `{"to_date":"YYYY-MM-DD","timeframe_days":7\|1,"chains":["solana"],"exclude_sectors":["Stablecoin"],"filters":{"liquidity_usd":{"min":2000000},"market_cap_usd":{"min":…,"max":…},"token_age_days":{"min":30}},"pagination":{"page":1,"per_page":50},"order_by":[{"field":"liquidity","direction":"DESC"}]}` |
| 5 | Docs | [HS] |
| 6 | Fields | Required: `to_date`, `timeframe_days` (1–365) and `chains`. Optional: `trader_type`, `sectors_filter`, `exclude_sectors`, `apply_blacklist_filter` (default true), `filters` {`volume_usd`, `buy_volume_usd`, `sell_volume_usd`, `market_cap_usd`, `fdv_usd`, `fdv_mc_ratio`, `liquidity_usd`, `netflow_usd`, …, `token_age_days`} with `{min,max}` inclusive, `pagination`, `order_by` (first element only). |
| 7 | Dates | `to_date` is `string (date)` in `YYYY-MM-DD` form. The project sends that exact form ✓. |
| 8 | UTC and bounds | **Not documented.** [HS] says only "anchored to `to_date`" and "price_usd: token price at to_date". Measured result: see F1 and Phase 2. |
| 9 | Pagination | Page 1 only; `is_last_page` is not read (F9). The observed responses had 7–12 rows and `is_last_page: true`. |
| 10 | Max page size | 1000 (default 10). The project uses 50. |
| 11 | Credits | 5 per call [CR]. Observed 5. |
| 12 | Retry | Shared. At most 7 attempts per round. |
| 13 | Redistribution | Not listed in the current [RG] (F11). Raw bodies are kept private. |
| 14 | Response | `pagination` plus `data:[{token_address, token_symbol, chain, price_usd, price_change (ratio), market_cap_usd (falls back to FDV if zero), fdv, fdv_mc_ratio, volume, buy_volume, sell_volume, netflow, inflow_fdv_ratio, outflow_fdv_ratio, token_age_days, liquidity, sectors[]}]`. Numeric fields nullable. |
| 15 | Null / omission | The market-cap fallback to FDV is invisible except through `fdv_mc_ratio` (F8). Results "may change after late data, pricing fixes, label corrections" [HS]. |
| 16 | Pre-spend checks | Plan caps, count 1–20, dates already attempted skipped. *(Added: request schema, credit cap.)* |
| 17 | Post-response checks | Re-applied filters, comparable-asset policy, clue computability, near-duplicate rule, 3 candidates. *(Added: response schema, positive classification, volume floor, pagination check.)* |

### C. Replay generation: Historical Token OHLCV (1h)

| # | Item | Value |
| --- | --- | --- |
| 1 | Source | `replayForge.ts`: `buildReplayOhlcvRequest`, `boundaryClose` |
| 2 | Endpoint | `POST https://api.nansen.ai/api/v1beta1/tgm/historical-token-ohlcv` (v1beta1, "Beta — subject to breaking changes") |
| 3 | Purpose | Entry and exit prices at the cutoff and resolution boundaries |
| 4 | Request sent | `{"chain":"solana","token_address":"…","date_from":"<cutoff−1d>T00:00:00Z","timeframe":"1h","as_of_date":"<resolution+1d>"}`. Example: `{"date_from":"2026-09-16T00:00:00Z","as_of_date":"2026-09-25"}` |
| 5 | Docs | [HO] |
| 6 | Fields | Required: `chain`, `token_address`, `date_from`, `timeframe`, and **exactly one** of `as_of_date` / `as_of_ts` (`as_of_ts` for Hyperliquid). Optional: `apply_blacklist_filter` (1d/1w only; a 400 otherwise). |
| 7 | Dates | `date_from`: ISO 8601 "Start of data window (date or datetime)". `as_of_date`: ISO date, "date-only values treated as end-of-day". `as_of_ts`: date-time. |
| 8 | UTC and bounds | Window `[date_from, as_of_date]`, inclusive. `interval_start` is the candle **opening** time (confirmed by DATA-CONTRACT §1.2). Observed: 240 candles, from `date_from` 00:00 through `as_of_date` 23:00, as documented. |
| 9 | Pagination | None. A single response with `truncated` and `truncation_note`. |
| 10 | Max size | 50,000 candles for most chains (about 5,000 for Hyperliquid). The project needs 240. |
| 11 | Credits | 5 per call [CR]. Observed 5. |
| 12 | Retry | Shared |
| 13 | Redistribution | Not listed in the current [RG] (F11) |
| 14 | Response | `{chain, token_address, timeframe, data:[{interval_start, open, high, low, close, volume, volume_usd, market_cap{open,high,low,close}}], truncated, truncation_note}`. OHLC values are nullable. |
| 15 | Null / omission | Thin tokens have **missing hours**: YZY in `96cad1d6` lacks 36 candles. Null closes are rejected at the boundary. A truncated response is rejected. |
| 16 | Pre-spend checks | Candidates must be final first (no price is fetched before selection). *(Added: request schema.)* |
| 17 | Post-response checks | Exact boundary candle with a positive, finite close; `truncated` rejects the round. *(Added: response schema, full outcome-window coverage, discontinuity check.)* |

### D. Live resolution: Historical Token OHLCV (5m)

| # | Item | Value |
| --- | --- | --- |
| 1 | Source | `src/lib/repo/live.ts`: `resolveLiveRound`. Entry points: `scripts/resolve-live-round.ts` (`--confirm`) and `POST /api/internal/live/resolve` (`CRON_SECRET`). |
| 2 | Endpoint | Same as C |
| 3 | Purpose | Entry and exit prices at the Live measurement boundaries (five-minute candle **open**) |
| 4 | Request (built, never sent) | `{"chain":"solana","token_address":"…","date_from":"2026-09-26T00:00:00Z","as_of_date":"2026-09-27","timeframe":"5m"}`. Before a 2026-09-26 edit, `date_from` was `"2026-09-26"`. |
| 5–7 | Docs, fields, dates | As C. Both `date_from` forms are documented as valid. |
| 8 | UTC and bounds | Measurement start 16:55, end 16:55 the next day, both exact 5-minute boundaries. `as_of_date` = end date, meaning through end of day. |
| 10 | Size | About 576 five-minute candles, far below 50,000 |
| 11 | Credits | 5 per call. Cap `MAX_NANSEN_CALLS_PER_LIVE_RESOLVE`: default 4; the authorized plan uses 3. |
| 16 | Pre-spend checks | Not before measurement end + 15 min. Round status. Within the retry window. *(Added: request schema, credit cap.)* |
| 17 | Post-response checks | Exact candles with a positive open. `truncated` means pending; after 6 hours the round becomes invalid. |

---

## Phase 2: dates and times

### The alleged `date_from` defect (F2)

1. **Endpoint:** `POST /api/v1beta1/tgm/historical-token-ohlcv` (Historical Token OHLCV, beta) [HO].
2. **Request bodies:**
   - Live resolve (never sent) used `"date_from":"2026-09-26"`.
   - Round Forge v2 originally used `"date_from":"YYYY-MM-DD"`. It was changed to `"…T00:00:00Z"` before the catalog run, so all 81 real catalog requests used the datetime form, as did round-001 in 2026-09 (DATA-CONTRACT §6).
3. **Official schema:** `date_from`: string, ISO 8601, required, "Start of data window (date or datetime)". `as_of_date`: ISO 8601, "Date-only values treated as end-of-day".
4. **The bare date was valid and documented. It was not invalid, and not even non-canonical.** An earlier report's statement ("the contract requires a full datetime") was wrong. The DATA-CONTRACT only recorded that the datetime form had been exercised.
5. Every real request used the documented datetime form, so no undocumented coercion was relied on. The bare-date form has never been sent.
6. **No** stored price, cutoff, return, winner or commitment depends on it. All 240-candle responses begin exactly at `date_from` 00:00 UTC, and both boundary candles are present.
7. **No round needs regenerating because of it.**

### Timestamps checked

| Item | Rule | Observed | Verdict |
| --- | --- | --- | --- |
| Replay cutoff C | 00:00 UTC | All 15 generated rounds and round-001 | ✓ |
| Replay entry | Close of the candle starting C−1h, which closes at C | Stored prices equal the raw candles in 45/45 assets | ✓ |
| Replay exit | Close of the candle starting C+7d−1h | 45/45 | ✓ |
| OHLCV range | `date_from` C−1d 00:00; `as_of_date` C+8d (end of day, inclusive) | 240 candles, first C−1d 00:00, last C+8d 23:00, `truncated: false` | ✓ |
| Outcome-window coverage | 169 hourly candles from C−1h to C+7d−1h | 44/45 complete. **YZY (`96cad1d6`): 136/169** | ✗ one asset |
| Historical-screener `to_date` | Sent as C's date, `YYYY-MM-DD` | Format ✓. **Anchoring ≈ C+12h** (F1) | ✗ semantics |
| Local-time shifts | All builders use `toISOString`/UTC getters; the Daily uses the database clock `(now() AT TIME ZONE 'UTC')::date` | No local-time API in any request path | ✓ |
| Daily window | `utc_date` D is live over [D 00:00, D+1 00:00) UTC | `resetAtUtc` = D+1 00:00Z | ✓ |
| Live snapshot | Published after both responses | Responses 16:47:22.096 and 16:47:23.891; published 16:47:24.058 | ✓ |
| Live entry close | +5 min | 16:52:24.058 | ✓ |
| Live measurement | Next 5-minute boundary ≥ entry + 60 s; +24 h | 16:55:00 → 2026-09-27 16:55:00 | ✓ |
| Live resolve allowed | End + 15 min | 2026-09-27 17:10:00 UTC | ✓ |
| Live price semantics | 5-minute candle **open** at each boundary. Equivalent to Replay's "close of the previous candle": both are the price at the boundary instant. | — | ✓ documented |

### F1: what `to_date` actually means (evidence)

[HS] does not define the window or which time `price_usd` refers to. It was measured using the 45 token-days where the same run fetched both the screener and hourly candles:

- **`price_usd` against the hourly close at C + k hours** (mean absolute relative error):
  - k = 0 (the cutoff): **1.94%**;
  - k = +12 h: **0.62%**, the minimum;
  - k = +24 h: 2.37%.

  The error rises steadily on both sides of +12 h, and the 1d and 7d rows carry identical `price_usd`.
- **1-day `price_change` against the candle change over a 24 h window ending at C + k:** mean error is **0.012 at k = +9 to +12 h** and 0.029 at k = +1 h. Per token, only 2 of 46 fit best when the window ends within 3 h of the cutoff.
- **Volume sums** don't discriminate: screener volume is about 2× candle `volume_usd` at every offset, a different volume definition.

- **A concrete case, round-001 (cutoff 2026-08-20 00:00).** Its data-gate files survive locally (outside the repository) as parsed bodies, so byte-level hashes cannot be re-verified, but the content is intact.
  - BOME's screener `price_usd` for `to_date=2026-08-20` is 0.0011435. The entry price at the cutoff is 0.00087552, so the screener price is **30.6% above it**.
  - BOME rose **49.5% in the first 12 hours after the cutoff**. The "7-day momentum: rising (+48%)" clue players saw was built from data that includes that post-cutoff move.

**Conclusion.** With `to_date = D`, the screener reflects the market around midday of D (UTC), later than the cutoff. Each round's clues therefore describe about 12 hours of the outcome window. Every Replay round is affected, round-001 included.

- **Leak-free rule:** use `to_date = C − 1 day`. Its snapshot (≈ C − 12 h, and at most C) ends before the entry price at C.
- **The saved raw data already allows this correction for the 15 generated rounds, with zero new calls.** Keep each round's clues (`to_date = D`) and move its outcome window to [D+1 00:00, D+8 00:00]. The saved candles run through D+8 23:00.
- Under that correction, **3 winners change**:

| Round | Winner now | Winner after correction |
| --- | --- | --- |
| `2cd1219b` | FARTCOIN | $WIF |
| `b752542f` | SYRUPUSDC | PRIME |
| `c3a06918` (today's Daily) | ZEREBRO | PIPPIN |

- round-001's hourly candles survive in the data-gate files (240 per token, through 2026-08-28 23:00), so it can be re-cut with zero calls: the winner stays POPCAT, and BOME goes from +20.9% to −12.6%. It still fails R3 (YZY volume $2,244).

This is strong empirical evidence, not a documented contract. Nansen should confirm the anchoring. Until it does, the product must treat the stored windows as leaking.

---

## Phase 3: all 85 logged calls

| Check | Result |
| --- | --- |
| `api_call_log` rows | 85: 4 `live_create` and 81 `replay_generate:<date>`. All HTTP 200. 0 failures, 0 retries, 0 cache hits. 85 distinct request IDs. |
| Credits | 417. Balance 1,010 → 593, matching the last `x-nansen-credits-remaining`. |
| Raw bodies | **83/85.** Every captured body re-hashes to its recorded SHA-256 (0 mismatches). |
| Raw ↔ log | For all 83: request ID, endpoint and status match. |
| Receipts ↔ raw | All 77 receipts with a request ID match a raw body on request body (canonical JSON), SHA-256, endpoint and credits. 0 mismatches. |
| Receipts ↔ log | 0 orphan receipts; every receipt points to a logged request. |
| Receipt-less successful calls | 8, all explained: Live attempt 1 (2), 2026-09-03 (4, missing AMAN candle), 2026-08-30 (2, too few tokens) |
| Calls without raw bodies | `35d99427f0c87169d14afa4bf4340f48` (16:34:46) and `820f0a044c70d00f99d28d51f5b90a35` (16:34:49), both `live_create`. Neither has a receipt, and no round was created within 60 s. **Billing evidence only, not product evidence.** |
| Older receipts | 11 rows without request IDs: round-001 (9) and `df397565` (2). They predate request-ID recording. Their evidence is DATA-CONTRACT §6. |

Unexplained differences: **none.**

---

## Phase 4: round-by-round eligibility

### Rules applied independently of the generator

| Rule | Requirement |
| --- | --- |
| R1 | Positively classified, freely traded native token. Excluded: stablecoin, wrapped or bridged copy, tokenized equity, RWA, LP or index token, yield-bearing token, or any token that cannot be confidently classified (unknown fails closed). |
| R2 | Liquidity ≥ $2M |
| R3 | 1d volume ≥ $100K |
| R4 | Complete hourly coverage of the outcome window (169/169), no null close, not truncated |
| R5 | No single-hour move above 30% inside the outcome window |
| R6 | No two retained rounds share two tokens |
| R7 | The clue snapshot ends at or before the entry price. **Every stored round fails** (F1). |

### Asset classification

| Class | Assets |
| --- | --- |
| **Clear** (the Nansen tag and the token's known identity agree) | POPCAT, BOME, MEW, PNUT, TRUMP, USELESS, FARTCOIN, $WIF, ANSEM, STONK, ZEREBRO, PENGU, YZY (class only), JUP, DBR (deBridge governance token, native), PUMP (pump.fun platform token, native) |
| **Conflict**: the tag disagrees with the known identity (investigate) | JELLYJELLY (tagged DEX; a pump.fun social or meme launch), PIPPIN (tagged DEX; an AI-agent memecoin), MELANIA (tagged NFTs; the memecoin), RAY (tags include "Yield Bearing"; the Raydium DEX governance token), ANTFUN (DEX / Scaling / GameFi; identity not confidently known; FDV/MC 4.7) |
| **Excluded** | SPYX, CRCLX (tokenized stocks); JLP (LP/index); PRIME (RWA / yield); SYRUPUSDC (stable-yield); MET (yield-bearing tag); ETH, HYPE, ZEC (Solana-bridged copies: bridged-supply caps of about $44–107M); SPX (bridged ERC-20: FDV/MC 0.09 inconsistent); CARDS (RWA); TRX (bridged); CBBTC |
| **Unknown, fails closed** | FO (no tag; FDV/MC 8.4; −47% in one hour on 09-09 04:00); ONYC (no tag; +0.3% a week, yield-like); XXXX (Live; about $1.3K of 24h volume) |

### Per-round table

All values come from the raw responses at the cutoff. The stored returns recompute exactly, and stored prices equal the raw candles in all 45 generated assets.

| Cutoff | Round | Assets (1d vol; notes) | Winner (stored) | Failed rules | **Status** |
| --- | --- | --- | --- | --- | --- |
| 08-14 | `2cd1219b` | FARTCOIN ($9.1M), DBR ($255K), $WIF ($242K) | FARTCOIN | R7 only | **INVESTIGATE**: re-cut candidate (winner → $WIF) |
| 08-16 | `4819fe5c` | ONYC (unknown), ANSEM, SPX (bridged) | SPX | R1 | **WITHDRAW** |
| 08-18 | `2c27efcd` | HYPE (bridged), ZEC (bridged), FO (unknown) | ZEC | R1, R7 | **WITHDRAW** |
| 08-20 | `be497aab` (round-001) | POPCAT, YZY ($2.2K), BOME (+49.5% in the first 12 h after cutoff) | POPCAT | R3 (YZY), R7 (demonstrated leak). Candles 169/169, not truncated. | **WITHDRAW** (status only; evidence untouched) |
| 08-22 | `8f99f74b` | JLP, PRIME, JUP | JUP | R1 ×2, R6 | **WITHDRAW** |
| 08-24 | `cc57b7f1` | PNUT ($330K), JELLYJELLY ($461K, conflict), MEW ($312K) | JELLYJELLY | R7; JELLYJELLY conflict; R6 with `3b64543d` | **INVESTIGATE**: keep this one of the pair |
| 08-26 | `b6df9b0b` | CARDS (RWA), ANTFUN (conflict), MELANIA | ANTFUN | R1, R6 | **WITHDRAW** |
| 08-28 | `2e17fb8f` | PENGU, RAY (conflict), TRUMP | RAY (−0.09%) | R7; R6 with `e2f5e059` | **WITHDRAW** (duplicate; the other of the pair is kept) |
| 09-01 | `02c50d6d` | ETH (bridged), MET (yield), CRCLX (stock) | CRCLX | R1 ×3 | **WITHDRAW** |
| 09-05 | `c3a06918` (**today's Daily**) | ZEREBRO, PIPPIN (conflict), FO (unknown, −47%/h) | ZEREBRO | R1, R5, R7 | **WITHDRAW** |
| 09-07 | `96cad1d6` | HYPE (bridged), FARTCOIN, YZY ($2K; 136/169 candles) | YZY | R1, R3, R4 | **WITHDRAW** |
| 09-09 | `b752542f` | JLP, PRIME, SYRUPUSDC | SYRUPUSDC | R1 ×3, R6 | **WITHDRAW** |
| 09-11 | `49bfd599` | PNUT, SPYX (stock), BOME | BOME | R1 | **WITHDRAW** |
| 09-13 | `045e7d9e` | STONK, ANTFUN (conflict), MELANIA ($32K) | STONK | R3, R6 | **WITHDRAW** |
| 09-15 | `e2f5e059` | RAY ($20.6M, conflict), TRUMP ($16.2M), USELESS ($22.7M) | USELESS | R7; RAY conflict | **INVESTIGATE**: keep this one of the pair |
| 09-17 | `3b64543d` | POPCAT, JELLYJELLY (conflict), MEW ($81K) | POPCAT | R3 (MEW), R6 | **WITHDRAW** |

**Result: no stored round is ELIGIBLE today.**
- Three rounds (`2cd1219b`, `cc57b7f1`, `e2f5e059`) pass every asset and coverage rule except R7, plus two tag conflicts. They can become eligible **successor rounds** by re-cutting the outcome window from the saved raw data, with zero Nansen calls.
- `2cd1219b` has no classification conflict at all.

### Near-duplicate recommendations

| Pair | Keep | Why |
| --- | --- | --- |
| `3b64543d` / `cc57b7f1` (JELLYJELLY, MEW) | **`cc57b7f1`** | Every asset clears the $100K volume floor. `3b64543d`'s MEW had $81K. Coverage is equal (169/169). |
| `e2f5e059` / `2e17fb8f` (RAY, TRUMP) | **`e2f5e059`** | Deeper liquidity for RAY ($8.9M against $6.6M) and USELESS ($4.4M against PENGU's $6.5M, offset by higher volume). A meaningful return spread (+9.6% to +42.8%), where `2e17fb8f` was all-negative with a −0.09% winner. |
| `045e7d9e` / `b6df9b0b` (ANTFUN, MELANIA) | Neither | `b6df9b0b` has an RWA (CARDS); `045e7d9e` fails the volume floor (MELANIA $32K) |
| `b752542f` / `8f99f74b` (JLP, PRIME) | Neither | Excluded assets |

---

## Phase 5: Live round `5a76f497-fac6-4517-9705-8b216e5a2cdb`

| Question | Finding |
| --- | --- |
| Request contract | Used the recommended `timeframe` (`24h`, `7d`) [CS]. The body is valid against the documented schema ✓. |
| Snapshot currency | Both responses returned at 16:47:22–24 UTC and describe data "as of request time" ✓. |
| Commitment | Computed inside `createLiveRound` on the final manifest (assets, clues, schedule, receipts) before insertion ✓ |
| PUMP (`pumpCm…9Dfn`) | pump.fun platform token, native SPL. Liquidity $19.2M, 24h volume $37.3M, MC $2.06B. Eligible. |
| XXXX (`7BgBvy…VkM3`) | Unknown class (the current screener returns no sectors). Liquidity $11.3M but **24h volume $1.3K** (buy $572, sell $718). Fails R1 and R3. |
| TRX (`GbbesP…LkKc`) | **Bridged representation** of Tron's native TRX. Bridged-supply MC $16.9M against TRX's multi-billion native cap. Fails R1. |
| Classification ability | The current screener has no `sectors` in its response, so no row could be positively classified. The request's `exclude_sectors` only removes known-bad tags. |
| **Classification** | **QUALITY INVALID.** Not contract-invalid: the request, timing and commitment are sound. 2 of 3 assets are ineligible. |
| Resolve it? | No. A resolution would publish a verdict on an ineligible round. Recommend marking it invalid (`quality_ineligible_assets`) without resolving. That saves 3 calls / 15 credits. |
| Replacement feasibility | It must be created by about **23:20 UTC on 2026-09-26** to resolve (+24 h +15 min) before the end of 2026-09-27 UTC, if that is the deadline. It needs a new authorization: create 2 calls / 2 credits (cap 3 / 3) plus resolve 3 calls / 15 credits (cap 4 / 20). **At most 7 attempts / 23 credits.** It would use the Phase 6 Live policy: `filters.sectors: ["Memecoins"]` (documented [CS]) for positive classification, a $100K volume floor, and bridged majors excluded. |

---

## Phase 6: offline safeguards

No Nansen request was made. Contract tests replay the 83 saved raw request/response pairs.

| Safeguard | Where |
| --- | --- |
| Runtime **request** schema per endpoint (strict: unknown fields rejected). Checked before the cache, the budget and the network. | `src/lib/nansen/contracts.ts`, `nansenPost` in `src/lib/nansen/client.ts` |
| Runtime **response** schema per endpoint. A 2xx that is not JSON, or has the wrong shape, halts the operation as `malformed_response` before any caller sees it. | same |
| Endpoint-specific date types: `HistoricalScreenerToDate` (date only), `OhlcvDateFrom` (date **or** UTC datetime), `OhlcvAsOfDate` (date only, end of day), `UtcDateTime` (must end in `Z`); `utcDateOf` / `utcDateTimeOf` | `contracts.ts` |
| Hard **credit** caps next to call caps (F10). The documented price is reserved before sending; an endpoint with no documented price is refused while capped. | `src/lib/nansen/budget.ts`; Live create 3 credits, Live resolve 20, forge 35 per round |
| Eligibility policy v2: positive classification only (unknown fails closed), excluded symbols and sectors, $100K 24h volume floor | `src/lib/domain/assetPolicy.ts` |
| Live policy: `filters.sectors: ["Memecoins"]` [CS], volume floor, `not_in_7d_page` when the 7d page was not the last | `src/lib/services/liveSnapshot.ts` |
| Round Forge v4: `to_date = cutoff − 1 day` (F1); outcome window must be complete, with no single-hour move above 30%; pagination-aware | `src/lib/services/replayForge.ts` |
| **Reversible eligibility status**: `pending_review` (default) / `approved` / `investigate` / `withdrawn`, stamped with the policy version, and every change is logged in `round_eligibility_events`. Player-facing means `approved` under the **current** version. | migration `1790266000000_round_eligibility_status` (applied to `tt_test` only), `src/lib/domain/eligibility.ts`, `src/lib/repo/eligibility.ts` |
| Gate on every player path: `/api/rounds/next`, today's Daily, Daily assignment (`round_not_approved`, re-checked under the lock), mode availability, `/api/live`, round GET (404 `round_not_available` without an own attempt; an `invalid` round stays readable as a void audit record, as `/docs#invalid` promises, and can never be locked), blind lock (no player or attempt created), Live resolution (`round_not_approved`, zero requests), History (`withdrawn`, excluded from metrics and streak) | `src/lib/repo/{rounds,availability,attempts,live,summary}.ts`, `src/lib/domain/history.ts`, routes |
| Review tool: dry run by default, `--confirm` to write, all-or-nothing, a note and actor required | `scripts/review-round.ts` (`npm run review:round`) |
| e2e server cannot spend credits: `NANSEN_API_KEY` is set to the empty string (see S1) | `playwright.config.ts` |

### Required tests

| Requirement | Test |
| --- | --- |
| UTC normalization | `nansenContracts.test.ts` › UTC normalization |
| Inclusive/exclusive candle boundaries | `replayForge.test.ts` › the entry is the candle starting an hour before the cutoff, never the one starting at it; `boundaryClose` rejects a gap instead of taking a neighbour |
| Omitted batch tokens | `replayForge.test.ts` › a token missing from the 7-day page is never guessed (`not_in_7d` / `not_in_7d_page`) |
| `truncated=true` | `replayForge.test.ts` › a truncated OHLCV response rejects the round even with HTTP 200 |
| Empty successful responses | `nansenContracts.test.ts` (an empty 200 passes the schema, and the caller decides); `replayForge.test.ts` › an empty screener response yields no round |
| Null prices and missing candles | `replayForge.test.ts` › null boundary close; incomplete window |
| Pagination beyond page 1 | `replayForge.test.ts` › same test, with `is_last_page=false` → `not_in_7d_page` (fail closed; page 2 is not fetched) |
| Unknown sectors and classifications | `replayForge.test.ts` › classification table; `liveCreateCreditGuard.test.ts` › Memecoins filter |
| Invalid payload fails before budget and network | `nansenContracts.test.ts` › 14 invalid payloads: fetch not called, 0 budget, 0 log rows |
| HTTP 200 can still fail closed | `nansenContracts.test.ts` › wrong shape halts; non-JSON halts; string price rejected |
| No silent grandfathering | `eligibilityGate.test.ts` › new rounds are `pending_review`; older-policy approval is not player-facing. `liveResolveCreditGuard.test.ts` › older-policy round refused |
| Withdrawn rounds excluded from Replay, Daily, summaries | `eligibilityGate.test.ts` (Replay, blind lock, round GET, Daily, Live, History); `history.test.ts` › withdrawn excluded from metrics and streak |
| No key → no spend | `nansenContracts.test.ts` › empty key refuses before budget, log and network |
| `SESSION_SECRET` fails closed | `sessionKeyFailClosed.test.ts` |

---

## Phase 7: product claims

"Verified" now always means four separate checks. The checks are stated on `/docs#verified` and in the verification panel under every verdict:

1. **Provenance:** every input traces to a logged Nansen response, by SHA-256 and request ID, and is sealed in the commitment.
2. **Calculation:** each return is `exit / entry − 1` on the committed candles, recomputable.
3. **Eligibility:** approved under the current policy.
4. **Availability:** only approved rounds are offered.

| Claim (before) | Where | Status |
| --- | --- | --- |
| "16 verified Replay rounds" | README, SUBMISSION-CHECKLIST | **Overstated.** All 16 pass checks 1–2 (45/45 generated assets recompute exactly), but none passes 3 (F1, F4). Corrected. |
| "a genuine Live round measuring" | README, checklist | **Overstated.** QUALITY INVALID (F3). Corrected. |
| "real Daily assigned" | README, checklist | True as provenance, but the round fails eligibility (F5). Corrected. |
| "109 after Live resolution" | API-USAGE-EVIDENCE, checklist | Removed: Live will not be resolved. The 106 total is still to be confirmed on the dashboard. |
| "screener decides which tokens qualify at the cutoff" | `/docs#nansen` | Imprecise (F1). Now "read as of the day before the cutoff". |
| `to_date = T` means "the window ends at T 00:00 UTC" | LIVE runbook, DATA-CONTRACT | **Wrong** (F1). Corrected. |
| "no FDV fallback" | DATA-CONTRACT §5b | **Overstated** (F8). Corrected. |
| "a fresh Nansen snapshot" | `/live` | Undefined freshness. Now "taken the moment the round opens, passes the eligibility policy". |
| "saved in this browser" | `/history`, `/play`, landing, FAQ | Accurate. Cookie-based, per browser, with the reset conditions stated. |
| "Verified trial" / "Verified verdict" | round header, verdict | Accurate once the gate is live: only approved rounds can be started. |
| "You have played every verified round." | `/play` | **Wrong when nothing is approved.** A new player would have seen it right after migration. `/api/rounds/next` now returns `reason: none_approved \| all_played`, and the page says "No verified round is open for play." when nothing is approved. |

---

## Phase 8: security and operations

| Check | Result |
| --- | --- |
| DB-writing scripts need `--confirm` | ✓ `assign-daily`, `create-live-round`, `generate-replay`, `import-verified-round`, `resolve-live-round`, `review-round` are all dry run by default. `test-db-setup` writes only to a schema matching `^tt_test` and refuses anything else. ⚠ **S3:** `npm run migrate:up` (node-pg-migrate CLI) targets `DATABASE_URL` with no confirmation step. |
| Nansen spending has hard call **and** credit caps | ✓ Live create 3 calls / 3 credits; Live resolve 4 / 20; forge 7 / 35 per round, and the catalog needs explicit `--max-calls` / `--max-credits`. |
| Production and test schemas cannot be confused | ✓ Vitest and Playwright refuse any `DB_SCHEMA` not matching `^tt_test`. `db.ts` refuses to connect under Vitest without it. `search_path` holds that schema alone. |
| Internal routes fail closed without `CRON_SECRET` | ✓ `internalAuth.test.ts`. `CRON_SECRET` is not set in `.env.local`, so the internal routes currently return 401. |
| Guest writes fail closed without `SESSION_SECRET` | ✓ In production, a missing, empty or short secret means no cookie is issued or trusted (new `sessionKeyFailClosed.test.ts`). It is not set in `.env.local`: dev uses a per-process key, and deployment must set it. |
| Secrets in logs, screenshots, build, bundles | ✓ The key, `DATABASE_URL` and its password do not appear in `.nansen-raw/` (83 files), `artifacts/` (77), `public/`, `docs/`, `src/`, `scripts/`, `tests/`, top-level docs, git history or staged changes. The `.next` build output is scanned after the final build. |
| **S1 (fixed): the e2e server held the real Nansen key.** `playwright.config.ts` loaded `.env.local` and passed the whole environment to `next start`. Deleting the variable would not help either: Next re-fills *undefined* variables from `.env.local`. | Now set to the empty string. The client refuses to send without a key, before any budget or log (tested). No e2e run ever spent a credit: all 85 logged calls reconcile to script operations (Phase 3). |
| No route exposes raw Nansen bodies | ✓ Players see receipts only (endpoint, purpose, SHA-256, request ID, time). `/api/internal/usage` returns aggregate counts, behind `CRON_SECRET`. Raw bodies live only in the git-ignored `.nansen-raw/`. |
| No test can reach Nansen | ✓ Vitest deletes the key and blocks `*.nansen.ai` in `fetch`. e2e blanks the key (S1). |
| No page read creates an attempt | ✓ No GET handler has a write path. `eligibilityGate.test.ts` shows a refused blind lock leaves 0 players and 0 attempts. |
| Withdrawn or invalid rounds not selectable | ✓ `/next`, Daily and Live navigation all use the player-facing predicate (`eligibilityGate.test.ts`). Invalid Live rounds were already excluded. |
| **S2: gated code needs the migration** | The eligibility code queries columns that exist only after migration `1790266000000`. Production has not been migrated, so this code must not serve production until the migration and review decisions are applied together. |

---

## Phase 9: proposed production mutations (listed, not executed)

Production as read at the end of the audit, read-only:
- 18 rounds (16 Replay, 2 Live);
- 1 player (the kept guest row);
- **0 attempts on any round**;
- 1 Daily (2026-09-26 → `c3a06918`);
- `api_call_log` 85 calls / 417 credits, unchanged since the catalog run.

Nothing below has been run. Each step is exact and needs approval.

| # | Mutation | Command / exact change | Effect |
| --- | --- | --- | --- |
| M1 | Apply migration `1790266000000_round_eligibility_status` | `npm run migrate:up` | Adds four columns and `round_eligibility_events`. All 18 rounds become `pending_review`, so **nothing is player-facing**: Replay says "No verified round is open for play", and the 09-26 Daily and Live are hidden. No existing value changes. |
| M2 | Record review decisions | `npm run review:round -- --plan <file> --actor <name> --confirm` (dry run first). The plan lists full UUIDs, resolved from the prefixes below. | **withdrawn** (13): `4819fe5c`, `2c27efcd`, `be497aab` (round-001; evidence untouched), `8f99f74b`, `b6df9b0b`, `2e17fb8f`, `02c50d6d`, `c3a06918`, `96cad1d6`, `b752542f`, `49bfd599`, `045e7d9e`, `3b64543d`. **investigate** (3, stored windows leak): `2cd1219b`, `cc57b7f1`, `e2f5e059`. **withdrawn**: Live `5a76f497` and `df397565` (audit record). |
| M3 | Close Live `5a76f497` without resolving | `UPDATE rounds SET status = 'invalid', invalid_reason = 'quality_ineligible_assets' WHERE id = '5a76f497-fac6-4517-9705-8b216e5a2cdb' AND status = 'open'`: exactly one row; commitment, manifest and receipts untouched | Frees the single Live slot. An `open` round blocks any replacement. Saves the reserved 3 calls / 15 credits. Its page then reads as a void record, with copy specific to `quality_ineligible_assets`: "withdrawn before resolution … not fair comparisons". |
| M4 | Daily 2026-09-26 | No change to `daily_challenges` | Hidden by M2 (`c3a06918` withdrawn). The row stays as history. |
| M5 | Re-cut successors, **zero Nansen calls** | A new offline script (not yet written; dry run by default, tested in `tt_test` first). It builds a new round with cutoff D+1 00:00 from the saved `to_date = D` screener responses and the saved OHLCV candles, window [D+1, D+8]. That is exactly v4's `to_date = cutoff − 1 day`. Receipts reuse the original request IDs and hashes. The new round starts `pending_review`. | `2cd1219b` → successor, winner **$WIF**, no classification conflict. `cc57b7f1` → successor, winner JELLYJELLY: passes policy v2 by its DEX tag, but its identity conflict is your call. `e2f5e059` → **fails policy v2**: RAY carries a "Yield Bearing" tag. Only an explicit override could approve it, which is not recommended. Each successor must re-pass R4/R5 on the shifted window before approval. |
| M6 | Approve successors | `npm run review:round … --status approved --confirm` after a manual check of each successor | Makes 1–2 rounds player-facing. |
| M7 | Daily 2026-09-27 | `npm run assign:daily -- --round <2cd1219b successor> --date 2026-09-27 --confirm` | The only candidate with no open question. While it is the Daily, Replay excludes it, so Replay would hold 0–1 rounds that day. |
| M8 | *(needs a spending authorization)* Replacement Live | `npm run create:live -- --confirm`, then `resolve:live` after the window | At most **7 attempts / 23 credits** (create ≤3 / 3, resolve ≤4 / 20). It must be created by about **23:20 UTC on 2026-09-26** to resolve before the end of 09-27 UTC. It needs M1 and M3 first. It would open approved under the automated Live policy v2, and a reviewer can still withdraw it. |

**Deployment prerequisites (not mutations):** set `SESSION_SECRET` (≥ 32 characters) and `CRON_SECRET`. Apply M1 before, or together with, deploying this code (S2).

---

## Phase 10: executed on 2026-09-26 (owner-approved)

Zero Nansen calls. `api_call_log` is still at 85 requests / 417 credits.

| Step | Result |
| --- | --- |
| Migrations | `1790266000000_round_eligibility_status` and `1790267000000_round_lineage` applied to production (8 of 8) with `npm run migrate:up -- --confirm`. The dry run named the target first. |
| Live `5a76f497…` | `status = invalid`, `invalid_reason = quality_ineligible_assets`, set by `npm run invalidate:live`. Never resolved. |
| Old rounds | All 16 stored Replay rounds and both Live rounds are **withdrawn** (18 logged decisions). The owner withdrew every leaking round, including the three the audit had marked INVESTIGATE. Nothing was deleted, and commitments and receipts are unchanged. |
| Rebuilds | `c5e34c58-24aa-4c91-87ef-e063247eb613`, from `2cd1219b` (FARTCOIN / DBR / $WIF, cutoff 2026-08-15, winner $WIF +43.92%). `d2ecc59b-cefd-46d6-90c0-966720441afe`, from `cc57b7f1` (PNUT / JELLYJELLY / MEW, cutoff 2026-08-25, winner JELLYJELLY −1.71%). Each is a new round with its own commitment and `rebuilt_from` set, built only from the 5 preserved responses its ancestor used. |
| Rebuild selection | The current policy v2 is applied to the preserved rows. Token reuse (±14 days) is judged against the catalog that existed when the data was fetched, as the generator did. That excluded ANTFUN (in `b6df9b0b`) and POPCAT (in round-001). Near-duplicates are judged among approved rounds. Without the reuse exclusion the selection would differ, and those tokens have no preserved candles, so the rebuild would fail closed. |
| Leak-freedom evidence | Every row of a screener response shares one snapshot, so it is estimated jointly against the preserved hourly candles. `c5e34c58`: price level fits best 2h before the cutoff (0.14% mean error, against 1.05% at or after it); 1-day change fits 15h before (0.48pp against 0.86pp). `d2ecc59b`: price 22h before (0.08% against 0.17%); 1-day change 12h before (0.34pp against 0.38pp; the thinnest margin). Across all 16 preserved dates the joint fit never falls at or after D+24h. |
| Independent verification | `npm run verify:rebuilt` (imports nothing from `src/`): 1,314 checks, 0 failures. It covers receipts ↔ preserved bodies, clues, positive classification (JELLYJELLY: Nansen tag "Decentralised Exchanges"), volume and liquidity floors, 169/169 candles, worst hourly move ≤ 5.8%, entry/exit closes, returns, winners, commitments and lineage. |
| Approval | Both rebuilds approved under policy v2. They share no tokens. |
| Daily 2026-09-26 | Reassigned from `c3a06918…` to `c5e34c58…` after confirming 0 attempts. The row keeps `prior_round_id`, `replaced_at` and `replacement_reason`. |
| `npm run verify` | 209 checks, 0 failures: 18 original rounds withdrawn, 2 rebuilt rounds approved, today's Daily approved. |
| Player-facing state | `/next` serves only the two rebuilds, and not the Daily round on its day. `/api/daily` serves `c5e34c58…`. `/api/live` has nothing playable. |
