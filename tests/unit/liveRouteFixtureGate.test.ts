import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Refusals must happen before any database or Nansen access.
vi.mock('@/lib/db', () => ({
  getPool: () => {
    throw new Error('database must not be touched');
  },
  withTransaction: () => {
    throw new Error('database must not be touched');
  },
}));

import { POST as createLive } from '@/app/api/internal/live/create/route';
import { POST as resolveLive } from '@/app/api/internal/live/resolve/route';

function internalRequest(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': 'test-secret' },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'test-secret');
  vi.stubEnv('NODE_ENV', 'production');
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.unstubAllEnvs();
});

describe('internal Live routes — fixture inputs are test-runner only', () => {
  it('create refuses caller-supplied assets and receipts outside the test runner', async () => {
    const res = await createLive(
      internalRequest('/api/internal/live/create', {
        customAssets: [{ slot: 'A', tokenSymbol: 'FAKE' }],
        sourceReceipts: [{ endpoint: 'x', requestParams: {}, responseSha256: 'fake' }],
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'fixture_inputs_disabled' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('resolve refuses caller-supplied exit prices outside the test runner', async () => {
    const res = await resolveLive(
      internalRequest('/api/internal/live/resolve', { roundId: 'r', customExitPrices: [{ slot: 'A' }] }),
    );
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('resolve refuses a caller-supplied clock outside the test runner', async () => {
    const res = await resolveLive(internalRequest('/api/internal/live/resolve', { roundId: 'r', now: '2030-01-01T00:00:00Z' }));
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
