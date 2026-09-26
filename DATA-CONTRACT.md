# Data Contract — Trench Trials v1.1

Status: **Gate 1 PASSED.** One complete, real Replay round was generated end-to-end using authenticated Nansen API calls on 2026-09-24. This document records the exact endpoints, request/response shapes, formulas, timestamps, credit costs and redistribution basis observed during that validation. It is not derived from documentation alone — every field and number below was independently confirmed by a live authenticated call, except where explicitly marked "from docs, not yet exercised."

**Verification boundary, stated precisely:** the round is *recalculable* — its returns, winner and clue buckets can be regenerated from the frozen derived price/volume inputs stored in `data/verified-rounds/round-001.json`, and that recalculation can be checked against the recorded SHA-256 response hashes for internal consistency. It is not *independently authenticable* from the hashes alone — a hash proves that a later re-fetch matches (or doesn't match) what was originally stored, but it cannot reconstruct or independently re-verify the original Nansen response content, since raw response bodies are not retained in the repository (only outside it, in local session storage, per the redistribution policy in §3). Treat the hashes as tamper/drift detection against the original raw capture, not as a substitute for that raw capture.

No mock, fixture, seeded or fallback-provider data appears anywhere in this document or in the round it describes.

---

## 1. Endpoints used

### 1.1 Historical Token Screener (discovery + pre-cutoff clue inputs)

```
POST https://api.nansen.ai/api/v1beta1/token-screener/historical
Header: apikey: <NANSEN_API_KEY>
Header: Content-Type: application/json
```

**Confirmed request fields** (validated by real 200 and 422 responses):

| Field | Type | Notes |
| --- | --- | --- |
| `to_date` | string (date) | Required. Window end date, e.g. `"2026-08-20"`. **Not a midnight boundary:** values read at about `to_date` 12:00 UTC (audit F1). So a round with entry at D 00:00 UTC must use `to_date = D − 1 day`. |
| `timeframe_days` | integer 1–365 | Required. Window length ending at `to_date`. |
| `chains` | array | Required, non-empty. `"solana"` confirmed working. |
| `exclude_sectors` | array of strings | Confirmed working with `["Stablecoin"]`. |
| `sectors_filter` | array of strings | Documented, not yet exercised. |
| `filters.liquidity_usd` | `{min, max}` | **Not `filters.liquidity`** — that name returns `422 unknown_field`. Confirmed correct name via docs then live call. |
| `filters.market_cap_usd` | `{min, max}` | Confirmed working. |
| `filters.token_age_days` | `{min, max}` (integer) | Confirmed working. |
| `filters.volume_usd`, `buy_volume_usd`, `sell_volume_usd`, `netflow_usd`, `fdv_usd`, `fdv_mc_ratio`, `inflow_fdv_ratio`, `outflow_fdv_ratio`, `nof_traders`, `nof_buyers`, `nof_sellers`, `nof_buys`, `nof_sells` | range filters | From docs, not exercised. |
| `filters.sm_label_filter`, `exclude_sm_labels_filter` | Smart Money label filters | **Deliberately not used** — see §4 redistribution note. |
| `pagination.page` / `pagination.per_page` | integers | `per_page` confirmed up to 50 in testing (docs cap: 1000). |
| `order_by` | array of `{field, direction}` | Confirmed with `[{"field":"liquidity","direction":"DESC"}]`. |

**No `token_address` filter exists on this endpoint** — confirmed absent from the documented filter field list. Specific tokens must be located by paging/filtering, not looked up directly.

**Confirmed response fields** (per token row, path `data[]`):

`token_address`, `token_symbol`, `chain`, `price_usd`, `price_change` (ratio over the requested `timeframe_days`, ending at about `to_date` 12:00 UTC, F1), `market_cap_usd`, `fdv`, `fdv_mc_ratio`, `volume`, `buy_volume`, `sell_volume`, `netflow`, `inflow_fdv_ratio`, `outflow_fdv_ratio`, `token_age_days`, `liquidity`, `sectors` (array).

Pagination envelope: `pagination.page`, `pagination.per_page`, `pagination.is_last_page`.

**Observed behavior:**
- `liquidity` and `market_cap_usd` are point-in-time values as of `to_date` (anchored at about 12:00 UTC that day, F1). `market_cap_usd` is documented to fall back to FDV when zero (F8), so a populated value may be an FDV — confirmed identical between a `timeframe_days=1` call and a `timeframe_days=7` call for the same `to_date` and same token (`liquidity` matched to the full floating-point value in all 3 tokens tested).
- `volume`, `buy_volume`, `sell_volume`, `netflow` are window-summed over `timeframe_days`.
- `price_change` is the ratio price change over the window (i.e. requesting `timeframe_days=7` gives the trailing-7-day return ending at `to_date` directly — no separate calculation needed for the momentum clue).
- Zero-liquidity tokens exist in real results (observed `liquidity: 0` for several tokenized-stock-sector tokens, e.g. `GOMINING`, `IBITON`, `CRCLON`, `IVVON`, `SPYON` at `to_date=2026-08-20`). This is a genuine zero, not a null — confirms the eligibility floor (`liquidity_usd.min`) must be enforced to avoid divide-by-zero in the netflow/liquidity clue.
- No `null` values were observed in any field for tokens that passed the liquidity/market-cap eligibility filters used in the validation round.

**Credit cost observed:** 5 credits per call, every call, regardless of `per_page` or filter complexity (matches PRD's documentation note).

**Billing behavior:** A `422` validation error (bad field name) was **not** billed — confirmed by comparing `X-Nansen-Credits-Remaining` before and after. Only requests that pass validation and execute are charged.

---

### 1.2 Historical Token OHLCV (outcome prices)

```
POST https://api.nansen.ai/api/v1beta1/tgm/historical-token-ohlcv
Header: apikey: <NANSEN_API_KEY>
Header: Content-Type: application/json
```

**Confirmed request fields:**

| Field | Type | Notes |
| --- | --- | --- |
| `chain` | enum | `base`, `bnb`, `ethereum`, `hyperliquid`, `solana`. `solana` confirmed working. |
| `token_address` | string | Contract address (or Hyperliquid coin symbol). |
| `date_from` | ISO date/datetime | Confirmed with `"2026-08-19T00:00:00Z"`. |
| `timeframe` | enum | `5m,15m,30m,1h,4h,1d,1w`. `1h` confirmed working. |
| `as_of_date` | ISO date | Upper bound of window; confirmed with `"2026-08-28"`. |
| `as_of_ts` | ISO datetime | Alternative to `as_of_date`, Hyperliquid-only per docs; not exercised. |

Exactly one of `as_of_date` / `as_of_ts` is required (docs); only `as_of_date` was exercised.

**Confirmed response shape:**

```
{
  chain, token_address, timeframe,
  data: [{ interval_start, open, high, low, close, volume, volume_usd,
           market_cap: { open, high, low, close } }, ...],
  truncated: boolean,
  truncation_note: string|null
}
```

**Observed timestamp/candle semantics (this is the part the PRD explicitly required us to verify before locking implementation):**

- `interval_start` marks the candle's **opening** time.
- For a 1h request spanning 2026-08-19T00:00Z → 2026-08-28T23:00Z, exactly 240 candles were returned (10 days × 24h), `truncated: false`. No gaps observed.
- Confirmed by direct inspection: candle `open` equals the immediately preceding candle's `close` exactly (`0.0008768407387350098 === 0.0008768407387350098`) — candles are contiguous with no gap-filling artifacts, at least for this liquid-enough token in this window.
- No `null` values observed anywhere in the 720 candles retrieved (3 tokens × 240 candles) for this round.
- **Entry price policy (adopted):** the close of the candle whose `interval_start = T − 1h`, i.e. the candle that closes exactly at cutoff `T`. For `T = 2026-08-20T00:00:00Z`, entry candle `interval_start = "2026-08-19T23:00:00Z"`.
- **Exit price policy (adopted):** the close of the candle whose `interval_start = (T + 7d) − 1h`, closing exactly at `T + 7 days`. For this round, `interval_start = "2026-08-26T23:00:00Z"`.
- Both boundary candles closed **exactly** at their target timestamps in this test (zero deviation) — the "within one interval of target" tolerance in PRD §12 was not needed here but remains the documented fallback rule for tokens with gaps.

**Credit cost observed:** 5 credits per call (one call retrieves an entire date range in one request — no per-candle or per-day cost).

**Chain coverage note:** Solana is supported by both endpoints used, satisfying the PRD's chain-selection preference.

---

### 1.3 Current Token Screener (Live snapshots)

```
POST https://api.nansen.ai/api/v1/token-screener
```

Confirmed by real calls on 2026-09-26 (Live round `5a76f497…`, request IDs `fee8e520…` and `1493b612…`):

- **Request:** `chains`, `timeframe` (`"24h"`, `"7d"`), `pagination`, `order_by`, and a `filters` object. Filters used: `liquidity {min}`, `token_age_days {min}`, `include_stablecoins: false`, `include_native_tokens: false`, `exclude_sectors`. The liquidity filter is named `liquidity` here, not `liquidity_usd` as on the historical screener.
- **Response:** `{ data: [...], pagination }`. Row fields: `chain, token_address, token_symbol, token_age_days, token_age_hours, token_deployment_date, market_cap_usd, liquidity, price_usd, price_change, fdv, fdv_mc_ratio, buy_volume, sell_volume, volume, netflow, inflow_fdv_ratio, outflow_fdv_ratio`. There is **no `sectors` field**, so sector exclusion must be a request filter.
- **`price_change` is a ratio over the requested timeframe**, as on the historical screener. The docs call it a "percentage". The observed median |7d change| across 100 rows was 0.087. The Live code reads the scale from the data on every snapshot and refuses to guess when it is ambiguous.
- **Cost:** 1 credit per call (docs; `x-nansen-credits-used: 1` observed).
- **Why Live uses it:** the historical screener with `to_date` = today returned no usable rows on 2026-09-26. A Live snapshot must describe the market at the moment the round opens.

## 2. Endpoint NOT used: Historical Token Flow Summary

`POST /api/v1beta1/tgm/historical-token-flow-summary` was inspected via documentation but **deliberately excluded from the clue design.** Its response is entirely Smart-Money-segment data (`whale_*`, `public_figure_*`, `smart_trader_*`, `top_pnl_*`), and the Nansen redistribution guide classifies Smart Money endpoints as:

> "These endpoints contain Nansen's proprietary smart money insights and require both approval AND significant data modification" — not directly redistributable without a separate approval process.

The Historical Token Screener alone supplies everything needed for all 4 clues (see §3), so this restricted endpoint is not a dependency of the product. This is a change from the PRD's draft clue table, which listed flow-summary as a candidate source — superseded by this finding.

---

## 3. Redistribution status (from `docs.nansen.ai/guides/redistribution-guide`, confirmed 2026-09-24)

| Source | Status | Attribution |
| --- | --- | --- |
| Historical Token Screener (`token-screener/historical`) | ✅ Allowed | "Powered by Nansen API" or clickable link, required |
| Historical Token OHLCV (`tgm/historical-token-ohlcv`) | ✅ Allowed (standard market price data) | Same as above |
| Historical Token Flow Summary (`tgm/historical-token-flow-summary`) | ⚠️ Restricted — Smart Money data, requires approval + substantial transformation | Not used in this product |

**Product policy:** only the two ✅ Allowed endpoints are load-bearing for gameplay. No Smart Money segment data, holder data, or "who bought/sold" data is used or displayed anywhere. This keeps the entire clue and outcome pipeline inside the unambiguously-permitted redistribution class.

---

## 4. Clue formulas (adopted, final — supersedes PRD §10 draft)

All 4 clues are computed from **two Historical Token Screener calls per round** (not per token — a single `timeframe_days=1` call and a single `timeframe_days=7` call, both `to_date = T − 1 day` (Round Forge v4; v2 and v3 used `T`, which read about 12 hours past entry, F1), both filtered to the same eligibility band, cover all 3 candidates at once):

| # | Clue | Formula | Source fields |
| --- | --- | --- | --- |
| 1 | Buy/sell balance | `(buy_volume_1d − sell_volume_1d) / (buy_volume_1d + sell_volume_1d)` | 1-day call: `buy_volume`, `sell_volume` |
| 2 | Trading acceleration | `volume_1d / (volume_7d / 7)` | 1-day call: `volume`; 7-day call: `volume` |
| 3 | Netflow / liquidity | `netflow_1d / liquidity` | 1-day call: `netflow`, `liquidity` |
| 4 | Recent momentum | `price_change_7d` (used directly, no further transform) | 7-day call: `price_change` |

Buckets (unchanged from PRD §10, frozen before any outcome was inspected):
- Buy/sell balance: `< −0.10` sell-heavy · `−0.10..0.10` balanced · `> 0.10` buy-heavy
- Trading acceleration: `< 0.75` slowing · `0.75..1.25` steady · `> 1.25` accelerating
- Netflow/liquidity: `< −0.05` outward · `−0.05..0.05` balanced · `> 0.05` inward
- Recent momentum: `< −0.05` falling · `−0.05..0.05` flat · `> 0.05` rising

**Divide-by-zero protection:** rounds require `liquidity_usd.min = 2,000,000` at candidate-selection time (see §5), which makes a zero-liquidity denominator in clue 3 impossible for any selected candidate. `buy_volume + sell_volume = 0` is handled as "unavailable" (round-reject), not zero — not observed in practice at this liquidity floor.

---

## 5. Round Forge — eligibility & selection policy v1 (frozen, pre-outcome)

Applied in this exact order, entirely from pre-cutoff data:

1. `chain = solana`
2. `exclude_sectors = ["Stablecoin"]`
3. `filters.liquidity_usd.min = 2,000,000`
4. `filters.token_age_days.min = 30`
5. `filters.market_cap_usd` band — versioned per round; validation round used `[40,000,000, 100,000,000]`
6. Sector tag: exactly `["Memecoins"]` (single-tag match) preferred for narrative comparability between candidates in one round
7. Sort remaining eligible candidates by `liquidity` DESC; take the top 3
8. Slot assignment: sort the 3 selected token addresses **ascending by raw string value** and assign to A, B, C in that order. This is deterministic and independent of any return data — no random or outcome-influenced step.

This policy is versioned (`round_forge_version: 1`) and must be frozen before generation; any change requires a version bump, applied only to newly generated rounds.

No candidate was excluded, re-drawn, or swapped after step 8. No outcome/price data was fetched until candidate selection and slot assignment were already complete and recorded.

### 5b. Round Forge v2 and v3 — catalog generation policy (run 2026-09-26)

`src/lib/services/replayForge.ts`, run with `npm run generate:replay`. Each generated round stores this policy in its `eligibility_policy` and commits it in its manifest.

1. Cutoffs fall at 00:00 UTC, every second day, newest first. The newest cutoff is 9 days before the run: a 7-day horizon plus 2 days for indexing. A date that already has a catalog round is skipped.
2. Screener requests: `to_date = cutoff date − 1 day` (Round Forge v4; v2 and v3 used the cutoff date, which read about 12 hours past entry, F1), `timeframe_days` 7 and 1, `chains=[solana]`, `exclude_sectors=[Stablecoin]`. Filters: `liquidity_usd.min = 2,000,000`, `token_age_days.min = 30`, and a `market_cap_usd` band. Results are ordered by liquidity, descending, 50 per page.
3. The market-cap band rotates with the cutoff date, `floor(epochDay / 2) mod 3`, through $20M–$60M, $60M–$200M and $200M–$1B, so consecutive rounds compare tokens of different sizes.
4. The response is filtered again in code:
   - every filter above is re-applied;
   - stablecoins, wrapped majors and liquid-staking symbols are excluded;
   - a missing market cap excludes the token. The code adds no FDV fallback of its own, but Nansen documents that `market_cap_usd` itself falls back to FDV when zero, so the band may compare FDVs for some tokens (F8);
   - any clue input that is missing or has a zero denominator excludes the token;
   - a token used by another catalog round within ±14 days of the cutoff is excluded.
5. The top 3 by liquidity are taken. Slots are assigned by token address ascending. Fewer than 3 eligible tokens rejects the date, with no OHLCV requests.
6. Outcome: one `historical-token-ohlcv` request per slot, `timeframe=1h`, `date_from = cutoff − 1 day`, `as_of_date = resolution + 1 day`.
   - Entry price is the close of the candle starting at `cutoff − 1h`. Exit price is the close of the candle starting at `resolution − 1h`, as in v1.
   - A missing, non-positive or truncated boundary candle rejects the round. Neighbouring candles are never used.
7. Each round stores one `source_receipts` row per response, holding the request body, SHA-256, request ID, credits and purpose (`replay_discovery_7d|1d`, `replay_outcome_A|B|C`). The round and its receipts are written in one transaction.

Budget: 5 requests per round, each round capped at 7 including retries. Default run caps are `count × 5 + ⌈count / 2⌉` requests and 5 credits per capped request. For 15 rounds that is 83 requests and 415 credits.

**v2 run (2026-09-26 16:37–16:39 UTC):** 13 rounds created and 2 dates rejected, using 71 requests and 355 credits.

- 2026-09-03 was rejected because AMAN had no candle at the entry boundary.
- 2026-08-30 was rejected with only 2 eligible tokens.

The v2 rules still let through tokens that aren't comparable:
- tokenized stocks (SPYX, CRCLX);
- yield, LP and stable-derivative tokens (JLP, PRIME, SYRUPUSDC, MET);
- bridged majors (ETH, HYPE, ZEC).

Its reuse window of ±14 days also allowed four pairs of rounds that share two of three tokens.

**v3 changes (frozen 2026-09-26 16:52 UTC)**, recorded in each v3 round's `eligibility_policy`:

- The shared comparable-asset policy (`src/lib/domain/assetPolicy.ts`) excludes:
  - by symbol: stablecoins and stable-yield wrappers, wrapped or bridged majors, liquid-staking and LP tokens;
  - by Nansen sector: `Stablecoin`, `Tokenized Stocks`, `Yield Bearing`, `Liquid Staking`, `RWAs`.
- A **catalog-wide near-duplicate rule**: a new round may not share two or more tokens with any existing round. Selection keeps the most liquid tokens and skips any token that would create such an overlap.
- **Resumable planning:** a date with any logged `replay_generate:<date>` request is skipped, including rejected dates.

**v3 run (16:53 UTC):** 2 rounds created, using 10 requests and 50 credits: 2026-08-16 (ONYC / ANSEM / SPX) and 2026-08-14 (FARTCOIN / DBR / $WIF). ONYC carries no Nansen sector tag.

---

## 6. Validation round — full evidence

**Cutoff `T`:** `2026-08-20T00:00:00Z`. **Horizon:** 7 days. **Chain:** Solana. **Candle interval:** 1h.

| Slot | Symbol | Address | Sector(s) |
| --- | --- | --- | --- |
| A | POPCAT | `7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr` | Memecoins |
| B | YZY | `DrZ26cKJDksVRWib3DVVsjo9eeXccc7hKhDJviiYEEZY` | Memecoins |
| C | BOME | `ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82` | Memecoins |

**Pre-cutoff clues (computed, real):**

| Slot | Buy/sell balance | Trading acceleration | Netflow/liquidity | Momentum (7d) |
| --- | --- | --- | --- | --- |
| A (POPCAT) | 0.0435 → balanced | 3.369 → accelerating | 0.0049 → balanced | +0.0712 → rising |
| B (YZY) | −0.3866 → sell-heavy | 1.183 → steady | −0.0001 → balanced | −0.0197 → flat |
| C (BOME) | 0.0245 → balanced | 4.595 → accelerating | 0.0704 → inward | +0.4803 → rising |

**Outcomes (real, computed from OHLCV close prices):**

| Slot | Entry close (2026-08-19T23:00Z candle) | Exit close (2026-08-26T23:00Z candle) | Return |
| --- | --- | --- | --- |
| A (POPCAT) | 0.04301576711450214 | 0.05943781587754146 | **+38.18%** ← winner |
| B (YZY) | 0.28814116434640574 | 0.29410094634471007 | +2.07% |
| C (BOME) | 0.0008755176038674171 | 0.0010584368615523848 | +20.89% |

`return = exit_close / entry_close − 1`, unrounded internally, displayed rounded to 2dp.

**Illustrative switch-impact example** (not a real player attempt — for verification only): a player blind-picks B (slot order only, no names visible) and after Unmask switches to A once told the names.
`switch_impact_pp = 100 × (0.3817681… − 0.0206835…) ≈ +36.1 pp` (switching would have helped, in this specific real round).

**Request provenance** (all calls made 2026-09-24, ~14:01–14:06 UTC, from this session):

| Call | Endpoint | Params | Request ID | Credits used | Response SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Discovery (7d, liquidity-sorted, unfiltered band) | screener/historical | `to_date=2026-08-20, timeframe_days=7, chains=[solana], exclude_sectors=[Stablecoin]` | `e47bb26997ee813d652d990ad0ffcc6c` | 5 | `b4563311e28b5b33...` |
| Band filter, 7-day (final candidate pool) | screener/historical | `+ filters.liquidity_usd.min=2e6, market_cap_usd=[4e7,1e8], token_age_days.min=30` | `ae17442be1680a09009a4f79feea1c6` *(9 preceding, not billed — 422 on first attempt with wrong field name `filters.liquidity`; free, confirmed via balance check)* | 5 | `a6bfea94c602f813...` |
| Band filter, 1-day (clue inputs) | screener/historical | same filters, `timeframe_days=1` | `b4f2e31a4c46281843acda525bf8824` | 5 | `9b17bb6d06142ec0...` |
| OHLCV — BOME | tgm/historical-token-ohlcv | `date_from=2026-08-19T00:00Z, timeframe=1h, as_of_date=2026-08-28` | `3c055439eb9f7643fac0c77a3370c46` | 5 | `2a64e0e30ac8a925...` |
| OHLCV — YZY | tgm/historical-token-ohlcv | same window | `c4e4db45c28d56096b4b705d5cc6b86d` | 5 | `2916ffb4dd82c095...` |
| OHLCV — POPCAT | tgm/historical-token-ohlcv | same window | `ad02121ea0e6454cfc3b4c14d451d91b` | 5 | `b8265601119856c8...` |

Total: **6 billed calls, 30 credits**, plus 1 free `422` validation rejection during field-name discovery (correctly not charged). Starting balance ~88 credits (free-tier + campaign bonus), ending balance 48 after this validation session — confirmed via `X-Nansen-Credits-Remaining` response headers throughout, not estimated.

Raw response bodies for these calls are retained locally (outside the repo, in the session scratch directory) as evidence; they are not committed. Only derived values, hashes and provenance metadata appear in this document and in the round fixture under `data/verified-rounds/`, consistent with the redistribution guide's "Allowed with attribution" status for both source endpoints.

---

## 7. Rate limits observed

From response headers on a successful call:

- `x-ratelimit-limit-second: 150`, `x-ratelimit-limit-minute: 3000`
- `x-ratelimit-limit: 15` (endpoint-scoped window, exact scope unconfirmed — treat as the binding constraint for burst calls to this endpoint)
- `x-ratelimit-limit-credit-fails-minute: 10` — repeated *failed* (rejected) requests are separately rate-limited, distinct from the main quota
- `x-nansen-plan-notice`: "Free tier gets 10 free credits every day. Resets at midnight UTC. Buy more credits at: https://app.nansen.ai/api" — this account's actual balance (88 at session start) exceeds the stated daily free amount, consistent with the buildathon's Points-hub bonus credits; daily reset behavior not yet observed across a UTC boundary.

## 8. Limitations and unresolved assumptions

- **Daily credit reset behavior is unconfirmed** — we have not observed a UTC midnight rollover in this session. Round generation logic should not assume unlimited same-day credits; the internal usage tracker (§`api_call_log`) must surface remaining balance so generation can fail closed before a request would be rejected for insufficient credits.
- **`market_cap_usd` fallback-to-FDV behavior** (flagged as a risk in PRD §11) was not specifically triggered or tested in this round — all 3 selected tokens had populated `market_cap_usd`. This should be tested with a token known to lack circulating-supply data before relying on market-cap comparability more broadly.
- **Candle-gap fallback behavior** (PRD §12's "within one interval of target" tolerance) was not exercised — both boundary candles in this round closed exactly on target. A round with a real gap has not yet been tested; the invalidation path (mark round INVALID rather than interpolate) is implemented per PRD but not yet proven against a genuine gap.
- **`sectors_filter` (include-list) and Smart Money trader-type filters** on the historical screener are documented but not exercised — not needed for the adopted clue design.
- **Historical screener "reconstructed at request time" caveat** (PRD §9): the docs state results "may change after late data, pricing fixes, label-history corrections." For a cutoff 35 days in the past (as used here), this risk is low but not zero. Frozen Replay rounds must store the raw response hash (done — see §6) so any future correction is detectable by re-fetching and comparing hashes, not silently trusted.
- **Beta status**: `historical-token-ohlcv` is explicitly marked "Beta — subject to breaking changes" in its own documentation. The Nansen client wrapper must isolate this endpoint's response parsing so a breaking change fails a single call with a clear error rather than corrupting round generation silently.
- **Live-mode endpoints** (current screener/flow for prospective snapshots) have not yet been validated in this session — that is a separate gate item before Live round generation is implemented (PRD §9, "current screener/flow sources").
- **Who Bought/Sold endpoint** was not tested; not currently a dependency.
- **Observed thin-trading case (YZY, slot B in the validation round):** despite $6.3M liquidity and an $87.9M market cap, this token's 1-day window showed only ~$2,244 total volume (buy $688 / sell $1,556) — a turnover ratio near 0.00035. This is a real, non-zero value (not missing data), so it passed validation and produced a legitimate "sell-heavy" / "steady" clue reading. It is flagged here because it shows liquidity depth and trading activity can diverge sharply for a real token on a real day; the eligibility policy currently filters on liquidity and market cap but not on a minimum activity/volume floor. A future round-forge version should consider adding `filters.volume_usd.min` to the eligibility policy if very-thin-volume days prove to make the buy/sell-balance and acceleration clues too noisy to be useful signals — this is a game-design judgment call, not a data-availability problem.

## 9. Environment / credential handling used during this gate

`NANSEN_API_KEY` was read directly from `.env.local` (gitignored, never committed) by short-lived Node scripts executed from the session's scratch directory. The key was never printed to any log file, committed artifact, or this document. All evidence above (request IDs, hashes, credit counters) was captured from HTTP response headers/bodies, not from the request itself.
