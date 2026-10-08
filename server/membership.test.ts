import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as members from './members.ts';
import {
  accessDecision,
  cacheSizeForTest,
  clearMembershipCache,
  lookupMemberForTest,
  memberFromIdentity,
  readBoundedText,
  RequestBodyError,
  visitorMembership,
} from './membership.ts';
import { signSession } from './session.ts';
import { abortedRequest } from '../test/abortedBody.ts';
import { endlessBody } from '../test/endlessBody.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listProductionTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function productionSources(): string[] {
  const roots = [
    join(repoRoot, 'server'),
    join(repoRoot, 'api'),
    join(repoRoot, 'scripts'),
  ];
  return roots.flatMap((root) => listProductionTsFiles(root));
}

function relPath(abs: string): string {
  return relative(repoRoot, abs).replace(/\\/g, '/');
}

function countWordOccurrences(text: string, word: string): number {
  const re = new RegExp(`\\b${word}\\b`, 'g');
  return [...text.matchAll(re)].length;
}

const PRODUCTION_SCAN_MUST_INCLUDE = [
  'api/chat.ts',
  'api/import.ts',
  'server/membership.ts',
  'server/session.ts',
  'server/auth.ts',
  'scripts/server.ts',
] as const;

function expectProductionScanReady(sources: string[]): string[] {
  expect(sources.length).toBeGreaterThan(0);
  const rels = sources.map(relPath);
  for (const must of PRODUCTION_SCAN_MUST_INCLUDE) {
    expect(rels, `production scan missing ${must}`).toContain(must);
  }
  return rels;
}

describe('accessDecision', () => {
  const activeMember: members.MemberRecord = {
    sub: 'm-sub',
    status: 'active',
    approvedAt: 1,
    approvedBy: 'owner',
  };

  it('denies when ALLOWED_EMAILS is blank and there is no member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: '',
        member: null,
      }),
    ).toBe('denied');
  });

  it('denies when ALLOWED_EMAILS is whitespace only and there is no member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: '  ,  ',
        member: null,
      }),
    ).toBe('denied');
  });

  it('denies unverified email even with active member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: false,
        allowedRaw: 'owner@example.com',
        member: activeMember,
      }),
    ).toBe('denied');
  });

  it('denies blank email for non-owner', () => {
    expect(
      accessDecision({
        email: '',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: null,
      }),
    ).toBe('denied');
  });

  it('denies revoked member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: { ...activeMember, status: 'revoked' },
      }),
    ).toBe('denied');
  });

  it('denies non-owner with null member', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: null,
      }),
    ).toBe('denied');
  });

  it('owner with null member', () => {
    expect(
      accessDecision({
        email: 'owner@example.com',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: null,
      }),
    ).toBe('owner');
  });

  it('member when parser output is active', () => {
    expect(
      accessDecision({
        email: 'a@example.com',
        emailVerified: true,
        allowedRaw: 'owner@example.com',
        member: activeMember,
      }),
    ).toBe('member');
  });
});

