/**
 * Publishes reviewed Round Forge candidates and schedules a Daily in one transaction, from
 * an exactly expected catalog state (src/lib/repo/catalogPublish.ts). Approvals, rejections
 * and the Daily row commit together or not at all. Zero Nansen calls.
 *
 * Usage:
 *   npm run publish:rounds -- --plan plan.json --actor <name>             # dry run: checks only, writes nothing
 *   npm run publish:rounds -- --plan plan.json --actor <name> --confirm   # apply
 *
 * plan.json:
 *   {
 *     "expect":  { "approved": ["<uuid>", …], "dailies": { "YYYY-MM-DD": "<uuid>", … } },
 *     "approve": [{ "round": "<uuid>", "note": "…" }],
 *     "reject":  [{ "round": "<uuid>", "note": "…" }],
 *     "daily":   { "date": "YYYY-MM-DD", "round": "<uuid>" }
 *   }
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { dbSchema, getPool } from '../src/lib/db';
import { PublishRefused, publishReviewedRounds } from '../src/lib/repo/catalogPublish';

const decision = z.object({ round: z.string(), note: z.string() }).strict();
const planSchema = z
  .object({
    expect: z.object({ approved: z.array(z.string()), dailies: z.record(z.string()) }).strict(),
    approve: z.array(decision),
    reject: z.array(decision),
    daily: z.object({ date: z.string(), round: z.string() }).strict().optional(),
  })
  .strict();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const planPath = arg('plan');
  const actor = arg('actor');
  if (!planPath) throw new Error('--plan <file> is required');
  if (!actor) throw new Error('--actor <name> is required');
  const plan = planSchema.parse(JSON.parse(readFileSync(planPath, 'utf8')));

  const short = (id: string) => id.slice(0, 8);
  console.log('Publish plan');
  console.log(`  schema:   ${dbSchema() ?? 'public'}`);
  console.log(`  actor:    ${actor}`);
  console.log(`  expect:   approved ${plan.expect.approved.map(short).join(', ') || 'none'}; Dailies ${Object.entries(plan.expect.dailies).map(([d, id]) => `${d} → ${short(id)}`).join(', ') || 'none'}`);
  for (const d of plan.approve) console.log(`  approve:  ${d.round}  (${d.note})`);
  for (const d of plan.reject) console.log(`  reject:   ${d.round}  (${d.note})`);
  if (plan.daily) console.log(`  Daily:    ${plan.daily.date} → ${plan.daily.round}`);

  const report = await publishReviewedRounds(plan, actor, { confirm });
  console.log(`\nToday (UTC, database clock): ${report.today}`);
  console.log(`Player-facing rounds${report.written ? '' : ' now'}: ${report.playerFacing.length} (${report.playerFacing.map(short).join(', ')})`);
  console.log(`Unchanged: ${Object.entries(report.untouched).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (!report.written) {
    console.log('\nDry run: every check passed; nothing written. Re-run with --confirm to apply.');
    return;
  }
  console.log(`\nApproved ${report.approved.length}, rejected ${report.rejected.length}${report.daily ? `, Daily ${report.daily.utcDate} → ${report.daily.roundId}` : ''}. Committed in one transaction.`);
}

main()
  .catch((err) => {
    console.error(err instanceof PublishRefused || err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
