import type { PoolClient } from 'pg';
import { withTransaction } from '../db';
import { playerFacingSql } from '../domain/eligibility';
import { REPLAY_FORGE_VERSION } from '../services/replayForge';
import { setRoundEligibility } from './eligibility';

/**
 * Publishes reviewed Round Forge candidates and schedules a Daily in ONE transaction, and
 * only from an exactly expected catalog state. Approvals, rejections and the Daily row
 * commit together or not at all; any difference from the reviewed state (another round
 * became player-facing, a candidate was already decided, the date already has a Daily,
 * an existing Daily moved) refuses the whole plan before anything is written.
 *
 * A rejected candidate is recorded with the `withdrawn` eligibility status and the review
 * reason as its note (e.g. `catalog_quality_repeat_winner`): a reversible label only, so the
 * round, its receipts, raw-response provenance and commitment are kept. Attempts, players
 * and existing Daily rows are never touched. Zero Nansen calls.
 */
export interface PublishDecision {
  round: string;
  note: string;
}

export interface PublishPlan {
  /** The catalog the reviewer saw: exactly these rounds are player-facing, and these Daily rows exist from today on. */
  expect: { approved: string[]; dailies: Record<string, string> };
  approve: PublishDecision[];
  reject: PublishDecision[];
  daily?: { date: string; round: string };
}

export interface PublishReport {
  today: string;
  playerFacing: string[];
  approved: string[];
  rejected: string[];
  daily: { utcDate: string; roundId: string } | null;
  untouched: Record<string, number>;
  written: boolean;
}

