import { NextRequest } from 'next/server';
import { encodeSessionCookie, SESSION_COOKIE } from '@/lib/session';

/**
 * `cookie` is a guest id: it is sent as the signed session cookie the server issues
 * (`v1.<guestId>.<sig>`). Pass `rawCookie` to send an arbitrary value (e.g. forged).
 */
export function makeRequest(
  url: string,
  options: { method?: string; body?: unknown; cookie?: string | null; rawCookie?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (options.rawCookie !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${options.rawCookie}`);
  else if (options.cookie) headers.set('cookie', `${SESSION_COOKIE}=${encodeSessionCookie(options.cookie)}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');

  return new NextRequest(
    new Request(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }),
  );
}

/** The raw session cookie value a route handler set via response.cookies.set(...), if any. */
export function extractSessionCookie(response: Response): string | null {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match?.[1] ?? null;
}

/** The guest id inside a signed session cookie value (`v1.<guestId>.<sig>`). */
export function guestIdFromCookie(value: string): string | null {
  const [version, guestId] = value.split('.');
  return version === 'v1' && guestId ? guestId : null;
}

/**
 * Tracks one simulated guest across requests, so a test can make several calls in a
 * row (blind -> final -> result) as "the same browser session" the way a real player
 * would, including picking up the cookie the server issues on the first Blind Pick.
 */
export class TestSession {
  private guestId: string;

  constructor(initialGuestId?: string) {
    this.guestId = initialGuestId ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** The guest id (players.anon_id) — used for exact-id cleanup. */
  cookieHeader(): string {
    return this.guestId;
  }

  absorb(response: Response): void {
    const issued = extractSessionCookie(response);
    const guestId = issued ? guestIdFromCookie(issued) : null;
    if (guestId) this.guestId = guestId;
  }

  request(url: string, options: { method?: string; body?: unknown } = {}): NextRequest {
    return makeRequest(url, { ...options, cookie: this.guestId });
  }
}
