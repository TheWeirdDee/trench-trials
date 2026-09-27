# Daily — real-data runbook

Updated 2026-09-26. This runbook covers making a verified round the Daily for a UTC date. Assigning is deliberate and permanent, and nothing here runs automatically.

**Current state**

- **2026-09-26 → `c5e34c58-24aa-4c91-87ef-e063247eb613`** (FARTCOIN / DBR / $WIF, cutoff 2026-08-15). This is the leak-free rebuild of `2cd1219b`, approved under eligibility policy v2.
  - It was first assigned to `c3a06918-…` (ZEREBRO / PIPPIN / FO) at 16:49:36 UTC. The eligibility audit withdrew that round (F1 leakage; FO unclassified, with a −47% one-hour move).
  - Reassigned at 21:53:58 UTC with `npm run reassign:daily` after confirming 0 attempts. The row keeps `prior_round_id = c3a06918-…`, `replaced_at` and `replacement_reason`.
- **2026-09-27 → `d2ecc59b-cefd-46d6-90c0-966720441afe`** (PNUT / JELLYJELLY / MEW, cutoff 2026-08-25), assigned 2026-09-26 23:58:20 UTC with `npm run assign:daily -- --round d2ecc59b-… --date 2026-09-27 --confirm`, before rollover. After rollover a fresh guest receives `d2ecc59b` as the Daily and `c5e34c58` as Replay.
- No later date is assigned yet. Daily disappears from navigation at 2026-09-28 00:00 UTC unless another approved round is assigned.
- Only a round approved under the current eligibility policy can be assigned (`round_not_approved` otherwise).
- round-001 (`be497aab…`) must **not** be used as the Daily: that is a standing product decision.
- Assigning makes **zero Nansen calls**.

**Two ways to assign.** Both call the same `assignDailyRound` checks:
- `npm run assign:daily -- --round <uuid> [--date YYYY-MM-DD]`: a dry run, then add `--confirm`. It refuses past dates.
- `POST /api/internal/daily/assign` (§3). This needs `CRON_SECRET` to be configured.

## 1. The model

A Daily is a pointer from a UTC date to one **canonical** verified round. Nothing is copied or cloned.

- The same round, the same A/B/C order and the same commitment for everyone that date.
- One attempt per player per round (a database constraint). A player who meets the round in Replay later sees the same attempt, never a second first-time score.
- While its date is today or later, the round is excluded from Replay discovery (`pickNextReplayRound`). Once the date has passed, it can appear in Replay for players who have not played it.
- An attempt started on the round's Daily date is labelled **Daily** in History, and counts toward the **Daily streak**: consecutive assigned Daily dates the player completed on the day.

## 2. Eligibility

`assignDailyRound` (`src/lib/repo/rounds.ts`) enforces these checks, in order:

| Check | Error | HTTP |
| --- | --- | --- |
| Round exists | `round_not_found` | 404 |
| `status` is `ready` or `resolved` | `round_not_resolved` | 409 |
| Not a Live round | `round_is_live` | 409 |
| Canonical: `repeat_of` is null | `round_is_repeat` | 409 |
| Has at least 1 `source_receipts` row | `round_sourceless` | 409 |
| Never assigned as a Daily before | `round_already_daily` | 409 |
| No row yet for that `utc_date` | `date_already_assigned` | 409 |

The reuse check and the insert run in one transaction, under an advisory lock.

Also check by hand before assigning:
- `npm run verify` passes;
- the round's outcome window is entirely in the past;
- it is not round-001.

## 3. Assignment API

`POST /api/internal/daily/assign`, authenticated with `x-internal-secret: <CRON_SECRET>` (or `Authorization: Bearer <CRON_SECRET>`, compared in constant time).

```bash
curl -X POST "$APP_URL/api/internal/daily/assign" \
  -H "content-type: application/json" \
  -H "x-internal-secret: $CRON_SECRET" \
  -d '{"utcDate":"YYYY-MM-DD","roundId":"<canonical round uuid>"}'
```

| Response | Meaning |
| --- | --- |
| `200 {"ok":true,"utcDate","roundId"}` | Assigned |
| `400 invalid_request` | Bad date or UUID |
| `401 unauthorized` | Wrong or missing secret, or `CRON_SECRET` unset (fails closed) |
| `404` / `409 <error>` | See §2 |

## 4. Permanence and numbering

- `utc_date` is the primary key. There is no update or delete API.
- **Assign in chronological order, and never backfill a past date.** `dailyNumber` is the count of assigned dates up to and including that date.

## 5. UTC semantics

- The Daily for date D is served from `D 00:00:00Z` until `D+1 00:00:00Z`, by the database clock.
- `/daily` renders the round server-side. With no row for today, it shows an honest "No Daily today" page and no substitute round.

## 6. Share card

Only a completed Daily shows the share card. The text says:
- whether the pick was correct;
- how the decision changed (kept, changed after the reveal, or time ran out);
- the Ticker Tax contribution (omitted for a timeout);
- the Daily streak and the `/daily` link.

It **never** contains a token, address, slot letter, price or per-token return, so it cannot spoil the Daily for anyone else (`tests/unit/dailyShare.test.ts`).

## 7. Tests and a real Daily

The test suites run only in the isolated `tt_test` schema, so a real Daily in production can neither make them fail nor be touched by them. `tests/integration/dailyAssignmentSurvival.test.ts` proves this. It runs the full Daily suite beside a stand-in "production" Daily and checks that the row was never read, changed or deleted. `npm test` and `npx playwright test` are safe on any date.

## 8. Order of operations

1. Generate the catalog (authorized spending), then run `npm run verify`.
2. Pick a canonical round from the catalog, not round-001, and today's UTC date or a future one.
3. `npx tsx scripts/db-status.ts`: confirm there is no row for that date.
4. Assign (§3) and expect `200`.
5. In a fresh browser profile, open `/daily`:
   - Daily appears in the navigation;
   - the blind stage shows no identities;
   - after the final lock, the verdict and share card appear, and History labels the play as Daily.
6. Save the response, the `daily_challenges` row and screenshots to `artifacts/daily-real/`.
