import { randomBytes, createHash } from 'node:crypto';
import { canonicalize } from './canonical';

export { canonicalize };

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Cryptographically random 256-bit nonce, hex-encoded. */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Commitment = SHA-256(canonicalize({ manifest, nonce })).
 * The nonce prevents dictionary-guessing a small manifest space (PRD §14) and must be
 * kept private until verdict, at which point both manifest and nonce are revealed so
 * anyone can recompute this same hash.
 */
export function computeCommitment(manifest: unknown, nonce: string): string {
  return sha256Hex(canonicalize({ manifest, nonce }));
}

export function verifyCommitment(manifest: unknown, nonce: string, expectedHash: string): boolean {
  return computeCommitment(manifest, nonce) === expectedHash;
}
