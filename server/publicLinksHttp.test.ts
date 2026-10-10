import { describe, expect, it, vi } from 'vitest';
import type { PublicJoinOutcome } from './publicJoin.ts';
import { hashPublicToken, type PublicLinkRecord } from './publicLinks.ts';
import type { RecipeLinkRecord } from './recipeLinks.ts';
import {
  collectionIdFromPublicPath,
  handlePublicGet,
  handlePublicJoinPost,
  handlePublicLinkGet,
  handlePublicLinkPost,
  handlePublicLinkRevokePost,
  type PublicJoinDependencies,
  type PublicOwnerDependencies,
  type PublicVisitorDependencies,
} from './publicLinksHttp.ts';

const ORIGIN = 'https://sous.example';
const now = 1_700_000_000_000;
const token = 'P'.repeat(43);
const ownerSub = 'owner-sub';
const collectionId = '11111111-1111-4111-8111-111111111111';
const recipeId = '22222222-2222-4222-8222-222222222222';
const photoId = '55555555-5555-4555-8555-555555555555';

function link(overrides: Partial<PublicLinkRecord> = {}): PublicLinkRecord {
  return {
    ownerSub,
    ownerEmail: 'owner@example.com',
    collectionId,
    token,
    status: 'live',
    createdAt: now - 1,
    ...overrides,
  };
}

function visitorDeps(overrides: Partial<PublicVisitorDependencies> = {}) {
  const photoResponse = vi.fn(
    async () =>
      new Response('bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' },
      }),
  );
  const deps: PublicVisitorDependencies = {
    readLink: async (id) => (id === hashPublicToken(token) ? link() : null),
    ownerAdmitted: async () => true,
    readCollection: async () => ({ id: collectionId, name: 'Soups', recipeIds: [recipeId] }),
    readRecipes: async (_sub, ids) =>
      ids.map((id) => ({
        id,
        title: 'Soup',
        servings: 2,
        ingredientSections: [],
        steps: [],
        tags: [],
        photoId,
        createdAt: 1,
        updatedAt: 2,
      })),
    readRecipeLink: async () => null,
    readRecipe: async () => undefined,
    photoResponse,
    ...overrides,
  };
  return { deps, photoResponse };
}

const recipeToken = 'R'.repeat(43);

function recipeLink(overrides: Partial<RecipeLinkRecord> = {}): RecipeLinkRecord {
  return {
    ownerSub,
    ownerEmail: 'owner@example.com',
    ownerName: 'Ada',
    recipeId,
    token: recipeToken,
    status: 'live',
    createdAt: now - 1,
    ...overrides,
  };
}

function recipeVisitorDeps(overrides: Partial<PublicVisitorDependencies> = {}) {
  return visitorDeps({
    readLink: async () => null,
    readRecipeLink: async (id) => (id === hashPublicToken(recipeToken) ? recipeLink() : null),
    readRecipe: async (_sub, id) => ({
      id,
      title: 'Soup',
      servings: 2,
      ingredientSections: [],
      steps: [],
      tags: [],
      photoId,
      notes: 'Salt late.',
      importCheck: { at: 1, warnings: [] },
      savedFrom: { name: 'Eve', savedAt: 1 },
      createdAt: 1,
      updatedAt: 2,
    }),
    ...overrides,
  });
}

