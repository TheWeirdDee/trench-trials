import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * Guest identity (PRD §6/§15): a browser-level convenience, not proof of one human.
 *
 * The cookie carries an opaque random guest id plus an HMAC signature
 * (`v1.<guestId>.<sig>`), so the server only ever accepts identities it issued. It is
 * HttpOnly, SameSite=Lax, Secure in production and lasts a year. The database player
 * id never leaves the server.
 *
 * Reading the cookie never touches the database. A player row is created only by the
 * first intentional action (locking a blind pick) — see repo/attempts.ts — so page
 * views, bots and screenshot tools leave no rows behind.
 */

export const SESSION_COOKIE = 'tt_anon_id';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const VERSION = 'v1';
const GUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/;

let developmentSecret: string | null = null;

/** SESSION_SECRET (≥ 32 chars). Development falls back to a per-process key; production has no fallback. */
function signingSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === 'production') return null;
  if (!developmentSecret) {
    developmentSecret = randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET is not set: guest sessions use a temporary key and reset on restart (development only).');
  }
  return developmentSecret;
}

function signature(guestId: string, secret: string): string {
  return createHmac('sha256', secret).update(`trench-trials:session:${VERSION}:${guestId}`).digest('base64url');
}

export function generateGuestId(): string {
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  const uuid = randomUUID();
  return isTest ? `test-${uuid}` : uuid;
}

/** The signed cookie value for a guest id. Throws when no signing secret is configured. */
export function encodeSessionCookie(guestId: string): string {
  const secret = signingSecret();
  if (!secret) throw new Error('SESSION_SECRET must be set (at least 32 characters) in production');
  if (!GUEST_ID_PATTERN.test(guestId)) throw new Error('Invalid guest id');
  return `${VERSION}.${guestId}.${signature(guestId, secret)}`;
}

/** Verifies the cookie and returns its guest id, or null. Pure: no database access. */
export function readGuestId(req: NextRequest): string | null {
  const value = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = signingSecret();
  if (!value || !secret) return null;
  const [version, guestId, sig] = value.split('.');
  if (version !== VERSION || !guestId || !sig || !GUEST_ID_PATTERN.test(guestId)) return null;
  const expected = Buffer.from(signature(guestId, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return guestId;
}

export interface GuestIdentity {
  guestId: string;
  /** Set when this request issued the identity; must be written to the response. */
  newCookieValue: string | null;
}

/** The request's verified identity, or a freshly issued one (cookie to be set on the response). */
export function resolveOrIssueGuest(req: NextRequest): GuestIdentity {
  const existing = readGuestId(req);
  if (existing) return { guestId: existing, newCookieValue: null };
  const guestId = generateGuestId();
  return { guestId, newCookieValue: encodeSessionCookie(guestId) };
}

export function applySessionCookie(response: NextResponse, identity: GuestIdentity | null): void {
  if (!identity?.newCookieValue) return;
  response.cookies.set(SESSION_COOKIE, identity.newCookieValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
}
