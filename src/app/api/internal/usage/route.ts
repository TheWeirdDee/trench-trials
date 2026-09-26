import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAuthorizedInternalRequest } from '@/lib/internalAuth';

/**
 * Sanitized Nansen call evidence for submission (PRD §16: "Export sanitized usage
 * evidence for submission... Cache hits are not new Nansen API calls; track failed
 * calls separately"). Internal-only — not a public dashboard.
 */
export async function GET(req: Request) {
  if (!isAuthorizedInternalRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const pool = getPool();
  const summary = await pool.query<{
    total_calls: string;
    successful_network_calls: string;
    failed_calls: string;
    cache_hits: string;
  }>(
    `SELECT
       count(*) AS total_calls,
       count(*) FILTER (WHERE is_success AND NOT is_cache_hit) AS successful_network_calls,
       count(*) FILTER (WHERE NOT is_success) AS failed_calls,
       count(*) FILTER (WHERE is_cache_hit) AS cache_hits
     FROM api_call_log`,
  );

  const byEndpoint = await pool.query<{ endpoint: string; count: string; succeeded_count: string }>(
    `SELECT endpoint, count(*) AS count, count(*) FILTER (WHERE is_success) AS succeeded_count
     FROM api_call_log GROUP BY endpoint ORDER BY count(*) DESC`,
  );

  const row = summary.rows[0];
  return NextResponse.json({
    totalCalls: Number(row?.total_calls ?? 0),
    successfulNetworkCalls: Number(row?.successful_network_calls ?? 0),
    failedCalls: Number(row?.failed_calls ?? 0),
    cacheHits: Number(row?.cache_hits ?? 0),
    byEndpoint: byEndpoint.rows.map((r) => ({
      endpoint: r.endpoint,
      count: Number(r.count),
      succeededCount: Number(r.succeeded_count),
    })),
    note: 'successfulNetworkCalls counts genuine, billed/served Nansen calls only — cache hits and failed calls are excluded, per campaign eligibility rules.',
  });
}
