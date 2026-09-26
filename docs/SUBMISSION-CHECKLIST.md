# Submission checklist

Every item must be true and evidenced before submitting. Status as of 2026-09-26, after the contract-and-data audit ([NANSEN-CONTRACT-AUDIT.md](NANSEN-CONTRACT-AUDIT.md)). Nothing is submitted, deployed or committed without explicit authorization.

## Product

| Item | Status | Evidence |
| --- | --- | --- |
| Blind Pick → Unmask → Verdict on real data | Done | Two leak-free, approved Replay rounds, `c5e34c58…` and `d2ecc59b…`, verified by `npm run verify:rebuilt` (0 failures); e2e `replay.spec.ts` |
| No leaking or ineligible round playable | Done | All 16 stored rounds withdrawn (evidence preserved). `npm run verify` fails if any pre-v4 round is approved. |
| Genuine Daily assigned | Done for 2026-09-26 | `c5e34c58…`, reassigned from the withdrawn `c3a06918…` with an audit record, before any attempt |
| Live | Withheld, honestly | `5a76f497…` failed the eligibility policy; marked invalid, never resolved. `/live` shows no playable round. |
| No invalid round presented as success | Done | Invalid rounds are readable only as void records and can never be played |

## Qualification

| Item | Status |
| --- | --- |
| ≥ 100 successful Nansen calls, 14–27 September | Expected **106** now (21 + 85). Confirm on the dashboard. The 85 include 2 billing-only calls with no saved body. |
| Nansen dashboard screenshot | **To capture.** Record the total in [API-USAGE-EVIDENCE.md](API-USAGE-EVIDENCE.md). |
| `api_call_log` reconciled with receipts | Done: 85 requests, 417 credits, 77 receipts matched by request ID, 8 receipt-less calls explained |

## Engineering

| Item | Status |
| --- | --- |
| Typecheck, unit, integration, Playwright (one run on one build), verify, verify:rebuilt | Final gate, run on the committed tree |
| Accessibility | axe (WCAG 2.2 AA + best practices): 0 violations on every major page and state. Keyboard-only journey, heading order and reduced motion are tested. |
| Lighthouse (production build) | Landing, mobile preset: performance ~70, accessibility 100, best practices 100, SEO 100 |
| Production screenshots at 5 viewports | Generated locally by Playwright into `artifacts/screenshots/` (not committed) |

## Deployment

- [x] Production migrations applied through `1790267000000_round_lineage` (8 of 8)
- [ ] Vercel production: `DATABASE_URL` (transaction pooler), `DB_POOL_MAX`, `SESSION_SECRET`, `CRON_SECRET`; no `NANSEN_API_KEY`
- [ ] `/api/health` returns ok; `/api/internal/*` returns 401 without the secret; security headers present; no `Server-Timing`
- [ ] Desktop and mobile paths checked on the public URL

## Submission package

- [ ] Public GitHub repository, with no secrets, raw Nansen bodies or local screenshots
- [ ] 30–60 second recording: problem → Blind Pick → lock → Unmask → keep or switch → real Verdict → Ticker Tax → verification panel → the Daily
- [ ] X post tagging `@nansen_ai`
- [ ] Submission form: public URL, repository, X link, email
- [ ] Nansen dashboard total confirmed (expected 106) before claiming it
