import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  computeCommitment,
  generateNonce,
  sha256Hex,
  verifyCommitment,
} from '@/lib/domain/commitment';

describe('canonicalize', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('preserves array order (arrays are not sorted)', () => {
    expect(canonicalize({ x: [3, 1, 2] })).toBe(canonicalize({ x: [3, 1, 2] }));
    expect(canonicalize({ x: [3, 1, 2] })).not.toBe(canonicalize({ x: [1, 2, 3] }));
  });
});

describe('sha256Hex', () => {
  it('matches a known SHA-256 vector', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches a known SHA-256 vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('generateNonce', () => {
  it('produces a 64-char hex string (256 bits) and is not deterministic', () => {
    const n1 = generateNonce();
    const n2 = generateNonce();
    expect(n1).toMatch(/^[0-9a-f]{64}$/);
    expect(n1).not.toBe(n2);
  });
});

describe('computeCommitment / verifyCommitment', () => {
  const manifest = {
    round_id: 'round-001',
    slots: { A: 'POPCAT', B: 'YZY', C: 'BOME' },
    cutoff: '2026-08-20T00:00:00Z',
  };

  it('is deterministic for the same manifest and nonce', () => {
    const nonce = generateNonce();
    expect(computeCommitment(manifest, nonce)).toBe(computeCommitment(manifest, nonce));
  });

  it('changes if the manifest changes (tamper detection)', () => {
    const nonce = generateNonce();
    const tampered = { ...manifest, slots: { A: 'BOME', B: 'YZY', C: 'POPCAT' } };
    expect(computeCommitment(manifest, nonce)).not.toBe(computeCommitment(tampered, nonce));
  });

  it('changes if the nonce changes', () => {
    expect(computeCommitment(manifest, generateNonce())).not.toBe(
      computeCommitment(manifest, generateNonce()),
    );
  });

  it('verifyCommitment accepts the correct manifest+nonce and rejects tampering', () => {
    const nonce = generateNonce();
    const hash = computeCommitment(manifest, nonce);
    expect(verifyCommitment(manifest, nonce, hash)).toBe(true);
    expect(verifyCommitment({ ...manifest, cutoff: 'tampered' }, nonce, hash)).toBe(false);
    expect(verifyCommitment(manifest, generateNonce(), hash)).toBe(false);
  });
});
