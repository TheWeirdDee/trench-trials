import { describe, expect, it } from 'vitest';
import { buildDailyShareText, isDailyExpiredServer } from '@/lib/domain/dailyShare';

// While a Daily is live the share text must not point at the answer: no token, address,
// slot, price or per-token return. (Real round-001 values are used as the probe.)
const FORBIDDEN_WHILE_LIVE = ['POPCAT', 'YZY', 'BOME', '7GCihgDB', 'DrZ26cKJ', 'ukHH6c7m', '38.18', '2.07', '20.89', 'Slot'];

const base = { dailyNumber: 42, challengeUrl: 'https://example.com/daily', streak: 0 };

describe('buildDailyShareText', () => {
  it('carries branding, the result, the decision change, Ticker Tax, streak and the challenge link', () => {
    const text = buildDailyShareText({ ...base, finalWasWinner: true, action: 'switch', tickerTaxPp: -36.1, streak: 3 });
    expect(text.split('\n')).toEqual([
      'Trench Trials — Daily #42',
      'Result: correct',
      'Blind → Final: changed my pick after the reveal',
      'Ticker Tax: -36.1 pp',
      'Daily streak: 3',
      'Can you trust your read after seeing the ticker?',
      'https://example.com/daily',
    ]);
  });

  it('never names a token, address, slot, price or per-token return', () => {
    for (const action of ['stick', 'switch', 'timeout'] as const) {
      for (const finalWasWinner of [true, false]) {
        const text = buildDailyShareText({ ...base, finalWasWinner, action, tickerTaxPp: action === 'switch' ? -36.1 : 0 });
        for (const term of FORBIDDEN_WHILE_LIVE) {
          expect(text, `${action}/${finalWasWinner} must not contain "${term}"`).not.toContain(term);
        }
        expect(text).not.toMatch(/\b[ABC]\b/); // no bare slot letter
        expect(text).not.toMatch(/%/); // no return percentage
      }
    }
  });

  it('a kept pick costs exactly 0.0 pp; a timeout is not a decision and has no Ticker Tax line', () => {
    expect(buildDailyShareText({ ...base, finalWasWinner: false, action: 'stick', tickerTaxPp: 0 })).toContain(
      'Ticker Tax: 0.0 pp',
    );
    const timeout = buildDailyShareText({ ...base, finalWasWinner: false, action: 'timeout', tickerTaxPp: null });
    expect(timeout).toContain('Blind → Final: time ran out, blind pick kept');
    expect(timeout).not.toContain('Ticker Tax');
    expect(timeout).toContain('Result: missed');
  });

  it('omits the streak line when there is no streak', () => {
    expect(buildDailyShareText({ ...base, finalWasWinner: true, action: 'stick', tickerTaxPp: 0 })).not.toContain('streak');
  });
});

describe('isDailyExpiredServer', () => {
  it('correctly evaluates active vs expired based on UTC date cutoff + 24 hours', () => {
    const utcDate = '2026-09-25';
    expect(isDailyExpiredServer(utcDate, new Date('2026-09-25T12:00:00Z'))).toBe(false);
    expect(isDailyExpiredServer(utcDate, new Date('2026-09-25T23:59:59Z'))).toBe(false);
    expect(isDailyExpiredServer(utcDate, new Date('2026-09-26T00:00:00Z'))).toBe(true);
    expect(isDailyExpiredServer(utcDate, new Date('2026-09-27T10:00:00Z'))).toBe(true);
  });
});
