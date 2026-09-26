/**
 * Which tokens may be compared in a round. A round asks which of three tokens performed
 * best, so every candidate must be a freely traded token whose price is set by its own
 * market — not a stablecoin or stable-yield wrapper, not a wrapped or bridged copy of
 * another chain's major asset, not a liquid-staking, LP or index token, not a tokenized
 * stock or real-world asset. Shared by Live snapshots and historical Round Forge.
 *
 * Eligibility policy version 2 (2026-09-26 audit, docs/NANSEN-CONTRACT-AUDIT.md):
 * - classification must be POSITIVE: a token passes only when a Nansen sector tag places
 *   it in an allowed class. No tag, or only unknown tags, is "unclassified" and fails
 *   closed — unclassified never means eligible;
 * - a minimum trailing-24h trading volume (a deep pool nobody trades is not a market).
 * Rounds approved under an older version are not player-facing until re-reviewed.
 */
export const ELIGIBILITY_POLICY_VERSION = 2;

export const EXCLUDED_SYMBOLS: ReadonlySet<string> = new Set([
  // Stablecoins and stable-yield wrappers
  'USDT', 'USDC', 'DAI', 'USDE', 'FDUSD', 'BUSD', 'TUSD', 'PYUSD', 'FRAX', 'LUSD', 'CRVUSD', 'USDS', 'USD1', 'USDY',
  'SYRUPUSDC', 'USDG', 'USDH', 'EURC', 'PAXG', 'XAUT',
  // Wrapped or bridged majors whose price is set on another chain
  'WETH', 'ETH', 'WBTC', 'BTC', 'CBBTC', 'ZBTC', 'TBTC', 'WSOL', 'SOL', 'ZEC', 'HYPE', 'BNB', 'XRP', 'TRX',
  'AVAX', 'LINK', 'UNI', 'AAVE', 'DOGE', 'SUI', 'APT', 'TON', 'ADA', 'DOT', 'LTC', 'SPX',
  // Liquid-staking and LP/index tokens
  'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'INF', 'BNSOL', 'HSOL', 'STSOL', 'DSOL', 'VSOL', 'JLP',
]);

/** Nansen sector tags that mark a token as not comparable (see above). */
export const EXCLUDED_SECTORS: ReadonlySet<string> = new Set([
  'Stablecoin',
  'Tokenized Stocks',
  'Yield Bearing',
  'Liquid Staking',
  'RWAs',
]);

/** Nansen sector tags that positively classify a freely traded native token. */
export const ALLOWED_SECTORS: ReadonlySet<string> = new Set([
  'Memecoins',
  'Artificial Intelligence',
  'AI Agents',
  'Decentralised Exchanges',
  'GameFi',
  'Scaling & Connectivity',
  'Perps, Options and Derivatives',
]);

/** Trailing-24h trading volume a candidate needs, in USD. */
export const MIN_DAILY_VOLUME_USD = 100_000;

export type AssetClassification =
  | { status: 'eligible'; basis: string }
  | { status: 'excluded'; reason: string }
  | { status: 'unclassified'; reason: string };

/**
 * `sectors` are the token's Nansen tags. When a request filtered by sector (the current
 * screener returns no tags), pass that filter as `requestedSectors`: every returned row
 * carries one of those tags by construction.
 */
export function classifyAsset(input: {
  symbol: string | null | undefined;
  sectors?: readonly string[] | null;
  requestedSectors?: readonly string[] | null;
}): AssetClassification {
  const symbol = (input.symbol ?? '').toUpperCase();
  if (!symbol) return { status: 'unclassified', reason: 'no symbol' };
  if (EXCLUDED_SYMBOLS.has(symbol)) return { status: 'excluded', reason: `excluded symbol ${symbol}` };
  const tags = input.sectors ?? [];
  const bad = tags.find((t) => EXCLUDED_SECTORS.has(t));
  if (bad) return { status: 'excluded', reason: `excluded sector ${bad}` };
  const good = tags.find((t) => ALLOWED_SECTORS.has(t));
  if (good) return { status: 'eligible', basis: `sector ${good}` };
  const requested = (input.requestedSectors ?? []).filter((t) => ALLOWED_SECTORS.has(t));
  if (tags.length === 0 && requested.length > 0) {
    return { status: 'eligible', basis: `request filter ${requested.join('/')}` };
  }
  return {
    status: 'unclassified',
    reason: tags.length === 0 ? 'no sector tag' : `no allowed sector tag (${tags.join(', ')})`,
  };
}

/** Comparable and positively classified. */
export function isComparableAsset(
  symbol: string | null | undefined,
  sectors: readonly string[] | null | undefined,
  requestedSectors?: readonly string[] | null,
): boolean {
  return classifyAsset({ symbol, sectors, requestedSectors }).status === 'eligible';
}

/** Two rounds are near-duplicates when their candidate sets share two or more tokens. */
export const NEAR_DUPLICATE_SHARED_TOKENS = 2;

export function sharedTokenCount(a: readonly string[], b: readonly string[]): number {
  const set = new Set(a);
  return b.filter((x) => set.has(x)).length;
}
