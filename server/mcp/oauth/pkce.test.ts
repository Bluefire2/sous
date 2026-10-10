import { describe, expect, it } from 'vitest';
import { isS256Challenge, s256Challenge, verifyS256 } from './pkce.ts';

// RFC 7636 Appendix B.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('verifyS256', () => {
  it('matches the RFC 7636 Appendix B vector', () => {
    expect(s256Challenge(VERIFIER)).toBe(CHALLENGE);
    expect(verifyS256(VERIFIER, CHALLENGE)).toBe(true);
  });

  it('rejects plain (the verifier presented as its own challenge)', () => {
    expect(verifyS256(VERIFIER, VERIFIER)).toBe(false);
  });

  it('rejects a wrong, short, or non-string verifier', () => {
    expect(verifyS256(`${VERIFIER.slice(0, -1)}A`, CHALLENGE)).toBe(false);
    expect(verifyS256('short', s256Challenge('short'))).toBe(false);
    expect(verifyS256(undefined, CHALLENGE)).toBe(false);
    expect(verifyS256(`${VERIFIER}!`, CHALLENGE)).toBe(false);
  });

  it('recognises only a 43-character base64url challenge', () => {
    expect(isS256Challenge(CHALLENGE)).toBe(true);
    expect(isS256Challenge(`${CHALLENGE}=`)).toBe(false);
    expect(isS256Challenge('abc')).toBe(false);
    expect(isS256Challenge(null)).toBe(false);
  });
});
