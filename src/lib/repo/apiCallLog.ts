import { getPool } from '../db';
import type { NansenAttemptRecord } from '../nansen/budget';

export interface ApiCallLogEntry {
  endpoint: string;
  requestTimestamp: Date;
  responseTimestamp: Date;
  durationMs: number;
  httpStatus: number;
  isSuccess: boolean;
  nansenRequestId: string | null;
  quotedCredits: number | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  errorCode: string | null;
  isCacheHit: boolean;
  sourceReceiptId?: string | null;
  isBackfill?: boolean;
  /** The budgeted operation that made the call, e.g. `live_create` or `live_resolve:<roundId>`. */
  purpose?: string | null;
}

/**
 * Persists an auditable Nansen API call record without secrets (no API keys, no URLs, no raw bodies).
 */
export async function recordApiCallLog(entry: ApiCallLogEntry): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO api_call_log (
       endpoint, request_timestamp, response_timestamp, duration_ms,
       http_status, is_success, nansen_request_id, quoted_credits,
       credits_used, credits_remaining, error_code, is_cache_hit,
       source_receipt_id, is_backfill, purpose
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
     ) RETURNING id`,
    [
      entry.endpoint,
      entry.requestTimestamp,
      entry.responseTimestamp,
      entry.durationMs,
      entry.httpStatus,
      entry.isSuccess,
      entry.nansenRequestId,
      entry.quotedCredits,
      entry.creditsUsed,
      entry.creditsRemaining,
      entry.errorCode,
      entry.isCacheHit,
      entry.sourceReceiptId ?? null,
      entry.isBackfill ?? false,
      entry.purpose ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('Failed to insert api_call_log');
  return row.id;
}

/**
 * NansenAttemptRecorder for production: one api_call_log row per attempt, tagged
 * with the operation in `purpose`. An attempt that got no HTTP response (network
 * error or timeout) is stored as http_status 0, since that column is NOT NULL.
 */
export async function recordNansenAttempt(record: NansenAttemptRecord): Promise<void> {
  await recordApiCallLog({
    endpoint: record.endpoint,
    requestTimestamp: record.requestTimestamp,
    responseTimestamp: record.responseTimestamp,
    durationMs: record.durationMs,
    httpStatus: record.httpStatus ?? 0,
    isSuccess: record.isSuccess,
    nansenRequestId: record.nansenRequestId,
    quotedCredits: record.quotedCredits,
    creditsUsed: record.creditsUsed,
    creditsRemaining: record.creditsRemaining,
    errorCode: record.errorCode,
    isCacheHit: record.isCacheHit,
    purpose: record.operation,
  });
}
