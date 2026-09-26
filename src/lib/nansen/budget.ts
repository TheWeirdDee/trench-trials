import { canonicalize } from '../domain/commitment';

/**
 * Per-operation Nansen request budget. Every Nansen HTTP request goes through
 * nansenPost (client.ts), which requires one of these:
 *
 * - a network slot is reserved before every HTTP attempt, retries included, and the
 *   operation stops with NansenBudgetError once `maxNetworkCalls` is reached;
 * - every attempt (network or cache) is handed to the recorder, which writes
 *   api_call_log in production. An attempt that cannot be recorded halts the
 *   operation, because an unaudited call is exactly what this guard exists to stop;
 * - an insufficient-credits or auth rejection halts the operation, so no further
 *   request is sent for it;
 * - a repeated identical request within one operation is served from memory and
 *   recorded as a cache hit, without consuming a network slot.
 *
 * This module never touches the network or the database itself.
 */

/** Absolute upper bound for any configured per-operation budget. */
export const NANSEN_CALL_BUDGET_CEILING = 10;

/** Live create: one 1-day and one 7-day Historical Token Screener request (DATA-CONTRACT.md §3). */
export const LIVE_CREATE_REQUIRED_NANSEN_CALLS = 2;
/** The two required requests plus a single transient retry. */
export const DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_CREATE = 3;
export const MAX_NANSEN_CALLS_PER_LIVE_CREATE_ENV = 'MAX_NANSEN_CALLS_PER_LIVE_CREATE';

/** Live resolve: one 5m Historical Token OHLCV request per slot (A, B, C). */
export const LIVE_RESOLVE_REQUIRED_NANSEN_CALLS = 3;
/** The three required requests plus a single transient retry. */
export const DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_RESOLVE = 4;
export const MAX_NANSEN_CALLS_PER_LIVE_RESOLVE_ENV = 'MAX_NANSEN_CALLS_PER_LIVE_RESOLVE';

/**
 * Documented credit price per request (docs.nansen.ai/getting-started/credits).
 * A credit-capped budget refuses any endpoint that is not listed here.
 */
export const DOCUMENTED_CREDITS_PER_CALL: Readonly<Record<string, number>> = {
  '/api/v1beta1/token-screener/historical': 5,
  '/api/v1beta1/tgm/historical-token-ohlcv': 5,
  '/api/v1/token-screener': 1,
};

/** Absolute upper bound for any configured per-operation credit cap. */
export const NANSEN_CREDIT_BUDGET_CEILING = 100;
export const MAX_NANSEN_CREDITS_PER_LIVE_CREATE_ENV = 'MAX_NANSEN_CREDITS_PER_LIVE_CREATE';
export const MAX_NANSEN_CREDITS_PER_LIVE_RESOLVE_ENV = 'MAX_NANSEN_CREDITS_PER_LIVE_RESOLVE';
/** Three current-screener requests at 1 credit. */
export const DEFAULT_MAX_NANSEN_CREDITS_PER_LIVE_CREATE = 3;
/** Four historical OHLCV requests at 5 credits. */
export const DEFAULT_MAX_NANSEN_CREDITS_PER_LIVE_RESOLVE = 20;

export type NansenBudgetErrorCode =
  | 'nansen_budget_invalid'
  | 'nansen_credit_cap'
  | 'nansen_budget_below_required'
  | 'nansen_budget_exhausted'
  | 'nansen_operation_halted'
  | 'nansen_audit_log_failed';

export class NansenBudgetError extends Error {
  constructor(
    message: string,
    public readonly code: NansenBudgetErrorCode,
    public readonly operation: string,
  ) {
    super(message);
    this.name = 'NansenBudgetError';
  }
}

export interface NansenAttemptRecord {
  operation: string;
  endpoint: string;
  requestTimestamp: Date;
  responseTimestamp: Date;
  durationMs: number;
  /** null when no HTTP response was received (network error or timeout). */
  httpStatus: number | null;
  isSuccess: boolean;
  nansenRequestId: string | null;
  quotedCredits: number | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  errorCode: string | null;
  isCacheHit: boolean;
}

