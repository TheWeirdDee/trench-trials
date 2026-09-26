import { expect, test } from './helpers';

/**
 * Security and operations checks against the production build (`next start`): headers,
 * internal-route authorization, health, public source maps and error bodies. Read-only:
 * no request here creates a player, an attempt or a round.
 */
test.describe('Security and operations', () => {
  test('every page response carries the security headers and no Server-Timing', async ({ request }) => {
    for (const path of ['/', '/docs', '/play', '/history', '/api/health']) {
      const res = await request.get(path);
      expect(res.status(), path).toBeLessThan(400);
      const h = res.headers();
      expect(h['x-content-type-options'], path).toBe('nosniff');
      expect(h['x-frame-options'], path).toBe('DENY');
      expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
      expect(h['permissions-policy'], path).toContain('camera=()');
      expect(h['cross-origin-opener-policy'], path).toBe('same-origin');
      expect(h['server-timing'], path).toBeUndefined();
    }
  });

  test('health reports a reachable database', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, database: 'reachable' });
  });

  test('internal routes refuse requests without the correct secret, revealing nothing', async ({ request }) => {
    const calls = [
      () => request.get('/api/internal/usage'),
      () => request.get('/api/internal/usage', { headers: { 'x-internal-secret': 'wrong-secret' } }),
      () => request.get('/api/internal/usage', { headers: { authorization: 'Bearer wrong-secret' } }),
      () => request.post('/api/internal/live/create', { data: {} }),
      () => request.post('/api/internal/live/resolve', { data: {} }),
      () => request.post('/api/internal/daily/assign', { data: { utcDate: '2099-01-01', roundId: '00000000-0000-4000-8000-000000000000' } }),
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status()).toBe(401);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'unauthorized' });
    }
  });

  test('errors carry no stack trace, SQL or filesystem path', async ({ request }) => {
    for (const path of ['/api/rounds/not-a-uuid', '/api/rounds/00000000-0000-4000-8000-000000000000', '/api/rounds/00000000-0000-4000-8000-000000000000/result']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      const text = await res.text();
      expect(text, path).not.toMatch(/\bat\s+\S+\s+\(|SELECT|INSERT|node_modules|[A-Z]:\\|\/home\/|\.ts:\d+/);
    }
  });

  test('no browser source map is public', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const chunks = [...html.matchAll(/\/_next\/static\/[^"']+\.js/g)].map((m) => m[0]).slice(0, 5);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const res = await request.get(`${chunk}.map`);
      expect(res.status(), chunk).toBe(404);
    }
  });
});
