/**
 * Shared shape of what GET/POST /api/rounds/[id]* actually return, mirroring
 * src/lib/api/roundView.ts and src/lib/allowlist.ts exactly. This file declares
 * types only — no runtime code, no secrets — and is imported by both server and
 * client code so the UI never has to guess the API's shape.
 */

export type Slot = 'A' | 'B' | 'C';
export type AttemptStage = 'blind' | 'unmasked' | 'final_locked' | 'pending' | 'invalid';
export type FinalActionType = 'stick' | 'switch' | 'timeout';
export type SwitchOutcome = 'helped' | 'hurt' | 'unchanged';

export interface ClueView {
  buySellBalance: string;
  tradingAcceleration: string;
  netflowOverLiquidity: string;
  recentMomentum: string;
}

export interface BlindAssetView {
  slot: Slot;
  clues: ClueView;
}

export interface UnmaskedAssetView extends BlindAssetView {
  tokenSymbol: string;
  tokenAddress: string;
}

export interface VerdictAssetView extends UnmaskedAssetView {
  returnPct: number;
  entryCandleStart: string;
  exitCandleStart: string;
}

export interface RoundMeta {
  id: string;
  mode: string;
  chain: string;
  status?: string;
  horizonDays: number;
  coarsePeriod: string;
  decisionWindowSeconds: number;
  decisionWindowVersion: number;
  exactCutoff?: string | null;
  resolutionTime?: string | null;
  snapshotPublishedAt?: string | null;
  entryCloseAt?: string | null;
  measurementStartAt?: string | null;
  measurementEndAt?: string | null;
  invalidReason?: string | null;
  livePhase?: 'ENTRY_OPEN' | 'FINAL_LOCK_WINDOW' | 'MEASURING' | 'RESOLVING' | 'RESOLVED' | 'INVALID' | null;
}

export interface AttemptMeta {
  /** Null until the guest's first intentional action (the Blind Pick lock) creates the attempt. */
  id: string | null;
  stage: AttemptStage;
  blindSlot: Slot | null;
  finalSlot: Slot | null;
  finalActionType: FinalActionType | null;
  finalDeadlineAt: string | null;
  isRepeat: boolean;
  /** Self-reported, optional, post-verdict only. Null fields mean "not yet answered". */
  recognitionSlots: Slot[] | null;
  recognitionSkipped: boolean;
  recognitionSubmitted: boolean;
}

export interface VerdictData {
  assets: VerdictAssetView[];
  winningSlots: Slot[];
  blindSlot: Slot;
  finalSlot: Slot;
  finalActionType: FinalActionType;
  blindReturnPct: number;
  finalReturnPct: number;
  switchImpactPp: number;
  tickerTaxPp: number;
  switchOutcome: SwitchOutcome | null;
  blindWasWinner: boolean;
  finalWasWinner: boolean;
  pointsAwarded: number;
}

/** Where a round's data came from. Only sent once the outcome may be shown, or the round is void. */
/** A sealed commitment opened at the verdict: SHA-256(canonical JSON of { manifest, nonce }) must equal `hash`. */
export interface CommitmentReveal {
  kind: 'initial' | 'resolution';
  hash: string;
  manifest: unknown;
  nonce: string;
}

export interface Provenance {
  commitmentHash: string;
  /** Present only at the verdict, when nothing the manifest contains is secret any more. */
  commitments?: CommitmentReveal[];
  sourceReceipts: Array<{
    endpoint: string;
    purpose: string | null;
    responseSha256: string;
    requestId: string | null;
    retrievedAt: string;
  }>;
}

export interface BlindStageResponse {
  /** Authoritative server clock when the response was built; timers count against it. */
  serverNow: string;
  round: RoundMeta;
  attempt: AttemptMeta & { stage: 'blind' };
  assets: BlindAssetView[];
}
export interface UnmaskedStageResponse {
  /** Authoritative server clock when the response was built; timers count against it. */
  serverNow: string;
  round: RoundMeta;
  attempt: AttemptMeta & { stage: 'unmasked' };
  assets: UnmaskedAssetView[];
}
export interface VerdictStageResponse {
  /** Authoritative server clock when the response was built; timers count against it. */
  serverNow: string;
  round: RoundMeta;
  attempt: AttemptMeta & { stage: 'final_locked' };
  verdict: VerdictData;
  provenance: Provenance;
}
export interface PendingStageResponse {
  /** Authoritative server clock when the response was built; timers count against it. */
  serverNow: string;
  round: RoundMeta;
  attempt: AttemptMeta & { stage: 'pending' | 'invalid' };
  assets: UnmaskedAssetView[];
  provenance?: Provenance;
}

export type RoundStageResponse =
  | BlindStageResponse
  | UnmaskedStageResponse
  | VerdictStageResponse
  | PendingStageResponse;

export function isBlindStage(d: RoundStageResponse): d is BlindStageResponse {
  return d.attempt.stage === 'blind';
}
export function isUnmaskedStage(d: RoundStageResponse): d is UnmaskedStageResponse {
  return d.attempt.stage === 'unmasked';
}
export function isVerdictStage(d: RoundStageResponse): d is VerdictStageResponse {
  return d.attempt.stage === 'final_locked' && 'verdict' in d;
}
export function isPendingStage(d: RoundStageResponse): d is PendingStageResponse {
  return d.attempt.stage === 'pending' || d.attempt.stage === 'invalid';
}

export interface ApiErrorResponse {
  error: string;
  reason?: string;
  message?: string;
}
