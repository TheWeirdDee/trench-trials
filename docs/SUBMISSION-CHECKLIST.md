# Submission checklist

Every item must be true and evidenced before submitting. Status as of 2026-09-27, after the Round Forge v4 run and catalog publication ([NANSEN-CONTRACT-AUDIT.md](NANSEN-CONTRACT-AUDIT.md), Phase 11). Nothing is submitted, deployed or committed without explicit authorization.

## Product

| Item | Status | Evidence |
| --- | --- | --- |
| Blind Pick → Unmask → Verdict on real data | Done | Six leak-free, approved Replay rounds: two offline rebuilds (`c5e34c58…`, `d2ecc59b…`) and four Round Forge v4 rounds (`67d694e4…`, `d06b6bc2…`, `15b4670e…`, `50e1edc8…`), verified by `npm run verify:rebuilt` (3,936 checks, 0 failures); e2e `replay.spec.ts` |
| No leaking or ineligible round playable | Done | All 16 original rounds withdrawn (evidence preserved). Candidate `c0f61751…` not published (`catalog_quality_repeat_winner`; recorded as withdrawn with that reason, data kept). `npm run verify` fails if any pre-v4 round is approved. |
| Genuine Daily assigned | Done for 2026-09-26, 2026-09-27 and 2026-09-28 | `c5e34c58…` (reassigned from the withdrawn `c3a06918…` with an audit record), `d2ecc59b…`, then `67d694e4…` (scheduled in the same transaction that approved it). Replay holds 4 rounds on 09-27 and 5 on 09-28. |
| Fresh clone playable without a Nansen key | Done | `npm run setup:demo -- --confirm` imports all six verified bundles; measured 2 min 52 s from a clean copy to a serving app with 6 playable rounds |
| Public evidence | Done | `/evidence`: request IDs, response hashes, commitments and live checks for every playable round |
| Live | Withheld, honestly | `5a76f497…` failed the eligibility policy; marked invalid, never resolved. `/live` shows no playable round. |
| No invalid round presented as success | Done | Invalid rounds are readable only as void records and can never be played |

## Qualification

| Item | Status |
| --- | --- |
| ≥ 100 successful Nansen calls, 14–27 September | Expected **137** now (21 + 116), pending dashboard confirmation. The 116 include 2 billing-only calls with no saved body. |
| Nansen dashboard screenshot | **To capture.** Record the total in [API-USAGE-EVIDENCE.md](API-USAGE-EVIDENCE.md). |
| `api_call_log` reconciled with receipts | Done: 116 requests, 572 credits (balance 448); 102 requests matched to receipts by request ID, 14 receipt-less calls explained; every receipt of the six playable rounds matches a logged call (`npm run verify`) |

## Engineering

| Item | Status |
| --- | --- |
| Typecheck, unit, integration, Playwright (one run on one build), verify, verify:rebuilt | Passed 2026-09-27 on the publication tree: typecheck, 337 unit/integration tests, production build, 49 Playwright tests, 324 verification checks and 3,936 rebuilt-round checks; zero failures. |
| Links and secrets | 45 links checked, zero failures. Working tree, index and all 237 existing commits scanned: zero secret matches; no demo media or Remotion files eligible for commit. |
| Accessibility | axe (WCAG 2.2 AA + best practices): 0 violations on every major page and state. Keyboard-only journey, heading order and reduced motion are tested. |
| Lighthouse (production build) | Landing, mobile preset: performance ~70, accessibility 100, best practices 100, SEO 100 |
| Production screenshots at 5 viewports | Generated locally by Playwright into `artifacts/screenshots/` (not committed) |

## Deployment

- [x] Production migrations applied through `1790267000000_round_lineage` (8 of 8)
- [x] Vercel production at https://trench-trials.vercel.app: `DATABASE_URL` (transaction pooler), `DB_POOL_MAX`, `SESSION_SECRET`, `CRON_SECRET`; no `NANSEN_API_KEY`
- [ ] Post-deploy smoke test of the latest commit: health, 401 on `/api/internal/*`, security headers, no `Server-Timing`, Replay, Daily, History, Docs and Evidence

## Submission package

- [ ] Public GitHub repository, with no secrets, raw Nansen bodies or local screenshots
- [ ] 30–60 second recording: problem → Blind Pick → lock → Unmask → keep or switch → real Verdict → Ticker Tax → verification panel → the Daily
- [ ] X post tagging `@nansen_ai`
- [ ] Submission form: public URL, repository, X link, email
- [ ] Nansen dashboard total confirmed (expected 137) before claiming it
