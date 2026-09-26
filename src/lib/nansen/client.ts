import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NansenCallBudget } from './budget';
import {
  currentScreenerRequestSchema,
  currentScreenerResponseSchema,
  formatIssues,
  historicalOhlcvRequestSchema,
  historicalOhlcvResponseSchema,
  historicalScreenerRequestSchema,
  historicalScreenerResponseSchema,
  NansenContractError,
  type EndpointContract,
} from './contracts';

/**
 * When NANSEN_RAW_RESPONSE_DIR is set (operator scripts set it for real runs), every HTTP
 * response body is kept there verbatim with its request body, status, request ID and
 * SHA-256 — private evidence that is gitignored and never served or committed. A body
 * that cannot be kept stops the operation: an unrecoverable response is not evidence.
 */
function keepRawResponse(entry: {
  operation: string;
  endpoint: string;
  requestBody: unknown;
  status: number;
  requestId: string | null;
  retrievedAt: string;
  responseSha256: string;
  body: string;
}): void {
  const dir = process.env.NANSEN_RAW_RESPONSE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const slug = entry.endpoint.split('/').filter(Boolean).pop() ?? 'response';
  const name = `${entry.retrievedAt.replace(/[:.]/g, '-')}-${entry.operation.replace(/[^\w.-]/g, '_')}-${slug}-${entry.status}-${entry.responseSha256.slice(0, 12)}.json`;
  writeFileSync(join(dir, name), `${JSON.stringify(entry, null, 2)}
`);
}

/**
 * Server-only Nansen API client. NANSEN_API_KEY is read here and only here in this
 * module's request path — it must never be passed to client components, logged, or
 * included in any thrown error message.
 *
 * Endpoints and behavior here are exactly what DATA-CONTRACT.md §1 documents from
 * real authenticated calls: base URL, header name, retry-relevant status codes,
 * credit-header names, and the fact that a 4xx validation failure is not billed.
 * No fallback provider exists — every failure path here ends in an error, never
 * substitute data.
 *
 * Every request requires a NansenCallBudget (budget.ts): each HTTP attempt reserves
 * a slot first and is recorded afterwards, so no code path can call Nansen without
 * a hard cap and an api_call_log row.
 */

const BASE_URL = 'https://api.nansen.ai';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 10_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export class NansenApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly requestId: string | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'NansenApiError';
  }
}

/** 402, or a 403 that names credits. Never retried; halts the whole operation. */
export class NansenInsufficientCreditsError extends NansenApiError {
  constructor(path: string, status: number, requestId: string | null) {
    super(`Nansen API rejected ${path}: insufficient credits (${status})`, status, 'insufficient_credits', requestId, false);
    this.name = 'NansenInsufficientCreditsError';
  }
}

export interface NansenCallMeta {
  endpoint: string;
  status: number;
  requestId: string | null;
  creditsCost: number | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  responseSha256: string;
  retrievedAt: string;
  attempts: number;
}

export interface NansenCallResult<T> {
  data: T;
  meta: NansenCallMeta;
}

