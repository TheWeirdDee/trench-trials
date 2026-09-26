import { afterEach, describe, expect, it } from 'vitest';
import { isAuthorizedInternalRequest } from '@/lib/internalAuth';

const ORIGINAL = process.env.CRON_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

const req = (headers: Record<string, string>) => new Request('http://test/api/internal/usage', { headers });

describe('isAuthorizedInternalRequest', () => {
  it('fails closed when CRON_SECRET is not configured, whatever is sent', () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedInternalRequest(req({}))).toBe(false);
    expect(isAuthorizedInternalRequest(req({ 'x-internal-secret': '' }))).toBe(false);
    expect(isAuthorizedInternalRequest(req({ authorization: 'Bearer undefined' }))).toBe(false);
  });

  it('accepts only the exact secret, by header or bearer token', () => {
    process.env.CRON_SECRET = 'correct-secret-value';
    expect(isAuthorizedInternalRequest(req({ 'x-internal-secret': 'correct-secret-value' }))).toBe(true);
    expect(isAuthorizedInternalRequest(req({ authorization: 'Bearer correct-secret-value' }))).toBe(true);
    expect(isAuthorizedInternalRequest(req({}))).toBe(false);
    expect(isAuthorizedInternalRequest(req({ 'x-internal-secret': 'correct-secret-valu' }))).toBe(false);
    expect(isAuthorizedInternalRequest(req({ 'x-internal-secret': 'correct-secret-valuE' }))).toBe(false);
    expect(isAuthorizedInternalRequest(req({ authorization: 'Bearer wrong' }))).toBe(false);
  });
});
