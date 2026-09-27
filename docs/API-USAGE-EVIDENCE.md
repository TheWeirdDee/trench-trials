# Nansen API usage evidence

What the product has requested from Nansen, and how the three records reconcile. The figures come from the production database (read-only queries, 2026-09-27 08:00 UTC), the response headers Nansen returned, and the dashboard figures you reported. Nothing is estimated.

## Summary

| Measure | Value | Source |
| --- | --- | --- |
| Qualifying requirement | 100 real API calls | Nansen’s updated hackathon requirement |
| Dashboard baseline before logging | 21 successful calls, 1,010 credits | Nansen dashboard, as reported by the owner before spending |
| Requests logged by the application | **116**: 85 on 2026-09-26 and 31 on 2026-09-27. All HTTP 200, 0 failures, 0 retries, 0 cache hits, 116 distinct request IDs | `api_call_log` |
| Credits logged | **572**: 417 on 2026-09-26 and 155 on 2026-09-27 | `api_call_log.credits_used`, from the `x-nansen-credits-used` header |
| Balance after the last request | **448** | `x-nansen-credits-remaining` on the last response (2026-09-27 05:11 UTC) |
| Expected dashboard total | **137** successful calls (21 + 116), **pending dashboard confirmation** | derived; the dashboard is the final authority |
| Authorized ceilings | 2026-09-26: 90 attempts / 450 credits. 2026-09-27 Round Forge v4: 56 attempts / 280 credits | owner authorizations |
| Used against them | 85 / 417 and 31 / 155. No further spending is authorized. | `api_call_log` |

**Balance check.** 1,010 − 417 = 593 matches the last header on 2026-09-26. The first response on 2026-09-27 reported 598 after a 5-credit call, so the balance was 603 before that run: 10 credits higher than the last logged figure, from a change on Nansen’s side that no logged call explains. From 603, the 155 logged credits give 448, matching the last header exactly.

## Requests by operation

| Operation (`purpose`) | Requests | Credits | Result |
| --- | --- | --- | --- |
| `live_create`, attempt 1, 2026-09-26 16:34 UTC | 2 × historical screener | 10 | Selected 0 tokens: the historical screener has no usable rows for today's date. No round stored. |
| `live_create`, attempt 2, 2026-09-26 16:47 UTC | 2 × current screener (`/api/v1/token-screener`) | 2 | Live round `5a76f497…` created (later marked invalid) |
| `replay_generate:<date>`, run 1, 2026-09-26 16:37–16:39 UTC | 71 (2 screener + 3 OHLCV per round) | 355 | 13 rounds created (all later withdrawn). 2 dates rejected: 2026-09-03 (missing boundary candle, 4 calls) and 2026-08-30 (2 eligible tokens, 2 calls). |
| `replay_generate:<date>`, run 2, 2026-09-26 16:53 UTC | 10 | 50 | 2 rounds created (Round Forge v3; withdrawn, then rebuilt offline) |
| `replay_generate:<date>`, Round Forge v4 run 1, 2026-09-27 05:04 UTC | 9 | 45 | 1 candidate created (`c0f61751…`, not published: `catalog_quality_repeat_winner`). 2 dates rejected at selection (2 screener calls each). |
| `replay_generate:<date>`, Round Forge v4 run 2, 2026-09-27 05:10 UTC | 22 | 110 | 4 candidates created, all approved and playable. 1 date rejected at selection (2 calls). |
| **Total** | **116** | **572** | |

## Reconciliation: `api_call_log` ↔ `source_receipts`

- 102 logged requests have a source receipt with the same Nansen request ID (502 credits):
  - 15 rounds from 2026-09-26 × 5 = 75;
  - the Live round × 2 = 2;
  - 5 Round Forge v4 rounds × 5 = 25.
- 14 successful requests have no receipt, because they produced no round (70 credits): the 2 zero-candidate Live creates, the 4 calls for 2026-09-03, the 2 for 2026-08-30, and the 6 selection-stage screener calls for the 3 dates rejected on 2026-09-27. They are legitimate, logged and paid for.
- Credits: 502 on receipts + 70 without = 572, equal to the log total.
- The two playable rebuilds (`c5e34c58…`, `d2ecc59b…`) reuse the receipts of the responses they were rebuilt from, so they add receipt rows but no requests. Every receipt of every playable round matches a successful logged call with the same credits; `npm run verify` checks this on each run (30 of 30).
- `source_receipts` holds 123 rows: the 112 that carry a logged request ID, plus round-001's 9 per-asset rows and the invalid Live round `df397565…`'s 2, which predate request-ID recording.
- Raw response bodies are kept privately in `.nansen-raw/`: gitignored, never served, each with its request body, status, request ID and SHA-256. There are 114 of the 116. The first Live attempt's 2 responses came before raw capture was added, so they exist only as `api_call_log` rows (request IDs `35d99427…` and `820f0a04…`). They produced no round. They are **billing evidence only, not product evidence**.

**Open item:** compare the dashboard's request history for 2026-09-26 and 2026-09-27 with the 116 request IDs in `api_call_log`, and record the dashboard total and a screenshot here. The expected figure is 137. Until then it is not described as confirmed.

## Earlier calls (before 2026-09-26)

The 21 dashboard calls from before 2026-09-26 are **not** in `api_call_log`; the table was empty in production until then. Their evidence is:
- the dashboard;
- the request IDs and hashes in [DATA-CONTRACT.md §6](../DATA-CONTRACT.md);
- round-001's and `df397565…`'s receipts.

## Still to spend

Nothing is authorized. Live `5a76f497…` is QUALITY INVALID ([NANSEN-CONTRACT-AUDIT.md](NANSEN-CONTRACT-AUDIT.md)) and is **not** to be resolved. A replacement Live round, or more Replay rounds, would need a new, capped authorization.

## How to re-check at any time

0. Open the public [Evidence page](https://trench-trials.vercel.app/evidence): it reads these totals live from `api_call_log` (logged requests, credits, balance, and the expected total as 21 + successful logged calls) and lists each playable round’s request IDs and response hashes.
1. Call `GET /api/internal/usage` with `x-internal-secret: $CRON_SECRET`. This needs `CRON_SECRET` to be set.
2. Or run the read-only queries this document's figures came from: `api_call_log` grouped by `purpose`, and `source_receipts` joined to `api_call_log` on `request_id`.
3. Run `npm run verify`, which recomputes every commitment and return and reconciles every playable round’s receipts with the call log.
