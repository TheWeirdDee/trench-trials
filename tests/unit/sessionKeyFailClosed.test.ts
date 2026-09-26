import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeSessionCookie, generateGuestId, readGuestId, resolveOrIssueGuest, SESSION_COOKIE } from '@/lib/session';

const GOOD_SECRET = 'test-only-session-secret-0123456789abcdef';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SESSION_SECRET fails closed in production', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['shorter than 32 characters', 'short-secret'],
  ])('%s: no cookie is issued and no cookie is trusted', (_label, secret) => {
    const guestId = generateGuestId();
    vi.stubEnv('SESSION_SECRET', GOOD_SECRET);
    const validCookie = encodeSessionCookie(guestId);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', secret as string);
    expect(() => encodeSessionCookie(guestId)).toThrow(/SESSION_SECRET must be set/);
    const req = new NextRequest('http://test/api/rounds/next', { headers: { cookie: `${SESSION_COOKIE}=${validCookie}` } });
    expect(readGuestId(req)).toBeNull();
    expect(() => resolveOrIssueGuest(req)).toThrow(/SESSION_SECRET must be set/);
  });
});
