/**
 * Generates historical Replay rounds from real Nansen data (Round Forge v4). New rounds are
 * stored as pending review and become playable only after an eligibility review
 * (src/lib/services/replayForge.ts).
 *
 * Without --confirm this is a dry run: it prints the planned cutoffs, the call and
 * credit caps and the expected output, and makes zero Nansen requests (fetch is
 * disabled for the whole dry run, so that is enforced, not promised).
 *
 * Usage:
 *   npm run generate:replay -- --count 15                                   # plan only
 *   npm run generate:replay -- --count 15 --confirm                         # spend, within default caps
 *   npm run generate:replay -- --count 15 --confirm --max-calls 80 --max-credits 400
 *   (dates already attempted — even rejected ones — are skipped; --retry-attempted includes them)
 *
 * With --confirm, every Nansen attempt is written to api_call_log before the next one.
 * The run stops at the first authentication, credit, rate-limit, server, budget or
 * audit-log failure, and whenever the next round could exceed a cap. A round is stored
 * with its assets and one source receipt per response in a single transaction, or not
 * at all; a failure to store it stops the run.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
// Real runs keep every raw Nansen response as private, gitignored evidence (src/lib/nansen/client.ts).
if (process.argv.includes('--confirm')) process.env.NANSEN_RAW_RESPONSE_DIR ??= `${process.cwd()}/.nansen-raw`;

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbSchema, getPool } from '../src/lib/db';
import { HISTORICAL_OHLCV_PATH, HISTORICAL_SCREENER_PATH } from '../src/lib/nansen/client';
import { recordNansenAttempt } from '../src/lib/repo/apiCallLog';
import { listAttemptedGenerationDates, listCatalog, persistGeneratedReplayRound } from '../src/lib/repo/replayCatalog';
import {
  forgeReplayRound,
  isFatalForgeError,
  PLANNED_CREDITS_PER_CALL,
  planReplayGeneration,
  policyForCutoff,
  REPLAY_FORGE_VERSION,
  REPLAY_ROUND_MAX_CALLS,
  ReplayForgeRejection,
} from '../src/lib/services/replayForge';

const DAY_MS = 24 * 60 * 60 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function intArg(name: string): number | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer (got "${raw}")`);
  return n;
}

const usd = (n: number) => (n >= 1e9 ? `$${n / 1e9}B` : `$${n / 1e6}M`);

async function main() {
  const confirm = process.argv.includes('--confirm');
  if (!confirm) {
    // The dry run cannot reach Nansen: fetch is disabled outright (the database uses its own sockets).
    globalThis.fetch = (() => Promise.reject(new Error('Dry run: network requests are disabled'))) as typeof fetch;
  }

  const count = intArg('count') ?? 15;
  const catalog = await listCatalog();
  const attempted = process.argv.includes('--retry-attempted') ? [] : await listAttemptedGenerationDates();
  const plan = planReplayGeneration({
    count,
    now: new Date(),
    existingCutoffs: [...catalog.map((c) => c.cutoff), ...attempted],
    maxCalls: intArg('max-calls'),
    maxCredits: intArg('max-credits'),
  });

  console.log(`Replay generation plan — Round Forge v${REPLAY_FORGE_VERSION}`);
  console.log(`  database schema:     ${dbSchema() ?? 'public'}`);
  console.log(`  existing catalog:    ${catalog.length} stored round(s), approved or withdrawn (all count for token reuse and near-duplicates)`);
  console.log(`  already attempted:   ${attempted.length ? attempted.sort().join(', ') : 'none'} (skipped)`);
  console.log(`  rounds requested:    ${count}`);
  console.log(`  per round:           2 × POST ${HISTORICAL_SCREENER_PATH} (7d, 1d)`);
  console.log(`                       3 × POST ${HISTORICAL_OHLCV_PATH} (1h, one per slot)`);
  console.log(`                       ${plan.requiredCallsPerRound} requests needed, at most ${plan.maxCallsPerRound} with retries`);
  console.log(`  expected:            ${plan.expectedCalls} requests, ~${plan.expectedCredits} credits`);
  console.log(`  cap — requests:      ${plan.maxCalls}`);
  console.log(`  cap — credits:       ${plan.maxCredits} (planned at ${PLANNED_CREDITS_PER_CALL} per request)`);
  console.log('  planned cutoffs (00:00 UTC, 7-day horizon):');
  for (const c of plan.cutoffs) {
    console.log(
      `    ${c.cutoff.slice(0, 10)} → ${c.resolution.slice(0, 10)}   market cap ${usd(c.band[0])}–${usd(c.band[1])}`,
    );
  }
  console.log(
    `  expected output:     up to ${count} new rounds (mode=replay, status=ready), each with 3 assets and 5 source receipts`,
  );
  console.log(`  NANSEN_API_KEY set:  ${process.env.NANSEN_API_KEY ? 'yes' : 'NO'}`);

  if (!confirm) {
    console.log('\nDry run: zero Nansen requests made. Re-run with --confirm to spend within the caps above.');
    return;
  }
  if (!process.env.NANSEN_API_KEY) throw new Error('NANSEN_API_KEY is not set; refusing to start.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = join(process.cwd(), 'artifacts', 'replay-generation');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${stamp}.json`);
  const report = {
    startedAt: new Date().toISOString(),
    schema: dbSchema() ?? 'public',
    caps: { maxCalls: plan.maxCalls, maxCredits: plan.maxCredits },
    rounds: [] as unknown[],
    stoppedReason: null as string | null,
    totals: { requests: 0, credits: 0, created: 0 },
  };
  const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const used: Array<{ cutoff: string; tokenAddresses: string[] }> = [...catalog];
  let consecutiveInsufficient = 0;

  for (const planned of plan.cutoffs) {
    const worstCaseCredits = REPLAY_ROUND_MAX_CALLS * PLANNED_CREDITS_PER_CALL;
    if (report.totals.requests + REPLAY_ROUND_MAX_CALLS > plan.maxCalls) {
      report.stoppedReason = `next round could exceed the request cap (${report.totals.requests}/${plan.maxCalls} used)`;
      break;
    }
    if (report.totals.credits + worstCaseCredits > plan.maxCredits) {
      report.stoppedReason = `next round could exceed the credit cap (${report.totals.credits}/${plan.maxCredits} used)`;
      break;
    }

    const cutoff = new Date(planned.cutoff);
    const policy = policyForCutoff(cutoff);
    const excluded = new Set(
      used
        .filter((u) => Math.abs(Date.parse(u.cutoff) - cutoff.getTime()) <= policy.reuse_window_days * DAY_MS)
        .flatMap((u) => u.tokenAddresses),
    );

    process.stdout.write(`\n${planned.cutoff.slice(0, 10)}: `);
    try {
      const generated = await forgeReplayRound({
        cutoff,
        excludedAddresses: excluded,
        catalogSets: used.map((u) => u.tokenAddresses),
        recorder: recordNansenAttempt,
      });
      const n = generated.nansen;
      report.totals.requests += n.networkCalls;
      report.totals.credits += n.creditsUsed > 0 ? n.creditsUsed : n.networkCalls * PLANNED_CREDITS_PER_CALL;

      const stored = await persistGeneratedReplayRound(generated);
      used.push({ cutoff: generated.round.cutoff, tokenAddresses: generated.round.assets.map((a) => a.token_address) });
      report.totals.created += 1;
      consecutiveInsufficient = 0;
      report.rounds.push({
        cutoff: planned.cutoff,
        outcome: 'created',
        roundId: stored.roundId,
        commitmentHash: stored.commitmentHash,
        tokens: generated.round.assets.map((a) => `${a.slot}:${a.token_symbol}`),
        winner: generated.round.winner_slot,
        nansen: n,
        receipts: generated.receipts,
      });
      console.log(
        `created ${stored.roundId} (${generated.round.assets.map((a) => a.token_symbol).join(' / ')}), ${n.networkCalls} requests`,
      );
      if (n.lastCreditsRemaining !== null && n.lastCreditsRemaining < worstCaseCredits) {
        report.stoppedReason = `credit balance ${n.lastCreditsRemaining} is below one more round`;
        save();
        break;
      }
    } catch (err) {
      const n = (err as { nansen?: { networkCalls: number; creditsUsed: number } }).nansen;
      if (n) {
        report.totals.requests += n.networkCalls;
        report.totals.credits += n.creditsUsed > 0 ? n.creditsUsed : n.networkCalls * PLANNED_CREDITS_PER_CALL;
      }
      const message = err instanceof Error ? err.message : String(err);
      report.rounds.push({ cutoff: planned.cutoff, outcome: 'rejected', reason: message, nansen: n ?? null });
      console.log(`not created — ${message}`);
      if (isFatalForgeError(err)) {
        report.stoppedReason = `stopped on: ${message}`;
        save();
        break;
      }
      if (err instanceof ReplayForgeRejection && err.reason === 'insufficient_candidates') {
        consecutiveInsufficient += 1;
        if (consecutiveInsufficient >= 2) {
          report.stoppedReason = 'two consecutive cutoffs had too few eligible tokens; stopping instead of spending further';
          save();
          break;
        }
      }
    }
    save();
  }

  save();
  console.log(`\nCreated ${report.totals.created} of ${count} round(s).`);
  console.log(`Requests: ${report.totals.requests} (cap ${plan.maxCalls}); credits: ~${report.totals.credits} (cap ${plan.maxCredits}).`);
  if (report.stoppedReason) console.log(`Stopped: ${report.stoppedReason}`);
  console.log(`Report: ${reportPath}`);
  console.log('Next: npm run verify');
  if (report.totals.created < count) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