function getApiKey(): string {
  const key = process.env.NANSEN_API_KEY;
  if (!key) {
    throw new Error('NANSEN_API_KEY is not set — refusing to call Nansen with no credential');
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nansenPost<T>(
  path: string,
  body: unknown,
  budget: NansenCallBudget,
  contract: EndpointContract,
): Promise<NansenCallResult<T>> {
  // The request must match the endpoint's documented contract before anything else
  // happens: no budget slot, no log row, no network — an invalid payload costs nothing.
  const requestCheck = contract.request.safeParse(body);
  if (!requestCheck.success) {
    throw new NansenContractError('request_schema_invalid', path, formatIssues(requestCheck.error));
  }

  // An identical request already answered in this operation is not a new network call.
  const cacheKey = budget.cacheKey(path, body);
  const cached = budget.getCached<NansenCallResult<T>>(cacheKey);
  if (cached) {
    const now = new Date();
    await budget.record({
      endpoint: path,
      requestTimestamp: now,
      responseTimestamp: now,
      durationMs: 0,
      httpStatus: cached.meta.status,
      isSuccess: true,
      nansenRequestId: cached.meta.requestId,
      quotedCredits: null,
      creditsUsed: null,
      creditsRemaining: null,
      errorCode: null,
      isCacheHit: true,
    });
    return cached;
  }

  const key = getApiKey();
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Throws before any I/O once the operation's budget is spent or it was halted.
    budget.reserveNetworkCall(path);

    const requestTimestamp = new Date();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(BASE_URL + path, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      // Network/timeout error — retryable up to MAX_ATTEMPTS, each attempt within budget.
      lastError = err;
      const responseTimestamp = new Date();
      await budget.record({
        endpoint: path,
        requestTimestamp,
        responseTimestamp,
        durationMs: responseTimestamp.getTime() - requestTimestamp.getTime(),
        httpStatus: null,
        isSuccess: false,
        nansenRequestId: null,
        quotedCredits: null,
        creditsUsed: null,
        creditsRemaining: null,
        errorCode: 'network_error',
        isCacheHit: false,
      });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(computeRetryBackoffMs(attempt, null));
        continue;
      }
      break;
    } finally {
      clearTimeout(timeout);
    }

    const responseTimestamp = new Date();
    const requestId = res.headers.get('x-request-id');
    const creditsCost = parseIntHeader(res.headers.get('x-nansen-credits-cost'));
    const creditsUsed = parseIntHeader(res.headers.get('x-nansen-credits-used'));
    const creditsRemaining = parseIntHeader(res.headers.get('x-nansen-credits-remaining'));
    const succeeded = res.status >= 200 && res.status < 300;
    const errorCode = succeeded ? null : classifyErrorCode(res.status, text);
    const responseSha256 = createHash('sha256').update(text, 'utf8').digest('hex');

    await budget.record({
      endpoint: path,
      requestTimestamp,
      responseTimestamp,
      durationMs: responseTimestamp.getTime() - requestTimestamp.getTime(),
      httpStatus: res.status,
      isSuccess: succeeded,
      nansenRequestId: requestId,
      quotedCredits: creditsCost,
      creditsUsed,
      creditsRemaining,
      errorCode,
      isCacheHit: false,
    });

    keepRawResponse({
      operation: budget.operation,
      endpoint: path,
      requestBody: body,
      status: res.status,
      requestId,
      retrievedAt: responseTimestamp.toISOString(),
      responseSha256,
      body: text,
    });

    if (succeeded) {
      // A 2xx body that is not JSON, or not the documented shape, is a malformed response:
      // the call was served (and billed), so it is never retried, and the operation halts.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        budget.halt('malformed_response');
        throw new NansenContractError('response_not_json', path, ['body is not JSON']);
      }
      const responseCheck = contract.response.safeParse(parsed);
      if (!responseCheck.success) {
        budget.halt('malformed_response');
        throw new NansenContractError('response_schema_invalid', path, formatIssues(responseCheck.error));
      }
      const result: NansenCallResult<T> = {
        data: parsed as T,
        meta: {
          endpoint: path,
          status: res.status,
          requestId,
          creditsCost,
          creditsUsed,
          creditsRemaining,
          responseSha256,
          retrievedAt: responseTimestamp.toISOString(),
          attempts: attempt,
        },
      };
      budget.setCached(cacheKey, result);
      return result;
    }

    if (errorCode === 'insufficient_credits') {
      budget.halt('insufficient_credits');
      throw new NansenInsufficientCreditsError(path, res.status, requestId);
    }
    if (res.status === 401 || res.status === 403) {
      budget.halt('auth_rejected');
      throw new NansenApiError(
        `Nansen API error ${res.status} on ${path}${errorCode ? ` (${errorCode})` : ''}`,
        res.status,
        errorCode,
        requestId,
        false,
      );
    }

    const retryable = RETRYABLE_STATUS.has(res.status);
    if (retryable && attempt < MAX_ATTEMPTS) {
      await sleep(computeRetryBackoffMs(attempt, res.headers.get('retry-after')));
      continue;
    }

    throw new NansenApiError(
      `Nansen API error ${res.status} on ${path}${errorCode ? ` (${errorCode})` : ''}`,
      res.status,
      errorCode,
      requestId,
      retryable,
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Nansen API call to ${path} failed after ${MAX_ATTEMPTS} attempts`);
}

/** Retry-After (seconds) when it is a usable number, else exponential; capped either way. */
export function computeRetryBackoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  const ms =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1000
      : 250 * 2 ** (attempt - 1);
  return Math.min(ms, MAX_BACKOFF_MS);
}

function parseIntHeader(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { code?: string };
    return parsed.code ?? null;
  } catch {
    return null;
  }
}

function classifyErrorCode(status: number, text: string): string | null {
  const code = extractErrorCode(text);
  if (status === 402) return 'insufficient_credits';
  if (status === 403 && /credit/i.test(`${code ?? ''} ${text}`)) return 'insufficient_credits';
  return code;
}

// --- Typed endpoint wrappers, matching DATA-CONTRACT.md §1 exactly ---------

export interface HistoricalScreenerFilters {
  liquidity_usd?: { min?: number; max?: number };
  market_cap_usd?: { min?: number; max?: number };
  token_age_days?: { min?: number; max?: number };
  volume_usd?: { min?: number; max?: number };
}

export interface HistoricalScreenerRequest {
  to_date: string;
  timeframe_days: number;
  chains: string[];
  exclude_sectors?: string[];
  sectors_filter?: string[];
  filters?: HistoricalScreenerFilters;
  pagination?: { page?: number; per_page?: number };
  order_by?: { field: string; direction: 'ASC' | 'DESC' }[];
}

export interface HistoricalScreenerRow {
  token_address: string;
  token_symbol: string;
  chain: string;
  price_usd: number;
  price_change: number;
  market_cap_usd: number | null;
  fdv: number | null;
  fdv_mc_ratio: number | null;
  volume: number;
  buy_volume: number;
  sell_volume: number;
  netflow: number;
  inflow_fdv_ratio: number | null;
  outflow_fdv_ratio: number | null;
  token_age_days: number | null;
  liquidity: number;
  sectors: string[];
}

export interface HistoricalScreenerResponse {
  pagination: { page: number; per_page: number; is_last_page: boolean };
  data: HistoricalScreenerRow[];
}

export const HISTORICAL_SCREENER_PATH = '/api/v1beta1/token-screener/historical';

export function fetchHistoricalScreener(
  req: HistoricalScreenerRequest,
  budget: NansenCallBudget,
): Promise<NansenCallResult<HistoricalScreenerResponse>> {
  return nansenPost(HISTORICAL_SCREENER_PATH, req, budget, {
    request: historicalScreenerRequestSchema,
    response: historicalScreenerResponseSchema,
  });
}

// --- Current (point-in-time) Token Screener — docs.nansen.ai, token-screener -----------
// POST /api/v1/token-screener, 1 credit per call (Nansen pricing docs). Results reflect
// data as of the request; `timeframe` selects the trailing window. Filters live inside
// `filters`. The response has no `sectors` field; sector exclusion is a request filter.

export type CurrentScreenerTimeframe = '5m' | '10m' | '1h' | '6h' | '24h' | '7d' | '30d';

export interface CurrentScreenerRequest {
  chains: string[];
  timeframe: CurrentScreenerTimeframe;
  filters?: {
    liquidity?: { min?: number; max?: number };
    market_cap_usd?: { min?: number; max?: number };
    token_age_days?: { min?: number; max?: number };
    include_stablecoins?: boolean;
    include_native_tokens?: boolean;
    /** Positive classification: only tokens carrying one of these Nansen sector tags. */
    sectors?: string[];
    exclude_sectors?: string[];
    volume?: { min?: number; max?: number };
  };
  pagination?: { page?: number; per_page?: number };
  order_by?: { field: string; direction: 'ASC' | 'DESC' }[];
}

export interface CurrentScreenerRow {
  chain: string;
  token_address: string;
  token_symbol: string;
  token_age_days: number | null;
  token_age_hours?: number | null;
  token_deployment_date?: string | null;
  fdv?: number | null;
  fdv_mc_ratio?: number | null;
  inflow_fdv_ratio?: number | null;
  outflow_fdv_ratio?: number | null;
  market_cap_usd: number | null;
  liquidity: number;
  price_usd: number;
  /** Documented as "price change percentage"; its numeric scale is checked before use. */
  price_change: number;
  volume: number;
  buy_volume: number;
  sell_volume: number;
  netflow: number;
  sectors?: string[];
}

export interface CurrentScreenerResponse {
  data: CurrentScreenerRow[];
  pagination?: { page: number; per_page: number; is_last_page: boolean };
}

export const CURRENT_SCREENER_PATH = '/api/v1/token-screener';

export function fetchCurrentScreener(
  req: CurrentScreenerRequest,
  budget: NansenCallBudget,
): Promise<NansenCallResult<CurrentScreenerResponse>> {
  return nansenPost(CURRENT_SCREENER_PATH, req, budget, {
    request: currentScreenerRequestSchema,
    response: currentScreenerResponseSchema,
  });
}

export interface HistoricalOhlcvRequest {
  chain: string;
  token_address: string;
  date_from: string;
  timeframe: '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';
  as_of_date?: string;
  as_of_ts?: string;
}

export interface OhlcvCandle {
  interval_start: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  volume_usd: number | null;
  market_cap: { open: number | null; high: number | null; low: number | null; close: number | null };
}

export interface HistoricalOhlcvResponse {
  chain: string;
  token_address: string;
  timeframe: string;
  data: OhlcvCandle[];
  truncated: boolean;
  truncation_note: string | null;
}

export const HISTORICAL_OHLCV_PATH = '/api/v1beta1/tgm/historical-token-ohlcv';

export function fetchHistoricalOhlcv(
  req: HistoricalOhlcvRequest,
  budget: NansenCallBudget,
): Promise<NansenCallResult<HistoricalOhlcvResponse>> {
  return nansenPost(HISTORICAL_OHLCV_PATH, req, budget, {
    request: historicalOhlcvRequestSchema,
    response: historicalOhlcvResponseSchema,
  });
}
