import { z } from 'zod';

/**
 * Runtime contracts for every Nansen endpoint this project calls, taken from the official
 * documentation (docs/NANSEN-CONTRACT-AUDIT.md, Phase 1) rather than from our own code.
 *
 * - A request is validated before any budget slot is reserved or any byte leaves the
 *   process: an invalid payload can never spend a credit.
 * - A 2xx response is validated before any caller sees it: a wrong shape halts the
 *   operation as a malformed response, however "successful" the HTTP status was.
 *
 * Dates are typed per endpoint, never through one generic helper:
 * - historical screener `to_date`      — `YYYY-MM-DD` only ("string (date)")
 * - historical OHLCV `date_from`       — ISO date OR UTC datetime ("date or datetime")
 * - historical OHLCV `as_of_date`      — ISO date only, meaning "through the end of that day"
 * - historical OHLCV `as_of_ts`        — UTC datetime only (Hyperliquid)
 * - current screener                   — no dates; the recommended `timeframe` enum
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_UTC_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2}(\.\d{1,6})?)?Z$/;

/** A real calendar date (rejects 2026-02-30 etc.), interpreted in UTC. */
function isRealUtcDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

/** Historical screener `to_date`: `YYYY-MM-DD`, a real date. */
export const HistoricalScreenerToDate = z
  .string()
  .regex(ISO_DATE, 'to_date must be YYYY-MM-DD')
  .refine(isRealUtcDate, 'to_date is not a real calendar date');

/** Historical OHLCV `as_of_date`: date-only; the window runs through the end of that UTC day. */
export const OhlcvAsOfDate = HistoricalScreenerToDate;

/** An ISO 8601 datetime in UTC (`Z` suffix required, so no local-time interpretation is possible). */
export const UtcDateTime = z
  .string()
  .regex(ISO_UTC_DATETIME, 'must be an ISO 8601 UTC datetime ending in Z')
  .refine((s) => !Number.isNaN(Date.parse(s)) && isRealUtcDate(s.slice(0, 10)), 'not a real datetime');

/** Historical OHLCV `date_from`: documented as "date or datetime". */
export const OhlcvDateFrom = z.union([HistoricalScreenerToDate, UtcDateTime]);

/** Formats a Date as the UTC calendar date — never the local date. */
export function utcDateOf(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error('Invalid Date');
  return d.toISOString().slice(0, 10);
}

/** Formats a Date as the documented UTC datetime form, e.g. `2026-08-19T00:00:00Z`. */
export function utcDateTimeOf(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error('Invalid Date');
  return d.toISOString().replace('.000Z', 'Z');
}

// --- Requests -------------------------------------------------------------------

const range = z
  .object({ min: z.number().finite().optional(), max: z.number().finite().optional() })
  .strict()
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, 'min must be ≤ max');
const pagination = z
  .object({ page: z.number().int().min(1).optional(), per_page: z.number().int().min(1).max(1000).optional() })
  .strict();
const HISTORICAL_SORT_FIELDS = [
  'volume', 'buy_volume', 'sell_volume', 'netflow', 'price_change', 'market_cap_usd', 'fdv', 'liquidity',
  'price_usd', 'nof_traders', 'nof_buyers', 'nof_sellers', 'nof_buys', 'nof_sells', 'token_age_days',
] as const;

/** [HS] POST /api/v1beta1/token-screener/historical */
export const historicalScreenerRequestSchema = z
  .object({
    to_date: HistoricalScreenerToDate,
    timeframe_days: z.number().int().min(1).max(365),
    chains: z.array(z.string().min(1)).min(1),
    exclude_sectors: z.array(z.string().min(1)).optional(),
    sectors_filter: z.array(z.string().min(1)).optional(),
    apply_blacklist_filter: z.boolean().optional(),
    filters: z
      .object({
        volume_usd: range.optional(),
        buy_volume_usd: range.optional(),
        sell_volume_usd: range.optional(),
        market_cap_usd: range.optional(),
        fdv_usd: range.optional(),
        fdv_mc_ratio: range.optional(),
        liquidity_usd: range.optional(),
        netflow_usd: range.optional(),
        inflow_fdv_ratio: range.optional(),
        outflow_fdv_ratio: range.optional(),
        token_age_days: range.optional(),
      })
      .strict()
      .optional(),
    pagination: pagination.optional(),
    order_by: z
      .array(z.object({ field: z.enum(HISTORICAL_SORT_FIELDS), direction: z.enum(['ASC', 'DESC']) }).strict())
      .min(1)
      .optional(),
  })
  .strict();

