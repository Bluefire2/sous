import { describe, expect, it } from 'vitest';
import {
  effectiveScopes,
  grantNeedsTouch,
  hashSecret,
  millisOf,
  readAuthCodeDoc,
  readGrantDoc,
  readTokenDoc,
} from './store.ts';

describe('millisOf', () => {
  it('reads a Firestore Timestamp, a Date, or a number', () => {
    expect(millisOf({ toMillis: () => 42 })).toBe(42);
    expect(millisOf(new Date(7))).toBe(7);
    expect(millisOf(9)).toBe(9);
    expect(millisOf('9')).toBeUndefined();
    expect(millisOf(null)).toBeUndefined();
  });
});

describe('document parsers', () => {
  it('read a token, refusing an unknown kind or a missing expiry', () => {
    const raw = { kind: 'access', sub: 's', grantId: 'g', scopes: ['recipes:read'], expireAt: new Date(100) };
    expect(readTokenDoc(raw)).toEqual({ kind: 'access', sub: 's', grantId: 'g', scopes: ['recipes:read'], expiresAt: 100 });
    expect(readTokenDoc({ ...raw, kind: 'id' })).toBeNull();
    expect(readTokenDoc({ ...raw, expireAt: undefined })).toBeNull();
    expect(readTokenDoc(undefined)).toBeNull();
    expect(readTokenDoc({ ...raw, rotatedAt: 50 })?.rotatedAt).toBe(50);
  });

  it('read an auth code with its use mark', () => {
    const raw = {
      sub: 's',
      grantId: 'g',
      clientId: 'https://claude.ai/x',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: 'c',
      scopes: ['recipes:read', 'recipes:write'],
      expireAt: { toMillis: () => 10 },
      usedAt: 5,
    };
    expect(readAuthCodeDoc(raw)).toMatchObject({ usedAt: 5, expiresAt: 10, scopes: ['recipes:read', 'recipes:write'] });
    expect(readAuthCodeDoc({ ...raw, codeChallenge: '' })).toBeNull();
  });

  it('read a grant, keeping revocation', () => {
    const raw = { clientId: 'https://claude.ai/x', clientHost: 'claude.ai', scopes: ['recipes:read'], email: 'a@b.c', createdAt: 1 };
    expect(readGrantDoc('g', raw)).toEqual({
      id: 'g',
      clientId: 'https://claude.ai/x',
      clientHost: 'claude.ai',
      scopes: ['recipes:read'],
      email: 'a@b.c',
      createdAt: 1,
    });
    expect(readGrantDoc('g', { ...raw, revokedAt: 3 })?.revokedAt).toBe(3);
    expect(readGrantDoc('g', { ...raw, email: undefined })).toBeNull();
  });
});

describe('effectiveScopes', () => {
  it('narrows a token to what its grant still allows', () => {
    const token = { kind: 'access' as const, sub: 's', grantId: 'g', scopes: ['recipes:read', 'recipes:write'] as const, expiresAt: 1 };
    const grant = { id: 'g', clientId: 'c', clientHost: 'h', scopes: ['recipes:read'] as const, email: '', createdAt: 0 };
    expect(effectiveScopes({ ...token, scopes: [...token.scopes] }, { ...grant, scopes: [...grant.scopes] })).toEqual([
      'recipes:read',
    ]);
  });
});

describe('grantNeedsTouch', () => {
  it('writes lastUsedAt at most once an hour', () => {
    const grant = { id: 'g', clientId: 'c', clientHost: 'h', scopes: [], email: '', createdAt: 0 };
    expect(grantNeedsTouch(grant, 10)).toBe(true);
    expect(grantNeedsTouch({ ...grant, lastUsedAt: 0 }, 59 * 60 * 1000)).toBe(false);
    expect(grantNeedsTouch({ ...grant, lastUsedAt: 0 }, 60 * 60 * 1000)).toBe(true);
  });
});

describe('hashSecret', () => {
  it('is a sha256 hex digest, so no raw secret names a document', () => {
    expect(hashSecret('sous_at_x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret('sous_at_x')).not.toBe(hashSecret('sous_at_y'));
  });
});
