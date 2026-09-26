import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { recordApiCallLog, type ApiCallLogEntry } from '@/lib/repo/apiCallLog';

const DB_AVAILABLE = Boolean(process.env.DATABASE_URL);
const maybeDescribe = DB_AVAILABLE ? describe : describe.skip;

const loggedIdsToClean: string[] = [];

afterAll(async () => {
  if (!DB_AVAILABLE || loggedIdsToClean.length === 0) return;
  const pool = getPool();
  await pool.query('DELETE FROM api_call_log WHERE id = ANY($1::uuid[])', [loggedIdsToClean]);
});

maybeDescribe('api_call_log table and redaction', () => {
  it('records a successful mocked network call with credit tracking and zero secrets', async () => {
    const entry: ApiCallLogEntry = {
      endpoint: '/api/v1beta1/token-screener/historical',
      requestTimestamp: new Date('2026-09-25T10:00:00Z'),
      responseTimestamp: new Date('2026-09-25T10:00:00.350Z'),
      durationMs: 350,
      httpStatus: 200,
      isSuccess: true,
      nansenRequestId: 'req-mock-12345',
      quotedCredits: 1,
      creditsUsed: 1,
      creditsRemaining: 47,
      errorCode: null,
      isCacheHit: false,
    };

    const id = await recordApiCallLog(entry);
    loggedIdsToClean.push(id);

    const pool = getPool();
    const res = await pool.query('SELECT * FROM api_call_log WHERE id = $1', [id]);
    expect(res.rows.length).toBe(1);
    const row = res.rows[0];

    expect(row.endpoint).toBe('/api/v1beta1/token-screener/historical');
    expect(row.http_status).toBe(200);
    expect(row.is_success).toBe(true);
    expect(row.nansen_request_id).toBe('req-mock-12345');
    expect(row.credits_used).toBe(1);
    expect(row.credits_remaining).toBe(47);
    expect(row.is_cache_hit).toBe(false);

    // Verify redaction: No API key, database URL or sensitive auth headers stored
    const rowString = JSON.stringify(row);
    expect(rowString).not.toContain('apikey');
    expect(rowString).not.toContain('NANSEN_API_KEY');
    expect(rowString).not.toContain('DATABASE_URL');
    expect(rowString).not.toContain('postgres://');
    expect(rowString).not.toContain('secret');
  });

  it('records 400 validation failures with zero credits used', async () => {
    const entry: ApiCallLogEntry = {
      endpoint: '/api/v1beta1/tgm/historical-token-ohlcv',
      requestTimestamp: new Date('2026-09-25T10:05:00Z'),
      responseTimestamp: new Date('2026-09-25T10:05:00.120Z'),
      durationMs: 120,
      httpStatus: 400,
      isSuccess: false,
      nansenRequestId: 'req-mock-validation-err',
      quotedCredits: 0,
      creditsUsed: 0,
      creditsRemaining: 47,
      errorCode: 'invalid_timeframe',
      isCacheHit: false,
    };

    const id = await recordApiCallLog(entry);
    loggedIdsToClean.push(id);

    const pool = getPool();
    const res = await pool.query('SELECT * FROM api_call_log WHERE id = $1', [id]);
    const row = res.rows[0];
    expect(row.credits_used).toBe(0);
    expect(row.is_success).toBe(false);
    expect(row.error_code).toBe('invalid_timeframe');
  });
});
