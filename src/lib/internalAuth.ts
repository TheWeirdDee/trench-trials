import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Internal generation/resolution/usage routes are not meant for browsers. Gated by a
 * shared secret (CRON_SECRET) rather than the player session cookie. Fails closed if
 * the secret isn't configured — an unconfigured secret must never mean "open".
 */
export function isAuthorizedInternalRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const provided =
    req.headers.get('x-internal-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    null;
  if (!provided) return false;

  // Constant-time comparison of fixed-length digests, so response timing reveals nothing about the secret.
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(provided), digest(secret));
}
