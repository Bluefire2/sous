import { beforeEach, describe, expect, it } from 'vitest';
import { FULL_COOK_LOG, FULL_COOK_LOG_UNCOMPACTED } from '../test/cookLogFixtures.ts';
import { SESSION_COOKIE_NAME, signSession } from './session.ts';
import {
  encodeSharedCursor,
  SHARED_SNAPSHOT_CHANGED_ERROR,
  SHARED_SNAPSHOT_CHANGED_STATUS,
} from './sharedPull.ts';
import { planCollectionGrantDelete } from './grants.ts';
import {
  applyPushOp,
  docToChange,
  STORE_KINDS,
  syncPull,
  syncPush,
  syncSharedPull,
} from './sync.ts';
import {
  compareMutation,
  decodePullCursor,
  encodePullCursor,
  isKnownPushKind,
  validatePushOp,
} from './store.ts';
import { endlessBody } from '../test/endlessBody.ts';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
  process.env.ALLOWED_EMAILS = 'allowed@example.com';
  process.env.PUBLIC_ORIGIN = 'http://localhost:5173';
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
});

describe('cursor helpers', () => {
  it('round-trips', () => {
    const c = {
      chatMessages: [50, '22222222-2222-4222-8222-222222222222'] as [number, string],
    };
    expect(decodePullCursor(encodePullCursor(c))).toEqual(c);
  });
});

describe('validatePushOp', () => {
  it('rejects missing id on recipe.put', () => {
    expect(
      validatePushOp({
        kind: 'recipe.put',
        payload: { title: 'x', servings: 1, ingredientSections: [], steps: [], tags: [], createdAt: 1, updatedAt: 1 },
      }).ok,
    ).toBe(false);
  });
});

describe('compareMutation ordering', () => {
  it('prefers newer puts', () => {
    expect(compareMutation({ updatedAt: 3 }, 5, 'put').allow).toBe(true);
    expect(compareMutation({ updatedAt: 7 }, 5, 'put').allow).toBe(false);
  });
});

