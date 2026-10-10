/**
 * PKCE (RFC 7636), S256 only. `plain` is never accepted: the authorize step
 * refuses any other method, and nothing here compares a verifier to the
 * challenge directly. Pure.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** base64url of a sha256 digest, unpadded. */
const S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function isS256Challenge(value: unknown): value is string {
  return typeof value === 'string' && S256_CHALLENGE_RE.test(value);
}

export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function verifyS256(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier) || !isS256Challenge(challenge)) {
    return false;
  }
  const expected = Buffer.from(s256Challenge(verifier));
  const actual = Buffer.from(challenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