describe('handlePublicGet for a recipe link', () => {
  it('serves the recipe and the display name under the visitor headers', async () => {
    const res = await handlePublicGet(
      get(`/api/public/${recipeToken}`),
      recipeVisitorDeps().deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe('recipe');
    expect(body.sharedBy).toBe('Ada');
    expect(JSON.stringify(body)).not.toContain('owner@example.com');
    const recipe = body.recipe as Record<string, unknown>;
    expect(recipe.notes).toBe('Salt late.');
    expect(recipe).not.toHaveProperty('importCheck');
    expect(recipe).not.toHaveProperty('savedFrom');
  });

  it('prefers a collection link and labels its body', async () => {
    const res = await handlePublicGet(get(`/api/public/${token}`), visitorDeps().deps);
    expect(((await res.json()) as { kind: string }).kind).toBe('collection');
  });

  it('answers the generic 404 for a revoked link, an unadmitted owner, or a deleted recipe', async () => {
    for (const overrides of [
      { readRecipeLink: async () => recipeLink({ status: 'revoked' as const }) },
      { ownerAdmitted: async () => false },
      { readRecipe: async () => ({ id: recipeId, deletedAt: 5 }) },
      { readRecipe: async () => undefined },
    ] satisfies Partial<PublicVisitorDependencies>[]) {
      const res = await handlePublicGet(
        get(`/api/public/${recipeToken}`),
        recipeVisitorDeps(overrides).deps,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found', code: 'not-found' });
    }
  });

  it("streams the link recipe's photo and nothing else", async () => {
    const { deps, photoResponse } = recipeVisitorDeps();
    const ok = await handlePublicGet(
      get(`/api/public/${recipeToken}/recipes/${recipeId}/photos/${photoId}`),
      deps,
    );
    expect(ok.status).toBe(200);
    expect(photoResponse).toHaveBeenCalledWith(ownerSub, photoId, 'GET');
    const otherRecipe = '77777777-7777-4777-8777-777777777777';
    const otherPhoto = '66666666-6666-4666-8666-666666666666';
    for (const path of [
      `/api/public/${recipeToken}/recipes/${otherRecipe}/photos/${photoId}`,
      `/api/public/${recipeToken}/recipes/${recipeId}/photos/${otherPhoto}`,
    ]) {
      const res = await handlePublicGet(get(path), deps);
      expect(res.status, path).toBe(404);
    }
    expect(photoResponse).toHaveBeenCalledTimes(1);
  });
});

function get(path: string, method = 'GET'): Request {
  return new Request(`${ORIGIN}${path}`, { method });
}

describe('handlePublicGet', () => {
  it('serves the snapshot with no-store, no-referrer, and noindex', async () => {
    const res = await handlePublicGet(get(`/api/public/${token}`), visitorDeps().deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    const body = (await res.json()) as { collection: unknown; recipes: { id: string }[] };
    expect(body.collection).toEqual({ id: collectionId, name: 'Soups' });
    expect(body.recipes.map((r) => r.id)).toEqual([recipeId]);
  });

  it('answers one generic 404 for a dead or malformed link', async () => {
    const { deps } = visitorDeps({ readLink: async () => null });
    for (const path of [`/api/public/${token}`, '/api/public/nope', `/api/public/${token}/x`]) {
      const res = await handlePublicGet(get(path), deps);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found', code: 'not-found' });
    }
  });

  it('answers 503 when the owner membership is unknown', async () => {
    const { deps } = visitorDeps({
      ownerAdmitted: async () => {
        throw new Error('unavailable');
      },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handlePublicGet(get(`/api/public/${token}`), deps);
    expect(res.status).toBe(503);
    // Only the error's class name is logged, never a message that could quote the URL.
    expect(spy.mock.calls.flat().join(' ')).not.toContain(token);
    spy.mockRestore();
  });

  it('streams a listed photo from the owner tree with visitor headers', async () => {
    const { deps, photoResponse } = visitorDeps();
    const res = await handlePublicGet(
      get(`/api/public/${token}/recipes/${recipeId}/photos/${photoId}`, 'HEAD'),
      deps,
    );
    expect(res.status).toBe(200);
    expect(photoResponse).toHaveBeenCalledWith(ownerSub, photoId, 'HEAD');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('never streams a photo the recipe does not list', async () => {
    const { deps, photoResponse } = visitorDeps();
    const other = '66666666-6666-4666-8666-666666666666';
    const res = await handlePublicGet(
      get(`/api/public/${token}/recipes/${recipeId}/photos/${other}`),
      deps,
    );
    expect(res.status).toBe(404);
    expect(photoResponse).not.toHaveBeenCalled();
  });
});

function joinDeps(overrides: Partial<PublicJoinDependencies> = {}) {
  const join = vi.fn(
    async (): Promise<PublicJoinOutcome> => ({ kind: 'write', collectionId }),
  );
  const deps: PublicJoinDependencies = {
    requireMember: async () => ({
      kind: 'ok',
      sub: 'member-sub',
      email: 'member@example.com',
      isOwner: false,
    }),
    readLink: async (id) => (id === hashPublicToken(token) ? link() : null),
    ownerAdmitted: async () => true,
    join,
    ...overrides,
  };
  return { deps, join: (overrides.join as typeof join | undefined) ?? join };
}

function joinRequest(body: unknown): Request {
  return new Request(`${ORIGIN}/api/public/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('handlePublicJoinPost', () => {
  it('needs an admitted member: 401 denied, 503 unknown', async () => {
    const denied = joinDeps({ requireMember: async () => ({ kind: 'denied' }) });
    expect((await handlePublicJoinPost(joinRequest({ token }), denied.deps)).status).toBe(401);
    const unknown = joinDeps({ requireMember: async () => ({ kind: 'unknown' }) });
    expect((await handlePublicJoinPost(joinRequest({ token }), unknown.deps)).status).toBe(503);
    expect(denied.join).not.toHaveBeenCalled();
  });

  it('rejects a body without a token', async () => {
    const { deps, join } = joinDeps();
    expect((await handlePublicJoinPost(joinRequest({}), deps)).status).toBe(400);
    expect((await handlePublicJoinPost(joinRequest({ token: 'x' }), deps)).status).toBe(400);
    expect(join).not.toHaveBeenCalled();
  });

  it('maps outcomes to a result the client can act on', async () => {
    const cases: Array<[PublicJoinOutcome, number, unknown]> = [
      [{ kind: 'write', collectionId }, 200, { collectionId, result: 'joined' }],
      [{ kind: 'idempotent', collectionId }, 200, { collectionId, result: 'already' }],
      [{ kind: 'self', collectionId }, 200, { collectionId, result: 'own' }],
      [{ kind: 'dead' }, 404, { error: 'Not found', code: 'not-found' }],
    ];
    for (const [outcome, status, body] of cases) {
      const { deps } = joinDeps({ join: vi.fn(async () => outcome) });
      const res = await handlePublicJoinPost(joinRequest({ token }), deps);
      expect(res.status, outcome.kind).toBe(status);
      expect(await res.json()).toEqual(body);
    }
    const { deps } = joinDeps({ join: vi.fn(async () => ({ kind: 'cap', collectionId }) as const) });
    const full = await handlePublicJoinPost(joinRequest({ token }), deps);
    expect(full.status).toBe(409);
    expect(((await full.json()) as { code: string }).code).toBe('share-full');
  });

  it('treats a link that is off, or whose owner left, as dead without joining', async () => {
    for (const deps of [
      joinDeps({ readLink: async () => link({ status: 'revoked' }) }),
      joinDeps({ readLink: async () => null }),
      joinDeps({ ownerAdmitted: async () => false }),
    ]) {
      const res = await handlePublicJoinPost(joinRequest({ token }), deps.deps);
      expect(res.status).toBe(404);
      expect(deps.join).not.toHaveBeenCalled();
    }
  });

  it('does not ask whether the owner is admitted when the owner opens their own link', async () => {
    const ownerAdmitted = vi.fn(async () => false);
    const { deps, join } = joinDeps({
      requireMember: async () => ({ kind: 'ok', sub: ownerSub, email: 'owner@example.com', isOwner: true }),
      ownerAdmitted,
      join: vi.fn(async () => ({ kind: 'self', collectionId }) as const),
    });
    const res = await handlePublicJoinPost(joinRequest({ token }), deps);
    expect(res.status).toBe(200);
    expect(ownerAdmitted).not.toHaveBeenCalled();
    expect(join).toHaveBeenCalledWith(token, { sub: ownerSub, email: 'owner@example.com' });
  });
});

function ownerDeps(overrides: Partial<PublicOwnerDependencies> = {}) {
  const ensure = vi.fn(async () => ({ kind: 'ok', link: link() }) as const);
  const revoke = vi.fn(async () => {});
  const deps: PublicOwnerDependencies = {
    requireOwnedLiveCollection: async () => ({
      kind: 'ok',
      sub: ownerSub,
      email: 'owner@example.com',
    }),
    read: async () => null,
    ensure,
    revoke,
    origin: () => ORIGIN,
    now: () => now,
    ...overrides,
  };
  return { deps, ensure, revoke };
}

function ownerRequest(suffix = '', method = 'GET'): Request {
  return new Request(`${ORIGIN}/api/collections/${collectionId}/public${suffix}`, { method });
}

describe('owner public link API', () => {
  it('parses only the public paths', () => {
    expect(collectionIdFromPublicPath(`/api/collections/${collectionId}/public`)).toBe(collectionId);
    expect(collectionIdFromPublicPath(`/api/collections/${collectionId}/public/revoke`)).toBe(
      collectionId,
    );
    expect(collectionIdFromPublicPath('/api/collections/nope/public')).toBeNull();
    expect(collectionIdFromPublicPath(`/api/collections/${collectionId}/links`)).toBeNull();
  });

  it('reads the link as a URL, or null when off', async () => {
    const off = await handlePublicLinkGet(ownerRequest(), ownerDeps().deps);
    expect(await off.json()).toEqual({ url: null });
    const on = await handlePublicLinkGet(ownerRequest(), ownerDeps({ read: async () => link() }).deps);
    expect(await on.json()).toEqual({ url: `${ORIGIN}/p/${token}` });
  });

  it('turns it on with the owner session email and off again', async () => {
    const { deps, ensure, revoke } = ownerDeps();
    const on = await handlePublicLinkPost(ownerRequest('', 'POST'), deps);
    expect(await on.json()).toEqual({ url: `${ORIGIN}/p/${token}` });
    expect(ensure).toHaveBeenCalledWith(
      { ownerSub, ownerEmail: 'owner@example.com', collectionId },
      now,
    );
    const offRes = await handlePublicLinkRevokePost(ownerRequest('/revoke', 'POST'), deps);
    expect(await offRes.json()).toEqual({ url: null });
    expect(revoke).toHaveBeenCalledWith(ownerSub, collectionId, now);
  });

  it('is 404 for anyone but the owner, 401 signed out, 503 on a store error', async () => {
    const missing = ownerDeps({ requireOwnedLiveCollection: async () => ({ kind: 'missing' }) });
    expect((await handlePublicLinkPost(ownerRequest('', 'POST'), missing.deps)).status).toBe(404);
    expect(missing.ensure).not.toHaveBeenCalled();
    const denied = ownerDeps({ requireOwnedLiveCollection: async () => ({ kind: 'denied' }) });
    expect((await handlePublicLinkGet(ownerRequest(), denied.deps)).status).toBe(401);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = ownerDeps({
      read: async () => {
        throw new Error('down');
      },
    });
    expect((await handlePublicLinkGet(ownerRequest(), broken.deps)).status).toBe(503);
    spy.mockRestore();
  });
});