export type NansenAttemptRecorder = (record: NansenAttemptRecord) => Promise<void>;

export interface NansenBudgetSummary {
  operation: string;
  maxNetworkCalls: number;
  networkCalls: number;
  cacheHits: number;
  haltedReason: string | null;
  /** Sum of x-nansen-credits-used over network attempts that reported it. */
  creditsUsed: number;
  /** Last x-nansen-credits-remaining seen, if any. */
  lastCreditsRemaining: number | null;
}

export interface NansenCallBudgetOptions {
  operation: string;
  maxNetworkCalls: number;
  /**
   * Requests the operation needs to complete. A budget below this is refused up
   * front, before any request, so a misconfiguration cannot spend credits on an
   * operation that can never finish.
   */
  requiredNetworkCalls?: number;
  /**
   * Hard credit cap for the operation. Before each attempt, the credits already charged
   * (reported by Nansen, or the documented price when not reported) plus the documented
   * price of the next request must fit, or the request is refused before any I/O.
   */
  maxCredits?: number;
  recorder: NansenAttemptRecorder;
}

export class NansenCallBudget {
  readonly operation: string;
  readonly maxNetworkCalls: number;
  private readonly recorder: NansenAttemptRecorder;
  private readonly cache = new Map<string, unknown>();
  private readonly attemptLog: NansenAttemptRecord[] = [];
  private used = 0;
  private haltReason: string | null = null;

  constructor(options: NansenCallBudgetOptions) {
    const { operation, maxNetworkCalls, requiredNetworkCalls } = options;
    if (
      !Number.isInteger(maxNetworkCalls) ||
      maxNetworkCalls < 1 ||
      maxNetworkCalls > NANSEN_CALL_BUDGET_CEILING
    ) {
      throw new NansenBudgetError(
        `Nansen call budget for "${operation}" must be an integer between 1 and ${NANSEN_CALL_BUDGET_CEILING} (got ${maxNetworkCalls})`,
        'nansen_budget_invalid',
        operation,
      );
    }
    if (requiredNetworkCalls !== undefined && maxNetworkCalls < requiredNetworkCalls) {
      throw new NansenBudgetError(
        `Nansen call budget for "${operation}" is ${maxNetworkCalls}, below the ${requiredNetworkCalls} requests it needs; refusing to start`,
        'nansen_budget_below_required',
        operation,
      );
    }
    const { maxCredits } = options;
    if (
      maxCredits !== undefined &&
      (!Number.isInteger(maxCredits) || maxCredits < 1 || maxCredits > NANSEN_CREDIT_BUDGET_CEILING)
    ) {
      throw new NansenBudgetError(
        `Nansen credit cap for "${operation}" must be an integer between 1 and ${NANSEN_CREDIT_BUDGET_CEILING} (got ${maxCredits})`,
        'nansen_budget_invalid',
        operation,
      );
    }
    this.operation = operation;
    this.maxNetworkCalls = maxNetworkCalls;
    this.maxCredits = maxCredits ?? null;
    this.recorder = options.recorder;
  }

  readonly maxCredits: number | null;
  private creditsCharged = 0;
  private pendingCost: number | null = null;

  /** Credits charged so far: as reported by Nansen, else the documented price of each network attempt. */
  get creditsChargedSoFar(): number {
    return this.creditsCharged;
  }

  get networkCallsUsed(): number {
    return this.used;
  }

  get haltedReason(): string | null {
    return this.haltReason;
  }

  get attempts(): readonly NansenAttemptRecord[] {
    return this.attemptLog;
  }

