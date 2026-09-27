# Nansen API usage evidence

What the product has requested from Nansen, and how the three records reconcile. The figures come from the production database (read-only queries, 2026-09-26 17:00 UTC), the response headers Nansen returned, and the dashboard figures you reported. Nothing is estimated.

## Summary

| Measure | Value | Source |
| --- | --- | --- |
| Qualifying requirement | 100 real API calls | Nansen’s updated hackathon requirement |
| Dashboard baseline before this session | 21 successful calls, 1,010 credits | Nansen dashboard, as reported by the owner before spending |
| Real requests on 2026-09-26 | **85**: all HTTP 200, 0 failures, 0 retries, 0 cache hits | `api_call_log` |
| Credits used on 2026-09-26 | **417** | `api_call_log.credits_used`, from the `x-nansen-credits-used` header |
| Balance after the last request | **593** (1,010 − 417 ✓) | `x-nansen-credits-remaining` on the last response |
| Expected dashboard total | **106** successful calls (21 + 85), pending dashboard confirmation | derived; the dashboard is the final authority |
| Calls made since | **0**: the leak-free rebuilds, bundles and Daily assignments used only preserved responses | `api_call_log` still holds 85 rows |
| Authorized ceiling | 90 attempts / 450 credits | Live 7 / 35 plus catalog 83 / 415 |
| Used against the ceiling | 85 attempts / 417 credits. No further spending is authorized. | |

## Requests by operation

| Operation (`purpose`) | Requests | Credits | Result |
| --- | --- | --- | --- |
| `live_create`, attempt 1, 16:34 UTC | 2 × historical screener | 10 | Selected 0 tokens: the historical screener has no usable rows for today's date. No round stored. |
| `live_create`, attempt 2, 16:47 UTC | 2 × current screener (`/api/v1/token-screener`) | 2 | Live round `5a76f497…` created |
| `replay_generate:<date>`, run 1, 16:37–16:39 UTC | 71 (2 screener + 3 OHLCV per round) | 355 | 13 rounds created. 2 dates rejected: 2026-09-03 (missing boundary candle for AMAN, 4 calls) and 2026-08-30 (2 eligible tokens, 2 calls). |
| `replay_generate:<date>`, run 2, 16:53 UTC | 10 | 50 | 2 rounds created (Round Forge v3) |
| **Total** | **85** | **417** | |

## Reconciliation: `api_call_log` ↔ `source_receipts`

- Every source receipt with a request ID (77) matches a successful `api_call_log` row with the same Nansen request ID:
  - 15 generated rounds × 5 = 75;
  - the Live round × 2 = 2.
- 8 successful requests have no receipt, because they produced no round. These are exactly the 2 zero-candidate Live creates, the 4 calls for 2026-09-03 and the 2 for 2026-08-30. They are legitimate, logged and paid for.
- Credits: 377 on receipts + 40 on the 8 receipt-less calls = 417, equal to the log total.
- `source_receipts` holds 88 rows in total: the 77 above, plus round-001's 9 per-asset rows and the invalid Live round's 2. Those 11 older rows predate request-ID recording.
- Raw response bodies are kept privately in `.nansen-raw/`: gitignored, never served, each with its request body, status, request ID and SHA-256. There are 83 of the 85. The first Live attempt's 2 responses came before raw capture was added, so they exist only as `api_call_log` rows (request IDs `35d99427…` and `820f0a04…`). They produced no round. They are **billing evidence only, not product evidence**.

**Open item:** compare the dashboard's request history for 2026-09-26 with the 85 request IDs in `api_call_log`, and record the dashboard total and a screenshot here. The expected figure is 106.

## Earlier calls (before 2026-09-26)

The 21 dashboard calls from before today are **not** in `api_call_log`; the table was empty in production until today. Their evidence is:
- the dashboard;
- the request IDs and hashes in [DATA-CONTRACT.md §6](../DATA-CONTRACT.md);
- round-001's and `df397565…`'s receipts.

## Still to spend

Nothing is authorized. The 2026-09-26 audit ([NANSEN-CONTRACT-AUDIT.md](NANSEN-CONTRACT-AUDIT.md)) classified Live `5a76f497…` as QUALITY INVALID. It is **not** to be resolved, which saves the 3 requests / 15 credits that were reserved. A replacement Live round would need a new authorization: at most 7 attempts / 23 credits. The recommended catalog re-cuts use saved raw responses and need **zero** calls.

## How to re-check at any time

0. Open the public [Evidence page](https://trench-trials.vercel.app/evidence): it reads these totals live from `api_call_log` and lists each playable round’s request IDs and response hashes.
1. Call `GET /api/internal/usage` with `x-internal-secret: $CRON_SECRET`. This needs `CRON_SECRET` to be set.
2. Or run the read-only queries this document's figures came from: `api_call_log` grouped by `purpose`, and `source_receipts` joined to `api_call_log` on `request_id`.
3. Run `npm run verify`, which recomputes every commitment and return.