/** [CS] POST /api/v1/token-screener — `timeframe` (recommended) only; the deprecated `date` is not used. */
export const currentScreenerRequestSchema = z
  .object({
    chains: z.array(z.string().min(1)).min(1),
    timeframe: z.enum(['5m', '10m', '1h', '6h', '24h', '7d', '30d']),
    filters: z
      .object({
        liquidity: range.optional(),
        market_cap_usd: range.optional(),
        token_age_days: range.optional(),
        volume: range.optional(),
        price_change: range.optional(),
        include_stablecoins: z.boolean().optional(),
        include_native_tokens: z.boolean().optional(),
        sectors: z.array(z.string().min(1)).optional(),
        exclude_sectors: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    pagination: pagination.optional(),
    order_by: z.array(z.object({ field: z.string().min(1), direction: z.enum(['ASC', 'DESC']) }).strict()).min(1).optional(),
  })
  .strict();

/** [HO] POST /api/v1beta1/tgm/historical-token-ohlcv */
export const historicalOhlcvRequestSchema = z
  .object({
    chain: z.enum(['base', 'bnb', 'ethereum', 'hyperliquid', 'solana']),
    token_address: z.string().min(1),
    date_from: OhlcvDateFrom,
    timeframe: z.enum(['5m', '15m', '30m', '1h', '4h', '1d', '1w']),
    as_of_date: OhlcvAsOfDate.optional(),
    as_of_ts: UtcDateTime.optional(),
    apply_blacklist_filter: z.boolean().optional(),
  })
  .strict()
  .refine((r) => (r.as_of_date === undefined) !== (r.as_of_ts === undefined), 'exactly one of as_of_date / as_of_ts')
  .refine((r) => r.apply_blacklist_filter === undefined || r.timeframe === '1d' || r.timeframe === '1w', 'apply_blacklist_filter is only valid for 1d/1w')
  .refine((r) => {
    const from = Date.parse(r.date_from.length === 10 ? `${r.date_from}T00:00:00Z` : r.date_from);
    const to = r.as_of_date ? Date.parse(`${r.as_of_date}T23:59:59Z`) : Date.parse(r.as_of_ts!);
    return from <= to;
  }, 'date_from must not be after the as-of bound');

// --- Responses ------------------------------------------------------------------

const num = z.number().finite().nullable();
const optNum = num.optional();

const screenerRow = z
  .object({
    token_address: z.string().min(1),
    token_symbol: z.string(),
    chain: z.string().min(1),
    price_usd: num,
    price_change: num,
    market_cap_usd: num,
    fdv: optNum,
    fdv_mc_ratio: optNum,
    volume: num,
    buy_volume: num,
    sell_volume: num,
    netflow: num,
    inflow_fdv_ratio: optNum,
    outflow_fdv_ratio: optNum,
    token_age_days: num,
    liquidity: num,
  })
  .passthrough();
const paginationOut = z.object({ page: z.number(), per_page: z.number(), is_last_page: z.boolean() }).passthrough();

export const historicalScreenerResponseSchema = z
  .object({ pagination: paginationOut, data: z.array(screenerRow.extend({ sectors: z.array(z.string()) })) })
  .passthrough();

export const currentScreenerResponseSchema = z
  .object({ pagination: paginationOut.optional(), data: z.array(screenerRow.extend({ sectors: z.array(z.string()).optional() })) })
  .passthrough();

const candle = z
  .object({
    interval_start: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'interval_start must be a timestamp'),
    open: num,
    high: num,
    low: num,
    close: num,
    volume: num,
    volume_usd: num,
    market_cap: z.object({ open: num, high: num, low: num, close: num }).passthrough().nullable().optional(),
  })
  .passthrough();

export const historicalOhlcvResponseSchema = z
  .object({
    chain: z.string(),
    token_address: z.string(),
    timeframe: z.string(),
    data: z.array(candle),
    truncated: z.boolean(),
    truncation_note: z.string().nullable(),
  })
  .passthrough();

export interface EndpointContract {
  request: z.ZodTypeAny;
  response: z.ZodTypeAny;
}

export class NansenContractError extends Error {
  constructor(
    public readonly code: 'request_schema_invalid' | 'response_not_json' | 'response_schema_invalid',
    public readonly endpoint: string,
    public readonly issues: string[],
  ) {
    super(`Nansen ${code.replace(/_/g, ' ')} for ${endpoint}: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'NansenContractError';
  }
}

export function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}
