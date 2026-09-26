import type { FinalActionType } from './scoring';

export interface DailyShareInput {
  dailyNumber: number;
  challengeUrl: string;
  finalWasWinner: boolean;
  action: FinalActionType;
  /** Blind return − final return, in percentage points. Omitted for a timeout (not a decision). */
  tickerTaxPp: number | null;
  /** Consecutive assigned Dailies completed on the day (see domain/history.ts). */
  streak: number;
}

export function isDailyExpiredServer(utcDateStr: string, now = new Date()): boolean {
  const dateStr = utcDateStr.slice(0, 10);
  const cutoffMs = Date.parse(`${dateStr}T00:00:00Z`);
  const expiryMs = cutoffMs + 24 * 60 * 60 * 1000;
  return now.getTime() >= expiryMs;
}

const DECISION: Record<FinalActionType, string> = {
  stick: 'Blind → Final: kept my pick',
  switch: 'Blind → Final: changed my pick after the reveal',
  timeout: 'Blind → Final: time ran out, blind pick kept',
};

/**
 * Share text for a completed Daily. While the Daily is live, other players have not
 * played it, so the text never names a token, slot, price or per-token return: it says
 * whether the pick was right, how the decision changed, what the reveal cost or earned
 * (Ticker Tax contribution), and the streak — nothing that points at the answer.
 */
export function buildDailyShareText(input: DailyShareInput): string {
  const lines = [`Trench Trials — Daily #${input.dailyNumber}`];
  lines.push(input.finalWasWinner ? 'Result: correct' : 'Result: missed');
  lines.push(DECISION[input.action]);
  if (input.action !== 'timeout' && input.tickerTaxPp !== null) {
    const pp = input.tickerTaxPp;
    lines.push(`Ticker Tax: ${pp > 0 ? '+' : ''}${pp.toFixed(1)} pp`);
  }
  if (input.streak > 0) lines.push(`Daily streak: ${input.streak}`);
  lines.push('Can you trust your read after seeing the ticker?');
  lines.push(input.challengeUrl);
  return lines.join('\n');
}