describe('syncPush ignores body uid', () => {
  it('returns 401 without session', async () => {
    const res = await syncPush(
      new Request('http://localhost/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: [], uid: 'someone-else' }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('syncPush body size', () => {
  function ownerRequest(body: string | ReadableStream<Uint8Array>): Request {
    const token = signSession({ sub: 'owner-sub', email: 'allowed@example.com' }, Date.now());
    return new Request('http://localhost/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${token}` },
      body,
      duplex: 'half',
    } as RequestInit);
  }

  it('answers 413 and stops reading a body over the limit', async () => {
    const endless = endlessBody();
    const res = await syncPush(ownerRequest(endless.body));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Payload too large; batch your ops' });
    expect(endless.cancelled()).toBe(false);
    expect(endless.read()).toBeLessThan(4_000_000);
  });

  it('still answers 413 past a million characters', async () => {
    const res = await syncPush(ownerRequest(JSON.stringify({ ops: [], pad: 'x'.repeat(1_000_000) })));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Payload too large; batch your ops' });
  });

  it('measures the limit in characters, so multibyte text under it is not too large', async () => {
    // About 1.2 MB of UTF-8 in 600 000 characters; 51 ops stops it before the store.
    const raw = JSON.stringify({ ops: Array.from({ length: 51 }, () => null), pad: 'ж'.repeat(600_000) });
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(1_000_000);
    const res = await syncPush(ownerRequest(raw));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Too many ops; batch your requests' });
  });
});

describe('applyPushOp unknown kind', () => {
  it('returns unknown', async () => {
    const result = await applyPushOp('sub-1', { kind: 'photo.put', payload: {} });
    expect(result).toEqual({ applied: false, reason: 'unknown' });
  });
});

describe('applyPushOp cook log ops', () => {
  it('are known kinds', () => {
    expect(isKnownPushKind('cookLog.put')).toBe(true);
    expect(isKnownPushKind('cookLog.delete')).toBe(true);
  });

  it('rejects an invalid cookLog.put before touching the store', async () => {
    const result = await applyPushOp('sub-1', {
      kind: 'cookLog.put',
      payload: { ...FULL_COOK_LOG, cookedOn: '2026-02-30' },
    });
    expect(result).toEqual({ applied: false, reason: 'invalid' });
  });

  it('rejects an invalid cookLog.delete before touching the store', async () => {
    const result = await applyPushOp('sub-1', {
      kind: 'cookLog.delete',
      payload: { id: FULL_COOK_LOG.id },
    });
    expect(result).toEqual({ applied: false, reason: 'invalid' });
  });
});

describe('pull kinds', () => {
  it('pulls every store kind, including cookLogs', () => {
    expect(STORE_KINDS).toEqual([
      'recipes',
      'chatMessages',
      'cookState',
      'photos',
      'collections',
      'cookLogs',
    ]);
  });

  it('compacts a live cook log doc and strips server fields', () => {
    expect(
      docToChange('cookLogs', { ...FULL_COOK_LOG_UNCOMPACTED, serverUpdatedAt: 9 }),
    ).toEqual(FULL_COOK_LOG);
  });

  it('returns a cook log tombstone as id and deletedAt', () => {
    expect(
      docToChange('cookLogs', { id: 'l1', updatedAt: 5, deletedAt: 5, serverUpdatedAt: 9 }),
    ).toEqual({ id: 'l1', deletedAt: 5 });
  });
});

describe('syncPull unauthorized', () => {
  it('returns 401 without cookie', async () => {
    const res = await syncPull(new Request('http://localhost/api/sync/pull'));
    expect(res.status).toBe(401);
  });
});

describe('planCollectionGrantDelete', () => {
  it('applies a delete of a live collection without using the client clock as the cascade', () => {
    expect(planCollectionGrantDelete({ updatedAt: 50 }, 100)).toEqual({ kind: 'apply' });
    expect(planCollectionGrantDelete({ updatedAt: 100, deletedAt: null }, 100)).toEqual({
      kind: 'apply',
    });
  });

  it('heals a canonical tombstone at its stored grantCascadeAt', () => {
    expect(
      planCollectionGrantDelete(
        { updatedAt: 200, deletedAt: 200, grantCascadeAt: 900 },
        100,
      ),
    ).toEqual({ kind: 'heal', grantCascadeAt: 900, writeCollection: false });
    expect(
      planCollectionGrantDelete(
        { updatedAt: 100, deletedAt: 100, grantCascadeAt: 900 },
        100,
      ),
    ).toEqual({ kind: 'heal', grantCascadeAt: 900, writeCollection: true });
  });

  it('does not revoke a newer live collection', () => {
    expect(planCollectionGrantDelete({ updatedAt: 200 }, 100)).toEqual({ kind: 'reject' });
  });

  it('does not revoke a missing or malformed collection and does not fall back to the client clock', () => {
    expect(planCollectionGrantDelete(undefined, 100)).toEqual({ kind: 'tombstone-only' });
    expect(planCollectionGrantDelete({}, 100)).toEqual({ kind: 'tombstone-only' });
    expect(planCollectionGrantDelete({ updatedAt: 50, deletedAt: 40 }, 100)).toEqual({
      kind: 'tombstone-only',
    });
    expect(planCollectionGrantDelete({ updatedAt: 200, deletedAt: 199 }, 100)).toEqual({
      kind: 'reject',
    });
    expect(planCollectionGrantDelete({ updatedAt: 200, deletedAt: 200 }, 100)).toEqual({
      kind: 'reject',
    });
  });
});

describe('syncSharedPull snapshot change', () => {
  function memberRequest(url: string): Request {
    const token = signSession(
      { sub: 'owner-sub', email: 'allowed@example.com' },
      Date.now(),
    );
    return new Request(url, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
  }

  async function expectRestart(cursor: string): Promise<void> {
    const res = await syncSharedPull(
      memberRequest(
        `http://localhost/api/sync/shared?cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    expect(res.status).toBe(SHARED_SNAPSHOT_CHANGED_STATUS);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(await res.json()).toEqual({ error: SHARED_SNAPSHOT_CHANGED_ERROR });
  }

  it('returns 401 without a session', async () => {
    const res = await syncSharedPull(new Request('http://localhost/api/sync/shared'));
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned positional cursor and a cursor for another viewer', async () => {
    const legacy = Buffer.from(
      JSON.stringify({ grantId: 'grant-a', recipeId: 'recipe-9' }),
      'utf8',
    ).toString('base64url');
    await expectRestart(legacy);
    await expectRestart('%%%');
    await expectRestart(
      encodeSharedCursor({
        v: 1,
        viewerSub: 'someone-else',
        generation: 'generation',
        grantId: 'grant-a',
        recipeId: 'recipe-9',
      }),
    );
    const token = encodeSharedCursor({
      v: 1,
      viewerSub: 'owner-sub',
      generation: 'generation',
      grantId: 'grant-a',
      recipeId: 'recipe-1',
    });
    const [payload, signature] = token.split('.');
    const swapped = encodeSharedCursor({
      v: 1,
      viewerSub: 'owner-sub',
      generation: 'generation',
      grantId: 'grant-b',
      recipeId: 'recipe-secret',
    });
    await expectRestart(`${payload}.${swapped.split('.')[1]}`);
    await expectRestart(`${payload}.${signature.slice(0, -1)}x`);
  });
});