describe('membership cache', () => {
  const sub = 'cache-sub';
  const active: members.MemberRecord = {
    sub,
    status: 'active',
    approvedAt: 100,
    approvedBy: 'owner',
  };

  beforeEach(() => {
    clearMembershipCache(sub);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads Firestore once for two lookups within 60s', async () => {
    const spy = vi.spyOn(members, 'readMember').mockResolvedValue(active);
    const t0 = 1_000_000;
    await lookupMemberForTest(sub, t0);
    await lookupMemberForTest(sub, t0 + 30_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-reads after 60s', async () => {
    const spy = vi.spyOn(members, 'readMember').mockResolvedValue(active);
    const t0 = 1_000_000;
    await lookupMemberForTest(sub, t0);
    await lookupMemberForTest(sub, t0 + 60_001);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('admits revoked member until TTL then re-reads revoked status', async () => {
    vi.spyOn(members, 'readMember')
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ ...active, status: 'revoked' });
    const t0 = 2_000_000;
    expect((await lookupMemberForTest(sub, t0))?.status).toBe('active');
    expect((await lookupMemberForTest(sub, t0 + 1_000))?.status).toBe('active');
    expect((await lookupMemberForTest(sub, t0 + 60_001))?.status).toBe('revoked');
  });

  it('re-reads immediately after approval when nothing negative was cached', async () => {
    vi.spyOn(members, 'readMember')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(active);
    const t0 = 3_000_000;
    expect(await lookupMemberForTest(sub, t0)).toBeNull();
    expect(cacheSizeForTest()).toBe(0);
    const second = await lookupMemberForTest(sub, t0 + 1);
    expect(second?.status).toBe('active');
  });

  it('accessAllows returns unknown on throw without caching', async () => {
    const { accessAllows } = await import('./membership.ts');
    const spy = vi
      .spyOn(members, 'readMember')
      .mockRejectedValueOnce(new Error('firestore down'))
      .mockResolvedValueOnce(active);
    expect(
      await accessAllows({ sub, email: 'm@example.com', emailVerified: true }),
    ).toBe('unknown');
    expect(cacheSizeForTest()).toBe(0);
    expect(await accessAllows({ sub, email: 'm@example.com', emailVerified: true })).toBe(
      'member',
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('visitorMembership', () => {
  const sub = 'visitor-sub';

  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-for-visitor-membership';
    process.env.ALLOWED_EMAILS = 'owner@example.com';
    clearMembershipCache(sub);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withCookie(cookie?: string): Request {
    return new Request('http://localhost/c/join', {
      headers: cookie === undefined ? {} : { cookie },
    });
  }

  it('no cookie or an unusable cookie is signed out, without a member read', async () => {
    const spy = vi.spyOn(members, 'readMember');
    expect(await visitorMembership(withCookie())).toEqual({ kind: 'signedOut' });
    expect(await visitorMembership(withCookie('sous_session=garbage.garbage'))).toEqual({
      kind: 'signedOut',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a valid session that is not admitted is denied with its identity', async () => {
    vi.spyOn(members, 'readMember').mockResolvedValue(null);
    const token = signSession({ sub, email: 'stranger@example.com' }, Date.now());
    expect(await visitorMembership(withCookie(`sous_session=${token}`))).toEqual({
      kind: 'denied',
      sub,
      email: 'stranger@example.com',
    });
  });

  it('a Firestore failure is unknown, never denied', async () => {
    vi.spyOn(members, 'readMember').mockRejectedValue(new Error('down'));
    const token = signSession({ sub, email: 'm@example.com' }, Date.now());
    expect(await visitorMembership(withCookie(`sous_session=${token}`))).toEqual({
      kind: 'unknown',
    });
  });

  it('an owner short-circuits; an active member is ok', async () => {
    const owner = signSession({ sub: 'owner-sub', email: 'owner@example.com' }, Date.now());
    expect(await visitorMembership(withCookie(`sous_session=${owner}`))).toEqual({
      kind: 'ok',
      sub: 'owner-sub',
      email: 'owner@example.com',
      isOwner: true,
    });
    vi.spyOn(members, 'readMember').mockResolvedValue({
      sub,
      status: 'active',
      approvedAt: 1,
      approvedBy: 'owner',
    });
    const token = signSession({ sub, email: 'm@example.com' }, Date.now());
    expect(await visitorMembership(withCookie(`sous_session=${token}`))).toEqual({
      kind: 'ok',
      sub,
      email: 'm@example.com',
      isOwner: false,
    });
  });
});

describe('memberFromIdentity', () => {
  const sub = 'identity-sub';

  beforeEach(() => {
    process.env.ALLOWED_EMAILS = 'owner@example.com';
    clearMembershipCache(sub);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an owner short-circuits without a member read', async () => {
    const spy = vi.spyOn(members, 'readMember');
    expect(await memberFromIdentity({ sub: 'owner-sub', email: 'Owner@Example.com' })).toEqual({
      kind: 'ok',
      sub: 'owner-sub',
      email: 'Owner@Example.com',
      isOwner: true,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('an active member is ok, a missing or revoked one denied, a throw unknown', async () => {
    const spy = vi
      .spyOn(members, 'readMember')
      .mockResolvedValueOnce({ sub, status: 'active', approvedAt: 1, approvedBy: 'owner' });
    expect(await memberFromIdentity({ sub, email: 'm@example.com' })).toEqual({
      kind: 'ok',
      sub,
      email: 'm@example.com',
      isOwner: false,
    });
    clearMembershipCache(sub);
    spy.mockResolvedValueOnce(null);
    expect(await memberFromIdentity({ sub, email: 'm@example.com' })).toEqual({ kind: 'denied' });
    spy.mockResolvedValueOnce({ sub, status: 'revoked', approvedAt: 1, approvedBy: 'owner' });
    expect(await memberFromIdentity({ sub, email: 'm@example.com' })).toEqual({ kind: 'denied' });
    spy.mockRejectedValueOnce(new Error('down'));
    expect(await memberFromIdentity({ sub, email: 'm@example.com' })).toEqual({ kind: 'unknown' });
  });
});

describe('readBoundedText', () => {
  it('reads the body as text, and null past the limit', async () => {
    const post = (body: string) => new Request('http://localhost/', { method: 'POST', body });
    expect(await readBoundedText(post('{"a":1}'), 100)).toBe('{"a":1}');
    expect(await readBoundedText(post('x'.repeat(101)), 100)).toBeNull();
  });

  it('throws a RequestBodyError that drops the original when the client hangs up mid-upload', async () => {
    const err = await readBoundedText(abortedRequest('http://localhost/'), 1_000_000).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RequestBodyError);
    expect(err).toMatchObject({ name: 'RequestBodyError', message: 'Request body could not be read' });
    expect((err as Error).cause).toBeUndefined();
    expect(String(err)).not.toContain('SECRET');
  });

  it('refuses a declared Content-Length over the limit without reading', async () => {
    const endless = endlessBody();
    const req = new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'Content-Length': '6' },
      body: endless.body,
      duplex: 'half',
    } as RequestInit);
    expect(await readBoundedText(req, 5)).toBeNull();
    expect(endless.cancelled()).toBe(false);
  });

  it('stops reading past the limit and leaves the rest unlocked, not cancelled', async () => {
    const endless = endlessBody();
    const req = new Request('http://localhost/api/x', {
      method: 'POST',
      body: endless.body,
      duplex: 'half',
    } as RequestInit);
    expect(await readBoundedText(req, 100_000)).toBeNull();
    // Cancelling would abort the request under the 413; the dispatcher drops the rest.
    expect(endless.cancelled()).toBe(false);
    expect(req.body?.locked).toBe(false);
    expect(endless.read()).toBeLessThan(100_000 + 256 * 1024);
  });
});

describe('architecture lock', () => {
  it('assertion 1: readSession referenced only in session, membership, auth', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    const allowed = new Set(['server/session.ts', 'server/membership.ts', 'server/auth.ts']);
    for (const must of allowed) {
      const text = readFileSync(join(repoRoot, must), 'utf8');
      expect(/\breadSession\b/.test(text), `${must} must reference readSession`).toBe(true);
    }
    for (const file of sources) {
      const rel = relPath(file);
      const text = readFileSync(file, 'utf8');
      if (!/\breadSession\b/.test(text)) {
        continue;
      }
      expect(allowed.has(rel), `readSession in unexpected file ${rel}`).toBe(true);
    }
  });

  it('assertion 3: api chat/import have no @google-cloud', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    for (const rel of ['api/chat.ts', 'api/import.ts'] as const) {
      const text = readFileSync(join(repoRoot, rel), 'utf8');
      expect(text.includes('@google-cloud'), rel).toBe(false);
    }
  });

  it('assertion 4: x-sous-user appears nowhere in production sources', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes('x-sous-user'), relPath(file)).toBe(false);
    }
  });

  it('assertion 2: sessionFrom appears nowhere in production sources', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(/\bsessionFrom\b/.test(text), relPath(file)).toBe(false);
    }
  });

  it('assertion 5: chat/import handlers wrapped with withMembership', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    const serverTs = readFileSync(join(repoRoot, 'scripts/server.ts'), 'utf8');
    // Chat reads the kitchen profile inside the gate, so the gate still runs first.
    expect(serverTs.includes('withMembership(withKitchenProfile(chatPost))')).toBe(true);
    expect(serverTs.includes('withMembership(importPost)')).toBe(true);
    expect(serverTs.includes('withMembership(kitchenProfileGet)')).toBe(true);
    expect(serverTs.includes('withMembership(kitchenProfilePost)')).toBe(true);
    expect(serverTs.includes('handler: kitchenProfile')).toBe(false);
    expect(serverTs.includes('handler: withKitchenProfile')).toBe(false);
    expect(serverTs.includes('handler: chatPost')).toBe(false);
    expect(serverTs.includes('handler: importPost')).toBe(false);
    expect(serverTs.includes('withMembership(importFeedbackPost)')).toBe(true);
    expect(serverTs.includes('handler: importFeedbackPost')).toBe(false);
    expect(serverTs.includes('withMembership(featureRequestPost)')).toBe(true);
    expect(serverTs.includes('handler: featureRequestPost')).toBe(false);
  });

  // api/import.ts is a 401 stub; Cloud Run's import route (server/importRoute.ts)
  // has no session fallback to bypass. Its one use of authorizedSub copies the
  // sub onto the import log line (server/importLog.ts) and never decides
  // access; a second use fails this count. The import feedback route
  // (server/importFeedback.ts) reads it once, after withMembership decided
  // access, to name the report's sender and its log line; it never decides
  // access either. The feature request route (server/featureRequest.ts) does
  // the same for a suggestion. The kitchen profile (server/kitchenProfile.ts)
  // reads it in its GET and POST handlers and in the chat wrapper, all behind
  // withMembership, only to name whose profile to read or write.
  it('assertion 6: authorizedSub in exactly six files with fixed counts', () => {
    const sources = productionSources();
    expectProductionScanReady(sources);
    const expectedCounts: Record<string, number> = {
      'api/chat.ts': 5,
      'server/featureRequest.ts': 1,
      'server/importFeedback.ts': 1,
      'server/kitchenProfile.ts': 3,
      'server/importRoute.ts': 1,
      'server/membership.ts': 2,
    };
    const allowed = new Set(Object.keys(expectedCounts));
    const found = new Map<string, number>();

    for (const file of sources) {
      const rel = relPath(file);
      const count = countWordOccurrences(readFileSync(file, 'utf8'), 'authorizedSub');
      if (count === 0) {
        continue;
      }
      expect(allowed.has(rel), `authorizedSub in unexpected file ${rel}`).toBe(true);
      found.set(rel, count);
    }

    for (const [rel, expected] of Object.entries(expectedCounts)) {
      expect(found.get(rel), `${rel} must contain authorizedSub`).toBe(expected);
    }
    expect(found.size).toBe(allowed.size);
  });
});
