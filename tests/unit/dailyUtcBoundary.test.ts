import { describe, expect, it } from 'vitest';
import { isDailyExpiredServer } from '@/lib/domain/dailyShare';

/**
 * Pure UTC date formatting replicating PostgreSQL's `(now() AT TIME ZONE 'UTC')::date`
 */
function getUtcCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe('Daily UTC date and boundary rules', () => {
  it('correctly handles 23:59:59 UTC boundary on the same day', () => {
    const endOfDay = new Date('2026-09-25T23:59:59.999Z');
    expect(getUtcCalendarDate(endOfDay)).toBe('2026-09-25');
    // Still active for 2026-09-25 challenge
    expect(isDailyExpiredServer('2026-09-25', endOfDay)).toBe(false);
  });

  it('correctly shifts to next calendar date at 00:00:00 UTC and expires previous challenge', () => {
    const startOfNextDay = new Date('2026-09-26T00:00:00.000Z');
    expect(getUtcCalendarDate(startOfNextDay)).toBe('2026-09-26');
    // Previous day 2026-09-25 is now expired
    expect(isDailyExpiredServer('2026-09-25', startOfNextDay)).toBe(true);
    // New day 2026-09-26 is active
    expect(isDailyExpiredServer('2026-09-26', startOfNextDay)).toBe(false);
  });

  it('handles timezone offset correctly: Nigeria (WAT, UTC+1) vs UTC calendar date', () => {
    // 00:30 in Nigeria (WAT = UTC+1) on Sept 26 is 23:30 UTC on Sept 25
    // The server MUST evaluate UTC date, not client local timezone date
    const nigeriaTimeUtc = new Date('2026-09-25T23:30:00.000Z');
    expect(getUtcCalendarDate(nigeriaTimeUtc)).toBe('2026-09-25');
    expect(isDailyExpiredServer('2026-09-25', nigeriaTimeUtc)).toBe(false);

    // 01:05 in Nigeria on Sept 26 is 00:05 UTC on Sept 26
    const nigeriaAfterUtcMidnight = new Date('2026-09-26T00:05:00.000Z');
    expect(getUtcCalendarDate(nigeriaAfterUtcMidnight)).toBe('2026-09-26');
    expect(isDailyExpiredServer('2026-09-25', nigeriaAfterUtcMidnight)).toBe(true);
    expect(isDailyExpiredServer('2026-09-26', nigeriaAfterUtcMidnight)).toBe(false);
  });

  it('handles month boundary transitions in UTC', () => {
    // Leap year / month-end: Feb 28 -> Feb 29 or Mar 31 -> Apr 01
    const endOfMonth = new Date('2026-03-31T23:59:59.000Z');
    const startOfNextMonth = new Date('2026-04-01T00:00:01.000Z');

    expect(getUtcCalendarDate(endOfMonth)).toBe('2026-03-31');
    expect(getUtcCalendarDate(startOfNextMonth)).toBe('2026-04-01');

    expect(isDailyExpiredServer('2026-03-31', endOfMonth)).toBe(false);
    expect(isDailyExpiredServer('2026-03-31', startOfNextMonth)).toBe(true);
  });

  it('handles year boundary transitions in UTC', () => {
    const endOfYear = new Date('2026-12-31T23:59:59.000Z');
    const startOfNewYear = new Date('2027-01-01T00:00:00.000Z');

    expect(getUtcCalendarDate(endOfYear)).toBe('2026-12-31');
    expect(getUtcCalendarDate(startOfNewYear)).toBe('2027-01-01');

    expect(isDailyExpiredServer('2026-12-31', endOfYear)).toBe(false);
    expect(isDailyExpiredServer('2026-12-31', startOfNewYear)).toBe(true);
  });
});