  /** Claims one network slot. Throws, before any I/O, once the budget is spent or the operation is halted. */
  reserveNetworkCall(endpoint: string): void {
    if (this.haltReason) {
      throw new NansenBudgetError(
        `Nansen operation "${this.operation}" halted (${this.haltReason}); refusing further request to ${endpoint}`,
        'nansen_operation_halted',
        this.operation,
      );
    }
    if (this.used >= this.maxNetworkCalls) {
      throw new NansenBudgetError(
        `Nansen call budget for "${this.operation}" exhausted (${this.used}/${this.maxNetworkCalls}); refusing request to ${endpoint}`,
        'nansen_budget_exhausted',
        this.operation,
      );
    }
    const price = DOCUMENTED_CREDITS_PER_CALL[endpoint];
    if (this.maxCredits !== null) {
      if (price === undefined) {
        throw new NansenBudgetError(
          `No documented credit price for ${endpoint}; a credit-capped operation refuses it`,
          'nansen_credit_cap',
          this.operation,
        );
      }
      if (this.creditsCharged + price > this.maxCredits) {
        throw new NansenBudgetError(
          `Nansen credit cap for "${this.operation}" would be exceeded (${this.creditsCharged} + ${price} > ${this.maxCredits}); refusing request to ${endpoint}`,
          'nansen_credit_cap',
          this.operation,
        );
      }
    }
    this.pendingCost = price ?? null;
    this.used += 1;
  }

  /** Stops the operation: every later reserveNetworkCall throws. The first reason wins. */
  halt(reason: string): void {
    if (!this.haltReason) this.haltReason = reason;
  }

  async record(attempt: Omit<NansenAttemptRecord, 'operation'>): Promise<void> {
    const full: NansenAttemptRecord = { operation: this.operation, ...attempt };
    this.attemptLog.push(full);
    if (!attempt.isCacheHit) {
      // What Nansen reports wins; without a report, assume the documented price was charged.
      this.creditsCharged += attempt.creditsUsed ?? this.pendingCost ?? 0;
      this.pendingCost = null;
    }
    try {
      await this.recorder(full);
    } catch (err) {
      this.halt('audit_log_failed');
      throw new NansenBudgetError(
        `Failed to record Nansen attempt for "${this.operation}" in api_call_log: ${err instanceof Error ? err.message : String(err)}`,
        'nansen_audit_log_failed',
        this.operation,
      );
    }
  }

  cacheKey(endpoint: string, body: unknown): string {
    return `${endpoint} ${canonicalize(body)}`;
  }

  getCached<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  setCached(key: string, value: unknown): void {
    this.cache.set(key, value);
  }

  summary(): NansenBudgetSummary {
    let creditsUsed = 0;
    let lastCreditsRemaining: number | null = null;
    let cacheHits = 0;
    for (const a of this.attemptLog) {
      if (a.isCacheHit) {
        cacheHits += 1;
        continue;
      }
      if (a.creditsUsed !== null) creditsUsed += a.creditsUsed;
      if (a.creditsRemaining !== null) lastCreditsRemaining = a.creditsRemaining;
    }
    return {
      operation: this.operation,
      maxNetworkCalls: this.maxNetworkCalls,
      networkCalls: this.used,
      cacheHits,
      haltedReason: this.haltReason,
      creditsUsed,
      lastCreditsRemaining,
    };
  }
}

/**
 * Reads a per-operation budget from the environment. Unset means the default; any
 * other value must be an integer in [1, NANSEN_CALL_BUDGET_CEILING] or this throws,
 * so a typo can never silently widen the budget.
 */
/** Reads a per-operation credit cap from the environment; a malformed value throws rather than widening the cap. */
export function readNansenCreditBudget(
  envName: string,
  defaultValue: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > NANSEN_CREDIT_BUDGET_CEILING) {
    throw new NansenBudgetError(
      `${envName} must be an integer between 1 and ${NANSEN_CREDIT_BUDGET_CEILING} (got "${raw}")`,
      'nansen_budget_invalid',
      envName,
    );
  }
  return n;
}

export function readNansenCallBudget(
  envName: string,
  defaultValue: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[envName];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > NANSEN_CALL_BUDGET_CEILING) {
    throw new NansenBudgetError(
      `${envName} must be an integer between 1 and ${NANSEN_CALL_BUDGET_CEILING} (got "${raw}")`,
      'nansen_budget_invalid',
      envName,
    );
  }
  return n;
}