export class PublishRefused extends Error {
  constructor(readonly problems: string[]) {
    super(`Refused, nothing written:\n  - ${problems.join('\n  - ')}`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

interface CandidateRow {
  id: string;
  mode: string;
  status: string;
  eligibility_status: string;
  round_forge_version: number;
  player_facing: boolean;
  receipts: number;
  has_commitment: boolean;
  canonical: boolean;
  dailies: string[];
}

async function untouchedCounts(client: PoolClient): Promise<Record<string, number>> {
  const res = await client.query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM players) AS players,
            (SELECT count(*)::int FROM attempts) AS attempts,
            (SELECT count(*)::int FROM decision_events) AS decision_events,
            (SELECT count(*)::int FROM source_receipts) AS source_receipts,
            (SELECT count(*)::int FROM api_call_log) AS api_calls,
            (SELECT count(*)::int FROM rounds) AS rounds`,
  );
  return res.rows[0]!;
}

async function playerFacingIds(client: PoolClient): Promise<string[]> {
  const res = await client.query<{ id: string }>(`SELECT r.id FROM rounds r WHERE ${playerFacingSql('r')} ORDER BY r.id`);
  return res.rows.map((r) => r.id);
}

async function dailiesFrom(client: PoolClient, today: string): Promise<Record<string, string>> {
  const res = await client.query<{ utc_date: string; round_id: string }>(
    'SELECT utc_date::text, round_id FROM daily_challenges WHERE utc_date >= $1::date ORDER BY utc_date',
    [today],
  );
  return Object.fromEntries(res.rows.map((r) => [r.utc_date, r.round_id]));
}

function planProblems(plan: PublishPlan): string[] {
  const problems: string[] = [];
  const decided = [...plan.approve, ...plan.reject];
  const ids = [...plan.expect.approved, ...decided.map((d) => d.round)];
  for (const id of ids) if (!UUID.test(id)) problems.push(`${id} is not a full round id`);
  if (new Set(ids).size !== ids.length) problems.push('a round appears more than once in the plan');
  for (const d of decided) if (!d.note.trim()) problems.push(`${d.round} has no review note`);
  for (const [date, id] of Object.entries(plan.expect.dailies)) {
    if (!DATE.test(date) || !UUID.test(id)) problems.push(`expected Daily ${date} → ${id} is malformed`);
  }
  if (plan.daily) {
    if (!DATE.test(plan.daily.date)) problems.push(`Daily date ${plan.daily.date} is not YYYY-MM-DD`);
    const willBeFacing = [...plan.expect.approved, ...plan.approve.map((d) => d.round)];
    if (!willBeFacing.includes(plan.daily.round)) problems.push(`Daily round ${plan.daily.round} would not be player-facing`);
  }
  return problems;
}

async function stateProblems(client: PoolClient, plan: PublishPlan, today: string): Promise<string[]> {
  const problems: string[] = [];
  const decided = [...plan.approve, ...plan.reject].map((d) => d.round);
  const ids = [...plan.expect.approved, ...decided];
  const rows = await client.query<CandidateRow>(
    `SELECT r.id, r.mode, r.status, r.eligibility_status, r.round_forge_version,
            ${playerFacingSql('r')} AS player_facing,
            (SELECT count(*)::int FROM source_receipts s WHERE s.round_id = r.id) AS receipts,
            (r.initial_commitment_hash <> '') AS has_commitment,
            (r.repeat_of IS NULL) AS canonical,
            coalesce((SELECT array_agg(d.utc_date::text ORDER BY d.utc_date) FROM daily_challenges d WHERE d.round_id = r.id), '{}') AS dailies
     FROM rounds r WHERE r.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  for (const id of plan.expect.approved) {
    const r = byId.get(id);
    if (!r) problems.push(`expected approved round ${id} does not exist`);
    else if (!r.player_facing) problems.push(`expected approved round ${id} is not player-facing (${r.eligibility_status})`);
  }
  for (const id of decided) {
    const r = byId.get(id);
    if (!r) {
      problems.push(`candidate ${id} does not exist`);
      continue;
    }
    if (r.mode !== 'replay' || r.status !== 'ready') problems.push(`candidate ${id} is ${r.mode}/${r.status}, not a ready Replay round`);
    if (r.eligibility_status !== 'pending_review') problems.push(`candidate ${id} is ${r.eligibility_status}, not pending_review`);
    if (r.round_forge_version !== REPLAY_FORGE_VERSION) problems.push(`candidate ${id} is Round Forge v${r.round_forge_version}, not v${REPLAY_FORGE_VERSION}`);
    if (r.receipts < 1 || !r.has_commitment) problems.push(`candidate ${id} lacks source receipts or a commitment`);
    if (r.dailies.length > 0) problems.push(`candidate ${id} already has a Daily (${r.dailies.join(', ')})`);
  }

  const facing = await playerFacingIds(client);
  if (!sameSet(facing, plan.expect.approved)) {
    problems.push(`player-facing rounds are [${facing.join(', ')}], expected [${plan.expect.approved.join(', ')}]`);
  }
  const pending = await client.query<{ id: string }>(
    `SELECT id FROM rounds WHERE eligibility_status = 'pending_review' AND round_forge_version = $1`,
    [REPLAY_FORGE_VERSION],
  );
  const pendingIds = pending.rows.map((r) => r.id);
  if (!sameSet(pendingIds, decided)) {
    problems.push(`pending v${REPLAY_FORGE_VERSION} candidates are [${pendingIds.join(', ')}], the plan decides [${decided.join(', ')}]`);
  }

  const dailies = await dailiesFrom(client, today);
  const expectedDailies = Object.entries(plan.expect.dailies).filter(([date]) => date >= today);
  for (const [date, id] of expectedDailies) {
    if (dailies[date] !== id) problems.push(`Daily ${date} is ${dailies[date] ?? 'unassigned'}, expected ${id}`);
  }
  const unexpected = Object.keys(dailies).filter((d) => !(d in plan.expect.dailies));
  if (unexpected.length) problems.push(`unexpected Daily rows from today: ${unexpected.join(', ')}`);

  if (plan.daily) {
    if (plan.daily.date < today) problems.push(`Daily date ${plan.daily.date} is before today (${today})`);
    if (plan.daily.date in dailies) problems.push(`${plan.daily.date} already has a Daily (${dailies[plan.daily.date]})`);
    const r = byId.get(plan.daily.round);
    if (r && r.dailies.length > 0) problems.push(`Daily round ${plan.daily.round} was already a Daily (${r.dailies.join(', ')})`);
    if (r && (r.mode !== 'replay' || !r.canonical || r.receipts < 1)) {
      problems.push(`Daily round ${plan.daily.round} is not a canonical Replay round with receipts`);
    }
  }
  return problems;
}

/**
 * Checks the plan against the live catalog and, with `confirm`, applies it. The dry run
 * uses a read-only transaction. The confirmed run locks the Daily table against concurrent
 * assignment, re-checks everything under that lock, writes, then re-checks the result
 * before committing.
 */
export async function publishReviewedRounds(
  plan: PublishPlan,
  actor: string,
  opts: { confirm: boolean; dailySource?: string },
): Promise<PublishReport> {
  if (!actor.trim()) throw new PublishRefused(['an actor is required']);
  const planIssues = planProblems(plan);
  if (planIssues.length) throw new PublishRefused(planIssues);

  return withTransaction(async (client) => {
    if (opts.confirm) {
      await client.query('LOCK TABLE daily_challenges IN SHARE ROW EXCLUSIVE MODE');
      await client.query('SELECT id FROM rounds WHERE id = ANY($1::uuid[]) FOR UPDATE', [
        [...plan.approve, ...plan.reject].map((d) => d.round),
      ]);
    } else {
      await client.query('SET TRANSACTION READ ONLY');
    }
    const today = (await client.query<{ d: string }>(`SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS d`)).rows[0]!.d;
    const problems = await stateProblems(client, plan, today);
    if (problems.length) throw new PublishRefused(problems);
    const before = await untouchedCounts(client);

    if (!opts.confirm) {
      return {
        today,
        playerFacing: await playerFacingIds(client),
        approved: [],
        rejected: [],
        daily: null,
        untouched: before,
        written: false,
      };
    }

    for (const d of plan.approve) await setRoundEligibility(client, d.round, { status: 'approved', actor, note: d.note });
    for (const d of plan.reject) await setRoundEligibility(client, d.round, { status: 'withdrawn', actor, note: d.note });
    if (plan.daily) {
      await client.query(
        'INSERT INTO daily_challenges (utc_date, round_id, assignment_source) VALUES ($1::date, $2, $3)',
        [plan.daily.date, plan.daily.round, opts.dailySource ?? 'admin_script'],
      );
    }

    const after: string[] = [];
    const facing = await playerFacingIds(client);
    const expectedFacing = [...plan.expect.approved, ...plan.approve.map((d) => d.round)];
    if (!sameSet(facing, expectedFacing)) after.push(`player-facing rounds after publishing are [${facing.join(', ')}]`);
    const rejected = await client.query<{ id: string }>(
      `SELECT r.id FROM rounds r WHERE r.id = ANY($1::uuid[]) AND r.eligibility_status = 'withdrawn' AND NOT ${playerFacingSql('r')}`,
      [plan.reject.map((d) => d.round)],
    );
    if (rejected.rows.length !== plan.reject.length) after.push('a rejected round is not recorded as withdrawn');
    const dailies = await dailiesFrom(client, today);
    for (const [date, id] of Object.entries(plan.expect.dailies)) {
      if (date >= today && dailies[date] !== id) after.push(`Daily ${date} changed`);
    }
    if (plan.daily && dailies[plan.daily.date] !== plan.daily.round) after.push(`Daily ${plan.daily.date} was not assigned`);
    const counts = await untouchedCounts(client);
    for (const [k, v] of Object.entries(before)) if (counts[k] !== v) after.push(`${k} changed from ${v} to ${counts[k]}`);
    if (after.length) throw new PublishRefused(after);

    return {
      today,
      playerFacing: facing,
      approved: plan.approve.map((d) => d.round),
      rejected: plan.reject.map((d) => d.round),
      daily: plan.daily ? { utcDate: plan.daily.date, roundId: plan.daily.round } : null,
      untouched: counts,
      written: true,
    };
  });
}
