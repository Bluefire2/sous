import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalSnapshotUpdateTime,
  loadSharedAuthorizationScope,
  sharedScopeEntryFromSnapshots,
  type LiveIncomingShare,
  type SharedAuthorizationScopeEntry,
  type SharedScopeCollectionSnapshot,
  type SharedScopeShareSnapshot,
} from './grants.ts';
import {
  buildSharedPullPage,
  decodeSharedCursor,
  encodeSharedCursor,
  SHARED_CURSOR_HMAC_DOMAIN,
  sharedAuthorizationGeneration,
  type BuildSharedPullPageInput,
  type SharedCursorPayload,
  type SharedPullCursor,
  type SharedPullPageResult,
} from './sharedPull.ts';
import type { StoreKind } from './store.ts';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
});

const viewerSub = 'viewer';
const collectionA = '11111111-1111-4111-8111-111111111111';
const collectionB = '22222222-2222-4222-8222-222222222222';

function liveCollection(id: string, recipeIds: string[]) {
  return {
    id,
    name: `Collection ${id}`,
    recipeIds,
    createdAt: 1,
    updatedAt: 2,
  };
}

function liveRecipe(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Recipe ${id}`,
    servings: 2,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  };
}

function docKey(uid: string, kind: StoreKind, id: string): string {
  return `${uid}/${kind}/${id}`;
}

function scopeFrom(
  shares: LiveIncomingShare[],
  docs?: Map<string, Record<string, unknown> | undefined>,
  times?: { share?: Record<string, string>; collection?: Record<string, string> },
): SharedAuthorizationScopeEntry[] {
  return shares.map((share) => {
    const collection = docs?.get(docKey(share.ownerSub, 'collections', share.collectionId));
    const live =
      collection !== undefined &&
      (collection.deletedAt === undefined || collection.deletedAt === null) &&
      collection.id === share.collectionId;
    const entry: SharedAuthorizationScopeEntry = {
      grantId: share.grantId,
      ownerSub: share.ownerSub,
      collectionId: share.collectionId,
      shareUpdateTime: times?.share?.[share.grantId] ?? `share:${share.grantId}`,
      collectionLive: live,
    };
    if (live && collection) {
      entry.recipeIds = Array.isArray(collection.recipeIds)
        ? collection.recipeIds.filter((id): id is string => typeof id === 'string')
        : [];
      entry.collectionUpdateTime =
        times?.collection?.[share.collectionId] ?? `collection:${share.collectionId}`;
    }
    return entry;
  });
}

function pageInput(input: {
  shares: LiveIncomingShare[];
  current?: Map<string, LiveIncomingShare | undefined>;
  docs?: Map<string, Record<string, unknown> | undefined>;
  cursor?: SharedPullCursor;
  limit?: number;
  calls?: string[];
  batches?: string[];
  ownerAdmitted?: (ownerSub: string) => Promise<boolean>;
  times?: { share?: Record<string, string>; collection?: Record<string, string> };
  readAuthorizationScope?: BuildSharedPullPageInput['readAuthorizationScope'];
}): BuildSharedPullPageInput {
  return {
    viewerSub,
    cursor: input.cursor ?? { kind: 'start' },
    limit: input.limit ?? 200,
    listLiveIncomingShares: async (requestedViewer) => {
      input.calls?.push(`list:${requestedViewer}`);
      return input.shares;
    },
    readLiveIncomingShare: async (requestedViewer, grantId) => {
      input.calls?.push(`share:${requestedViewer}:${grantId}`);
      return input.current?.has(grantId)
        ? input.current.get(grantId)
        : input.shares.find((share) => share.grantId === grantId);
    },
    ownerAdmitted: async (ownerSub) => {
      input.calls?.push(`owner:${ownerSub}`);
      return input.ownerAdmitted ? input.ownerAdmitted(ownerSub) : true;
    },
    readDocData: async (uid, kind, id) => {
      input.calls?.push(`doc:${uid}:${kind}:${id}`);
      return input.docs?.get(docKey(uid, kind, id));
    },
    readDocsData: async (uid, kind, ids) => {
      input.batches?.push(`${uid}:${kind}:${ids.join(',')}`);
      return ids.map((id) => input.docs?.get(docKey(uid, kind, id)));
    },
    readAuthorizationScope:
      input.readAuthorizationScope ??
      (async () => scopeFrom(input.shares, input.docs, input.times)),
  };
}

function expectPage(
  result: SharedPullPageResult,
): Extract<SharedPullPageResult, { kind: 'page' }> {
  expect(result.kind).toBe('page');
  if (result.kind !== 'page') {
    throw new Error(`expected page, got ${result.kind}`);
  }
  return result;
}

function continueCursor(
  page: Extract<SharedPullPageResult, { kind: 'page' }>,
): SharedPullCursor {
  return {
    kind: 'continue',
    generation: page.generation,
    grantId: page.cursor.grantId,
    recipeId: page.cursor.recipeId,
  };
}

describe('shared pull cursor', () => {
  const cursor: SharedCursorPayload = {
    v: 1,
    viewerSub,
    generation: 'opaque-generation',
    grantId: 'google-sub_11111111-1111-4111-8111-111111111111',
    recipeId: 'recipe-2',
  };

  it('round-trips the opaque generation and starts only from an empty cursor', () => {
    expect(decodeSharedCursor(encodeSharedCursor(cursor), viewerSub)).toEqual({
      kind: 'continue',
      cursor,
    });
    expect(decodeSharedCursor(null, viewerSub)).toEqual({ kind: 'start' });
    expect(decodeSharedCursor('', viewerSub)).toEqual({ kind: 'start' });
    const legacy = Buffer.from(
      JSON.stringify({ grantId: 'grant-a', recipeId: 'recipe-9' }),
      'utf8',
    ).toString('base64url');
    expect(decodeSharedCursor(legacy, viewerSub)).toEqual({ kind: 'reject' });
    expect(decodeSharedCursor('%%%', viewerSub)).toEqual({ kind: 'reject' });
  });

  it('binds version, viewer, generation, and both positional fields', () => {
    const token = encodeSharedCursor(cursor);
    const [payload, signature] = token.split('.');
    const parsed = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as SharedCursorPayload;
    expect(parsed).toEqual(cursor);
    expect(JSON.stringify(parsed)).not.toContain('owner-sub');

    const swapped = encodeSharedCursor({ ...cursor, recipeId: 'recipe-other' });
    const swappedSignature = swapped.split('.')[1];
    expect(decodeSharedCursor(`${payload}.${swappedSignature}`, viewerSub)).toEqual({
      kind: 'reject',
    });

    for (const field of ['v', 'viewerSub', 'generation', 'grantId', 'recipeId'] as const) {
      const tampered = { ...parsed, [field]: field === 'v' ? 2 : `${parsed[field]}-tampered` };
      const body = Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url');
      expect(decodeSharedCursor(`${body}.${signature}`, viewerSub)).toEqual({
        kind: 'reject',
      });
    }

    expect(decodeSharedCursor(token, 'other-viewer')).toEqual({ kind: 'reject' });

    const versionPayload = base64url(
      JSON.stringify({ ...cursor, v: 2 }),
    );
    const versionSignature = createHmac('sha256', 'test-secret-for-session-hmac')
      .update(`${SHARED_CURSOR_HMAC_DOMAIN}.${versionPayload}`)
      .digest('base64url');
    expect(
      decodeSharedCursor(`${versionPayload}.${versionSignature}`, viewerSub),
    ).toEqual({ kind: 'reject' });

    const sessionStyle = createHmac('sha256', 'test-secret-for-session-hmac')
      .update(payload)
      .digest('base64url');
    expect(decodeSharedCursor(`${payload}.${sessionStyle}`, viewerSub)).toEqual({
      kind: 'reject',
    });
  });

  it('does not put raw scope fields in the signed continuation', () => {
    const ownerSub = 'owner-sub-not-in-the-generation-token';
    const generation = sharedAuthorizationGeneration([
      {
        grantId: 'grant-1',
        ownerSub,
        collectionId: collectionA,
        shareUpdateTime: '1.000000000',
        collectionLive: true,
        recipeIds: ['recipe-membership-not-in-the-cursor'],
        collectionUpdateTime: '2.000000000',
      },
    ]);
    const token = encodeSharedCursor({
      v: 1,
      viewerSub,
      generation,
      grantId: 'grant-1',
      recipeId: 'recipe-page',
    });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload.generation).toBe(generation);
    expect(Object.keys(payload).sort()).toEqual([
      'generation',
      'grantId',
      'recipeId',
      'v',
      'viewerSub',
    ]);
    const encoded = JSON.stringify(payload);
    expect(encoded).not.toContain(ownerSub);
    expect(encoded).not.toContain('recipe-membership-not-in-the-cursor');
  });
});

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

describe('buildSharedPullPage', () => {
  it('keeps a normalized lang on a shared recipe and drops one it cannot understand', async () => {
    const okId = 'recipe-ok';
    const badId = 'recipe-bad';
    const shares = [{ grantId: 'grant-a', ownerSub: 'owner-a', collectionId: collectionA }];
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        liveCollection(collectionA, [badId, okId]),
      ],
      [
        docKey('owner-a', 'recipes', okId),
        liveRecipe(okId, {
          lang: 'zh-CN',
          nutrition: { calories: 1 },
          variantOf: '99999999-9999-4999-8999-999999999999',
          savedFrom: { name: 'Ada', savedAt: 5 },
        }),
      ],
      [docKey('owner-a', 'recipes', badId), liveRecipe(badId, { lang: 'garbage!!' })],
    ]);

    const page = expectPage(await buildSharedPullPage(pageInput({ shares, docs })));
    const byId = new Map(page.changes.recipes.map((recipe) => [recipe.id, recipe]));

    expect(byId.get(okId)).toMatchObject({ id: okId, lang: 'zh-Hans', ownerSub: 'owner-a' });
    // A viewer's variants group with the owner's.
    expect(byId.get(okId)?.variantOf).toBe('99999999-9999-4999-8999-999999999999');
    expect(byId.get(okId)).not.toHaveProperty('nutrition');
    // Who shared it with the owner stays the owner's.
    expect(byId.get(okId)).not.toHaveProperty('savedFrom');
    expect(byId.get(badId)).toMatchObject({ id: badId, ownerSub: 'owner-a' });
    expect(byId.get(badId)).not.toHaveProperty('lang');
  });

  it('paginates sorted recipes without gaps and then advances to the next grant', async () => {
    const shares = [
      { grantId: 'grant-a', ownerSub: 'owner-a', collectionId: collectionA },
      { grantId: 'grant-b', ownerSub: 'owner-b', collectionId: collectionB },
    ];
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-3', 'recipe-1', 'recipe-2']),
      ],
      [
        docKey('owner-b', 'collections', collectionB),
        liveCollection(collectionB, ['recipe-4']),
      ],
      ...['recipe-1', 'recipe-2', 'recipe-3'].map(
        (id) =>
          [
            docKey('owner-a', 'recipes', id),
            liveRecipe(id),
          ] as [string, Record<string, unknown>],
      ),
      [docKey('owner-b', 'recipes', 'recipe-4'), liveRecipe('recipe-4')],
    ]);

    const first = expectPage(
      await buildSharedPullPage(pageInput({ shares, docs, limit: 2 })),
    );
    const second = expectPage(
      await buildSharedPullPage(
        pageInput({ shares, docs, limit: 2, cursor: continueCursor(first) }),
      ),
    );
    const third = expectPage(
      await buildSharedPullPage(
        pageInput({ shares, docs, limit: 2, cursor: continueCursor(second) }),
      ),
    );
    expect(first.generation).toBe(second.generation);
    expect(second.generation).toBe(third.generation);

    expect(first.changes.recipes.map((recipe) => recipe.id)).toEqual([
      'recipe-1',
      'recipe-2',
    ]);
    expect(first.cursor).toEqual({
      grantId: 'grant-a',
      recipeId: 'recipe-2',
    });
    expect(first.hasMore).toBe(true);
    expect(second.changes.recipes.map((recipe) => recipe.id)).toEqual([
      'recipe-3',
    ]);
    expect(second.cursor).toEqual({ grantId: 'grant-a', recipeId: '\uFFFF' });
    expect(second.hasMore).toBe(true);
    expect(third.changes.recipes.map((recipe) => recipe.id)).toEqual([
      'recipe-4',
    ]);
    expect(third.cursor).toEqual({ grantId: 'grant-b', recipeId: '\uFFFF' });
    expect(third.hasMore).toBe(false);
    expect(
      [first, second, third].flatMap((page) =>
        page.changes.recipes.map((recipe) => recipe.id),
      ),
    ).toEqual(['recipe-1', 'recipe-2', 'recipe-3', 'recipe-4']);
    expect(first.changes.collections).toHaveLength(1);
    expect(second.changes.collections).toHaveLength(1);
    expect(third.changes.collections).toHaveLength(1);
  });

  it('revalidates listed shares and skips revoked or changed rows before owner reads', async () => {
    const shares = [
      {
        grantId: 'grant-revoked',
        ownerSub: 'owner-revoked',
        collectionId: collectionA,
      },
      {
        grantId: 'grant-changed',
        ownerSub: 'owner-old',
        collectionId: collectionA,
      },
      {
        grantId: 'grant-live',
        ownerSub: 'owner-live',
        collectionId: collectionB,
      },
    ];
    const current = new Map<string, LiveIncomingShare | undefined>([
      ['grant-revoked', undefined],
      [
        'grant-changed',
        {
          grantId: 'grant-changed',
          ownerSub: 'owner-new',
          collectionId: collectionB,
        },
      ],
      ['grant-live', shares[2]],
    ]);
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-live', 'collections', collectionB),
        liveCollection(collectionB, ['recipe-live']),
      ],
      [
        docKey('owner-live', 'recipes', 'recipe-live'),
        liveRecipe('recipe-live'),
      ],
    ]);
    const calls: string[] = [];

    const result = expectPage(
      await buildSharedPullPage(pageInput({ shares, current, docs, calls })),
    );

    expect(calls[0]).toBe(`list:${viewerSub}`);
    expect(calls).toContain(`share:${viewerSub}:grant-revoked`);
    expect(calls).toContain(`share:${viewerSub}:grant-changed`);
    expect(calls).not.toContain(
      `doc:owner-revoked:collections:${collectionA}`,
    );
    expect(calls).not.toContain(`doc:owner-old:collections:${collectionA}`);
    expect(result.changes.collections).toEqual([
      expect.objectContaining({ id: collectionB, ownerSub: 'owner-live' }),
    ]);
    expect(result.changes.recipes).toEqual([
      expect.objectContaining({ id: 'recipe-live', ownerSub: 'owner-live' }),
    ]);
    expect(result.cursor.grantId).toBe('grant-live');
  });

  it('labels a shared collection with the sharer email from the fresh share read only', async () => {
    const docs = new Map<string, Record<string, unknown>>([
      [docKey('owner-a', 'collections', collectionA), liveCollection(collectionA, [])],
      [docKey('owner-b', 'collections', collectionB), liveCollection(collectionB, [])],
    ]);
    const labelled = { grantId: 'grant-a', ownerSub: 'owner-a', collectionId: collectionA };
    const unlabelled = { grantId: 'grant-b', ownerSub: 'owner-b', collectionId: collectionB };

    const withEmail = expectPage(
      await buildSharedPullPage(
        pageInput({
          shares: [labelled],
          current: new Map([['grant-a', { ...labelled, ownerEmail: 'olivia@example.com' }]]),
          docs,
        }),
      ),
    );
    const withoutEmail = expectPage(
      await buildSharedPullPage(pageInput({ shares: [unlabelled], docs })),
    );

    expect(withEmail.changes.collections[0]).toMatchObject({
      id: collectionA,
      ownerSub: 'owner-a',
      ownerEmail: 'olivia@example.com',
    });
    expect(withoutEmail.changes.collections[0]).not.toHaveProperty('ownerEmail');
  });

  it('emits nothing through a tombstoned collection', async () => {
    const share = {
      grantId: 'grant-a',
      ownerSub: 'owner-a',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        {
          ...liveCollection(collectionA, ['recipe-a']),
          deletedAt: 3,
        },
      ],
      [docKey('owner-a', 'recipes', 'recipe-a'), liveRecipe('recipe-a')],
      [
        docKey('owner-a', 'photos', 'photo-a'),
        { contentType: 'image/jpeg', size: 1, createdAt: 1, updatedAt: 1 },
      ],
    ]);
    const calls: string[] = [];

    const result = expectPage(
      await buildSharedPullPage(pageInput({ shares: [share], docs, calls })),
    );

    expect(result.changes).toEqual({
      collections: [],
      recipes: [],
      photos: [],
    });
    expect(calls.some((call) => call.includes(':recipes:'))).toBe(false);
    expect(calls.some((call) => call.includes(':photos:'))).toBe(false);
  });

  it('skips removed, tombstoned, and missing recipes while advancing examined ids', async () => {
    const share = {
      grantId: 'grant-a',
      ownerSub: 'owner-a',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        liveCollection(collectionA, [
          'recipe-a-tombstone',
          'recipe-b-missing',
          'recipe-c-live',
        ]),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-a-tombstone'),
        { ...liveRecipe('recipe-a-tombstone'), deletedAt: 3 },
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-c-live'),
        liveRecipe('recipe-c-live'),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-removed'),
        liveRecipe('recipe-removed'),
      ],
    ]);
    const calls: string[] = [];

    const first = expectPage(
      await buildSharedPullPage(
        pageInput({ shares: [share], docs, calls, limit: 1 }),
      ),
    );
    const second = expectPage(
      await buildSharedPullPage(
        pageInput({
          shares: [share],
          docs,
          calls,
          limit: 1,
          cursor: continueCursor(first),
        }),
      ),
    );
    const third = expectPage(
      await buildSharedPullPage(
        pageInput({
          shares: [share],
          docs,
          calls,
          limit: 1,
          cursor: continueCursor(second),
        }),
      ),
    );
    expect(first.generation).toBe(third.generation);

    expect(first.changes.recipes).toEqual([]);
    expect(first.cursor.recipeId).toBe('recipe-a-tombstone');
    expect(first.hasMore).toBe(true);
    expect(second.changes.recipes).toEqual([]);
    expect(second.cursor.recipeId).toBe('recipe-b-missing');
    expect(second.hasMore).toBe(true);
    expect(third.changes.recipes).toEqual([
      expect.objectContaining({ id: 'recipe-c-live' }),
    ]);
    expect(calls).not.toContain('doc:owner-a:recipes:recipe-removed');
  });

  it('emits metadata only for authorized recipe photo references', async () => {
    const share = {
      grantId: 'grant-a',
      ownerSub: 'owner-a',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-a']),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-a'),
        liveRecipe('recipe-a', {
          photoId: 'photo-cover',
          galleryPhotoIds: [
            'photo-cover',
            'photo-gallery',
            'photo-pending',
            'photo-other-recipe',
          ],
        }),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-unrelated'),
        liveRecipe('recipe-unrelated', { photoId: 'photo-unrelated' }),
      ],
      [
        docKey('owner-a', 'photos', 'photo-cover'),
        {
          status: 'live',
          recipeId: 'recipe-a',
          contentType: 'image/jpeg',
          size: 11,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        docKey('owner-a', 'photos', 'photo-gallery'),
        {
          status: 'live',
          recipeId: 'recipe-a',
          contentType: 'image/jpeg',
          size: 14,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        docKey('owner-a', 'photos', 'photo-pending'),
        {
          status: 'pending',
          recipeId: 'recipe-a',
          contentType: 'image/jpeg',
          size: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        docKey('owner-a', 'photos', 'photo-other-recipe'),
        {
          status: 'live',
          recipeId: 'recipe-unrelated',
          contentType: 'image/jpeg',
          size: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        docKey('owner-a', 'photos', 'photo-unrelated'),
        {
          status: 'live',
          recipeId: 'recipe-unrelated',
          contentType: 'image/jpeg',
          size: 16,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        docKey('owner-other', 'photos', 'photo-cover'),
        { contentType: 'image/png', size: 999, createdAt: 1, updatedAt: 1 },
      ],
    ]);
    const calls: string[] = [];

    const result = expectPage(
      await buildSharedPullPage(pageInput({ shares: [share], docs, calls })),
    );

    expect(result.changes.photos.map((photo) => photo.id)).toEqual([
      'photo-cover',
      'photo-gallery',
    ]);
    expect(calls).not.toContain('doc:owner-a:photos:photo-unrelated');
    expect(calls).not.toContain('doc:owner-other:photos:photo-cover');
  });

  it('reads a page of recipes and their photos in one batch each', async () => {
    const share = {
      grantId: 'grant-a',
      ownerSub: 'owner-a',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-a', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-b', 'recipe-a', 'recipe-c']),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-a'),
        liveRecipe('recipe-a', { photoId: 'photo-shared' }),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-b'),
        liveRecipe('recipe-b', {
          photoId: 'photo-b',
          galleryPhotoIds: ['photo-shared'],
        }),
      ],
      [
        docKey('owner-a', 'recipes', 'recipe-c'),
        { ...liveRecipe('recipe-c', { photoId: 'photo-c' }), deletedAt: 3 },
      ],
      [
        docKey('owner-a', 'photos', 'photo-shared'),
        {
          status: 'live',
          recipeId: 'recipe-a',
          contentType: 'image/jpeg',
          size: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        docKey('owner-a', 'photos', 'photo-b'),
        {
          status: 'live',
          recipeId: 'recipe-b',
          contentType: 'image/jpeg',
          size: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        docKey('owner-a', 'photos', 'photo-c'),
        {
          status: 'live',
          recipeId: 'recipe-c',
          contentType: 'image/jpeg',
          size: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);
    const batches: string[] = [];

    const result = expectPage(
      await buildSharedPullPage(pageInput({ shares: [share], docs, batches })),
    );

    expect(batches).toEqual([
      'owner-a:recipes:recipe-a,recipe-b,recipe-c',
      'owner-a:photos:photo-shared,photo-b',
    ]);
    expect(result.changes.recipes.map((recipe) => recipe.id)).toEqual([
      'recipe-a',
      'recipe-b',
    ]);
    expect(
      result.changes.photos.map((photo) => `${photo.recipeId}:${photo.id}`),
    ).toEqual(['recipe-a:photo-shared', 'recipe-b:photo-b']);
  });

  it('skips a share whose owner is no longer admitted before any owner-tree read', async () => {
    const shares = [
      { grantId: 'grant-a', ownerSub: 'owner-removed', collectionId: collectionA },
      { grantId: 'grant-b', ownerSub: 'owner-live', collectionId: collectionB },
    ];
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-removed', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-removed']),
      ],
      [
        docKey('owner-removed', 'recipes', 'recipe-removed'),
        liveRecipe('recipe-removed'),
      ],
      [
        docKey('owner-live', 'collections', collectionB),
        liveCollection(collectionB, ['recipe-live']),
      ],
      [docKey('owner-live', 'recipes', 'recipe-live'), liveRecipe('recipe-live')],
    ]);
    const calls: string[] = [];

    const result = expectPage(
      await buildSharedPullPage(
        pageInput({
          shares,
          docs,
          calls,
          ownerAdmitted: async (ownerSub) => ownerSub !== 'owner-removed',
        }),
      ),
    );

    expect(calls).toContain('owner:owner-removed');
    expect(calls.some((call) => call.startsWith('doc:owner-removed:'))).toBe(false);
    expect(result.changes.recipes).toEqual([
      expect.objectContaining({ id: 'recipe-live', ownerSub: 'owner-live' }),
    ]);
    expect(result.hasMore).toBe(false);
  });

  it('propagates unknown owner membership instead of treating it as denied', async () => {
    const share = { grantId: 'grant-a', ownerSub: 'owner-a', collectionId: collectionA };
    await expect(
      buildSharedPullPage(
        pageInput({
          shares: [share],
          ownerAdmitted: async () => {
            throw new Error('firestore blip');
          },
        }),
      ),
    ).rejects.toThrow('firestore blip');
  });

  it('does not let a hostile cursor manufacture an owner-tree read', async () => {
    const allowedShare = {
      grantId: 'grant-a',
      ownerSub: 'owner-allowed',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-allowed', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-allowed']),
      ],
      [
        docKey('owner-allowed', 'recipes', 'recipe-allowed'),
        liveRecipe('recipe-allowed'),
      ],
      [
        docKey('owner-secret', 'collections', collectionB),
        liveCollection(collectionB, ['recipe-secret']),
      ],
      [
        docKey('owner-secret', 'recipes', 'recipe-secret'),
        liveRecipe('recipe-secret'),
      ],
    ]);
    const calls: string[] = [];

    const generation = sharedAuthorizationGeneration(
      scopeFrom([allowedShare], docs),
    );
    const result = expectPage(
      await buildSharedPullPage(
        pageInput({
          shares: [allowedShare],
          docs,
          calls,
          cursor: {
            kind: 'continue',
            generation,
            grantId: 'grant-0-hostile',
            recipeId: 'recipe-secret',
          },
        }),
      ),
    );

    expect(result.changes.recipes).toEqual([
      expect.objectContaining({
        id: 'recipe-allowed',
        ownerSub: 'owner-allowed',
      }),
    ]);
    expect(calls.some((call) => call.includes('owner-secret'))).toBe(false);
  });
});

describe('shared authorization generation', () => {
  const entry = (
    overrides: Partial<SharedAuthorizationScopeEntry> = {},
  ): SharedAuthorizationScopeEntry => ({
    grantId: 'grant-a',
    ownerSub: 'owner-a',
    collectionId: collectionA,
    shareUpdateTime: '1.000000001',
    collectionLive: true,
    recipeIds: ['recipe-b', 'recipe-a'],
    collectionUpdateTime: '2.000000002',
    ...overrides,
  });

  it('is stable across order and ignores non-live membership and document clocks', () => {
    const first = entry();
    const second = entry({
      grantId: 'grant-b',
      ownerSub: 'owner-b',
      collectionId: collectionB,
      shareUpdateTime: '3.000000003',
      recipeIds: ['recipe-c'],
      collectionUpdateTime: '4.000000004',
    });
    expect(sharedAuthorizationGeneration([second, first])).toBe(
      sharedAuthorizationGeneration([first, second]),
    );
    expect(sharedAuthorizationGeneration([entry({ recipeIds: ['recipe-a', 'recipe-b'] })])).toBe(
      sharedAuthorizationGeneration([first]),
    );
    expect(
      sharedAuthorizationGeneration([
        entry({ collectionLive: false, recipeIds: ['secret-membership'], collectionUpdateTime: '9' }),
      ]),
    ).toBe(
      sharedAuthorizationGeneration([
        {
          grantId: 'grant-a',
          ownerSub: 'owner-a',
          collectionId: collectionA,
          shareUpdateTime: '1.000000001',
          collectionLive: false,
        },
      ]),
    );
    expect(sharedAuthorizationGeneration([entry({ recipeIds: ['recipe-a'] })])).not.toBe(
      sharedAuthorizationGeneration([first]),
    );
    expect(sharedAuthorizationGeneration([entry({ shareUpdateTime: '8.000000008' })])).not.toBe(
      sharedAuthorizationGeneration([first]),
    );
    expect(
      sharedAuthorizationGeneration([entry({ collectionUpdateTime: '8.000000008' })]),
    ).not.toBe(sharedAuthorizationGeneration([first]));
    expect(sharedAuthorizationGeneration([entry({ collectionLive: false })])).not.toBe(
      sharedAuthorizationGeneration([first]),
    );
  });

  it('formats Firestore snapshot updateTime without collapsing nanoseconds', () => {
    expect(canonicalSnapshotUpdateTime({ seconds: 10, nanoseconds: 1 })).toBe(
      '10.000000001',
    );
    expect(canonicalSnapshotUpdateTime(undefined)).toBe('');
  });

  it('takes mutation identity from snapshot metadata', () => {
    const share: SharedScopeShareSnapshot = {
      id: 'grant-a',
      updateTime: '20.000000009',
      data: {
        ownerSub: 'owner-stored',
        collectionId: collectionA,
        updatedAt: 1,
      },
    };
    const collection: SharedScopeCollectionSnapshot = {
      exists: true,
      updateTime: '30.000000008',
      data: {
        id: collectionA,
        recipeIds: ['recipe-b', 'recipe-a'],
        updatedAt: 2,
      },
    };
    expect(sharedScopeEntryFromSnapshots(share, collection)).toEqual({
      grantId: 'grant-a',
      ownerSub: 'owner-stored',
      collectionId: collectionA,
      shareUpdateTime: '20.000000009',
      collectionLive: true,
      recipeIds: ['recipe-b', 'recipe-a'],
      collectionUpdateTime: '30.000000008',
    });
    expect(
      sharedScopeEntryFromSnapshots(
        {
          ...share,
          data: { ...share.data, deletedAt: 4 },
        },
        collection,
      ),
    ).toBeNull();
  });

  it('drops a non-admitted owner from the scope before reading their collection', async () => {
    const calls: string[] = [];
    const entries = await loadSharedAuthorizationScope(viewerSub, {
      ownerAdmitted: async (ownerSub) => ownerSub !== 'owner-removed',
      listShareSnapshots: async () => [
        {
          id: 'grant-removed',
          updateTime: '1.000000000',
          data: {
            ownerSub: 'owner-removed',
            collectionId: collectionA,
            updatedAt: 1,
          },
        },
        {
          id: 'grant-live',
          updateTime: '2.000000000',
          data: {
            ownerSub: 'owner-live',
            collectionId: collectionB,
            updatedAt: 2,
          },
        },
      ],
      readCollectionSnapshot: async (ownerSub, collectionId) => {
        calls.push(`${ownerSub}:${collectionId}`);
        return {
          exists: true,
          data: liveCollection(collectionId, []),
          updateTime: '3.000000000',
        };
      },
    });
    expect(calls).toEqual([`owner-live:${collectionB}`]);
    expect(entries.map((entry) => entry.grantId)).toEqual(['grant-live']);
  });

  it('reads live share collections from stored owner identity in list order', async () => {
    const calls: string[] = [];
    const entries = await loadSharedAuthorizationScope(viewerSub, {
      listShareSnapshots: async (requestedViewer) => {
        calls.push(`list:${requestedViewer}`);
        return [
          {
            id: 'grant-dead',
            updateTime: '1.000000000',
            data: {
              ownerSub: 'owner-dead',
              collectionId: collectionA,
              updatedAt: 1,
              deletedAt: 1,
            },
          },
          {
            id: 'attacker-prefix',
            updateTime: '2.000000000',
            data: {
              ownerSub: 'owner-stored',
              collectionId: collectionB,
              updatedAt: 5,
            },
          },
          {
            id: 'grant-missing',
            updateTime: '4.000000000',
            data: { ownerSub: 'x' },
          },
        ];
      },
      readCollectionSnapshot: async (ownerSub, id) => {
        calls.push(`collection:${ownerSub}:${id}`);
        if (id === collectionB) {
          return {
            exists: true,
            updateTime: '3.000000000',
            data: { id, recipeIds: ['recipe-z', 'recipe-a'], updatedAt: 9 },
          };
        }
        return { exists: false };
      },
    });

    expect(calls).toEqual([
      `list:${viewerSub}`,
      `collection:owner-stored:${collectionB}`,
    ]);
    expect(entries).toEqual([
      {
        grantId: 'attacker-prefix',
        ownerSub: 'owner-stored',
        collectionId: collectionB,
        shareUpdateTime: '2.000000000',
        collectionLive: true,
        recipeIds: ['recipe-z', 'recipe-a'],
        collectionUpdateTime: '3.000000000',
      },
    ]);
  });
});

describe('shared pull authorization generation', () => {
  function twoRecipeDocs() {
    const share = {
      grantId: 'grant-a',
      ownerSub: 'owner-a',
      collectionId: collectionA,
    };
    const collection = liveCollection(collectionA, ['recipe-1', 'recipe-2']);
    const recipe = liveRecipe('recipe-1');
    const docs = new Map<string, Record<string, unknown>>([
      [docKey('owner-a', 'collections', collectionA), collection],
      [docKey('owner-a', 'recipes', 'recipe-1'), recipe],
      [docKey('owner-a', 'recipes', 'recipe-2'), liveRecipe('recipe-2')],
    ]);
    return { share, collection, recipe, docs };
  }

  it('completes a stable single-page pull with one generation checked twice', async () => {
    const { share, docs } = twoRecipeDocs();
    let reads = 0;
    const page = expectPage(
      await buildSharedPullPage(
        pageInput({
          shares: [share],
          docs,
          readAuthorizationScope: async (requestedViewer) => {
            reads += 1;
            expect(requestedViewer).toBe(viewerSub);
            return scopeFrom([share], docs);
          },
        }),
      ),
    );
    expect(page.hasMore).toBe(false);
    expect(reads).toBe(2);
    expect(page.generation).toBe(
      sharedAuthorizationGeneration(scopeFrom([share], docs)),
    );
    expect(page.changes.recipes.map((recipe) => recipe.id)).toEqual([
      'recipe-1',
      'recipe-2',
    ]);
  });

  it('keeps the same generation across a stable multi-page pull', async () => {
    const { share, docs } = twoRecipeDocs();
    let reads = 0;
    const input = {
      shares: [share],
      docs,
      limit: 1,
      readAuthorizationScope: async () => {
        reads += 1;
        return scopeFrom([share], docs);
      },
    };
    const first = expectPage(await buildSharedPullPage(pageInput(input)));
    const second = expectPage(
      await buildSharedPullPage(
        pageInput({ ...input, cursor: continueCursor(first) }),
      ),
    );
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(second.generation).toBe(first.generation);
    expect(reads).toBe(4);
    expect(second.changes.recipes.map((recipe) => recipe.id)).toEqual(['recipe-2']);
  });

  it('does not restart when only a recipe body changes', async () => {
    const { share, docs, recipe } = twoRecipeDocs();
    const first = expectPage(
      await buildSharedPullPage(pageInput({ shares: [share], docs })),
    );
    recipe.title = 'Renamed after the scope was established';
    const second = expectPage(
      await buildSharedPullPage(
        pageInput({
          shares: [share],
          docs,
          cursor: continueCursor(first),
        }),
      ),
    );
    expect(second.generation).toBe(first.generation);
  });

  it('returns no changes when a grant is revoked before the next page', async () => {
    const { share, docs } = twoRecipeDocs();
    let shares = [share];
    const calls: string[] = [];
    const first = expectPage(
      await buildSharedPullPage(
        pageInput({
          shares,
          docs,
          calls,
          limit: 1,
          readAuthorizationScope: async () => scopeFrom(shares, docs),
        }),
      ),
    );
    expect(first.changes.recipes.map((recipe) => recipe.id)).toEqual(['recipe-1']);
    shares = [];
    calls.length = 0;
    const second = await buildSharedPullPage(
      pageInput({
        shares,
        docs,
        calls,
        limit: 1,
        cursor: continueCursor(first),
        readAuthorizationScope: async () => scopeFrom(shares, docs),
      }),
    );
    expect(second).toEqual({ kind: 'snapshot-changed' });
    expect(calls).toEqual([]);
  });

  it('returns no changes when a recipe leaves the collection before the next page', async () => {
    const { share, collection, docs } = twoRecipeDocs();
    const first = expectPage(
      await buildSharedPullPage(
        pageInput({ shares: [share], docs, limit: 1 }),
      ),
    );
    expect(first.changes.recipes.map((recipe) => recipe.id)).toEqual(['recipe-1']);
    collection.recipeIds = ['recipe-2'];
    const second = await buildSharedPullPage(
      pageInput({
        shares: [share],
        docs,
        limit: 1,
        cursor: continueCursor(first),
      }),
    );
    expect(second).toEqual({ kind: 'snapshot-changed' });
  });

  it('restarts when a logically identical grant is recreated', async () => {
    const { share, docs } = twoRecipeDocs();
    let shareUpdateTime = '1.000000001';
    const readAuthorizationScope = async () =>
      scopeFrom([share], docs, { share: { 'grant-a': shareUpdateTime } });
    const first = expectPage(
      await buildSharedPullPage(
        pageInput({ shares: [share], docs, readAuthorizationScope }),
      ),
    );
    shareUpdateTime = '9.000000009';
    const calls: string[] = [];
    const second = await buildSharedPullPage(
      pageInput({
        shares: [share],
        docs,
        calls,
        cursor: continueCursor(first),
        readAuthorizationScope,
      }),
    );
    expect(second).toEqual({ kind: 'snapshot-changed' });
    expect(calls).toEqual([]);
  });

  it('does not read another owner tree from a stale generation and hostile position', async () => {
    const allowedShare = {
      grantId: 'grant-a',
      ownerSub: 'owner-allowed',
      collectionId: collectionA,
    };
    const docs = new Map<string, Record<string, unknown>>([
      [
        docKey('owner-allowed', 'collections', collectionA),
        liveCollection(collectionA, ['recipe-allowed']),
      ],
      [
        docKey('owner-secret', 'collections', collectionB),
        liveCollection(collectionB, ['recipe-secret']),
      ],
      [
        docKey('owner-secret', 'recipes', 'recipe-secret'),
        liveRecipe('recipe-secret'),
      ],
    ]);
    const calls: string[] = [];
    const result = await buildSharedPullPage(
      pageInput({
        shares: [allowedShare],
        docs,
        calls,
        cursor: {
          kind: 'continue',
          generation: 'stale-generation',
          grantId: 'grant-secret',
          recipeId: 'recipe-secret',
        },
      }),
    );
    expect(result).toEqual({ kind: 'snapshot-changed' });
    expect(calls).toEqual([]);
  });

  it('discards a finished page when the scope changes after the read', async () => {
    const { share, docs } = twoRecipeDocs();
    let reads = 0;
    const result = await buildSharedPullPage(
      pageInput({
        shares: [share],
        docs,
        readAuthorizationScope: async () => {
          reads += 1;
          return reads === 1 ? scopeFrom([share], docs) : [];
        },
      }),
    );
    expect(result).toEqual({ kind: 'snapshot-changed' });
    expect(reads).toBe(2);
  });

  it('discards the final page when the scope changes after that read', async () => {
    const { share, docs } = twoRecipeDocs();
    const first = expectPage(
      await buildSharedPullPage(
        pageInput({ shares: [share], docs, limit: 1 }),
      ),
    );
    let reads = 0;
    const second = await buildSharedPullPage(
      pageInput({
        shares: [share],
        docs,
        limit: 1,
        cursor: continueCursor(first),
        readAuthorizationScope: async () => {
          reads += 1;
          return reads === 1 ? scopeFrom([share], docs) : [];
        },
      }),
    );
    expect(second).toEqual({ kind: 'snapshot-changed' });
    expect(reads).toBe(2);
  });
});
