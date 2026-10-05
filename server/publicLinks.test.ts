import { describe, expect, it } from 'vitest';
import { asViewerCollectionLink } from './publicJoin.ts';
import {
  hashPublicToken,
  mintPublicLinkRecord,
  newestLivePublicLink,
  parsePublicLinkDoc,
  publicApiPath,
  publicRecipeBody,
  readPublicCollection,
  resolvePublicPhoto,
  revokedPublicLink,
  type PublicLinkRecord,
  type PublicReadDependencies,
} from './publicLinks.ts';

const now = 1_700_000_000_000;
const token = 'P'.repeat(43);
const ownerSub = 'owner-sub';
const ownerEmail = 'owner@example.com';
const collectionId = '11111111-1111-4111-8111-111111111111';
const recipeA = '22222222-2222-4222-8222-222222222222';
const recipeB = '33333333-3333-4333-8333-333333333333';
const recipeGone = '44444444-4444-4444-8444-444444444444';
const photoA = '55555555-5555-4555-8555-555555555555';
const galleryB = '66666666-6666-4666-8666-666666666666';

function link(overrides: Partial<PublicLinkRecord> = {}): PublicLinkRecord {
  return {
    ownerSub,
    ownerEmail,
    collectionId,
    token,
    status: 'live',
    createdAt: now - 1,
    ...overrides,
  };
}

function recipe(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Recipe ${id.slice(0, 4)}`,
    servings: 2,
    ingredientSections: [{ items: [{ item: 'salt' }] }],
    steps: [{ text: 'Cook.' }],
    tags: [],
    createdAt: now - 10,
    updatedAt: now - 5,
    ...extra,
  };
}

function store(overrides: {
  link?: PublicLinkRecord | null;
  admitted?: boolean;
  collection?: Record<string, unknown> | undefined;
  recipes?: Record<string, Record<string, unknown>>;
} = {}) {
  const reads: string[][] = [];
  const recipes = overrides.recipes ?? {
    [recipeA]: recipe(recipeA, { photoId: photoA }),
    [recipeB]: recipe(recipeB, { galleryPhotoIds: [galleryB] }),
    [recipeGone]: recipe(recipeGone, { deletedAt: now - 3 }),
  };
  const deps: PublicReadDependencies = {
    readLink: async (id) =>
      id === hashPublicToken(token) ? (overrides.link === undefined ? link() : overrides.link) : null,
    ownerAdmitted: async (sub) => sub === ownerSub && overrides.admitted !== false,
    readCollection: async (sub, id) => {
      if (sub !== ownerSub || id !== collectionId) return undefined;
      return 'collection' in overrides
        ? overrides.collection
        : {
            id: collectionId,
            name: ' Soups ',
            recipeIds: [recipeB, recipeA, recipeGone, 'not-a-uuid', recipeA],
            createdAt: now - 100,
            updatedAt: now - 50,
          };
    },
    readRecipes: async (sub, ids) => {
      reads.push([...ids]);
      return ids.map((id) => (sub === ownerSub ? recipes[id] : undefined));
    },
  };
  return { deps, reads };
}

describe('publicApiPath', () => {
  it('reads the collection and photo paths', () => {
    expect(publicApiPath(`/api/public/${token}`)).toEqual({ kind: 'collection', token });
    expect(publicApiPath(`/api/public/${token}/recipes/${recipeA}/photos/${photoA}`)).toEqual({
      kind: 'photo',
      token,
      recipeId: recipeA,
      photoId: photoA,
    });
  });

  it('rejects everything else', () => {
    for (const path of [
      '/api/public/',
      '/api/public/join',
      `/api/public/${token}/`,
      `/api/public/${token}/recipes/${recipeA}`,
      `/api/public/${token}/recipes/x/photos/${photoA}`,
      `/api/public/${token}/recipes/${recipeA}/photos/x`,
      `/api/public/${token}/recipes/${recipeA}/photos/${photoA}/more`,
      `/api/photos/${photoA}`,
      `/api/public/${'x'.repeat(19)}`,
    ]) {
      expect(publicApiPath(path), path).toBeNull();
    }
  });
});

describe('public link records', () => {
  it('round-trips a minted record and keeps the token under its hash', () => {
    const minted = mintPublicLinkRecord({ ownerSub, ownerEmail, collectionId }, now);
    expect(minted.id).toBe(hashPublicToken(minted.record.token));
    expect(minted.record.status).toBe('live');
    expect(parsePublicLinkDoc(minted.record)).toEqual(minted.record);
  });

  it('rejects malformed documents', () => {
    expect(parsePublicLinkDoc(null)).toBeNull();
    expect(parsePublicLinkDoc({ ...link(), token: 'short' })).toBeNull();
    expect(parsePublicLinkDoc({ ...link(), status: 'paused' })).toBeNull();
    expect(parsePublicLinkDoc({ ...link(), collectionId: 'nope' })).toBeNull();
    expect(parsePublicLinkDoc({ ...link(), ownerSub: '' })).toBeNull();
  });

  it('picks the newest live link', () => {
    const older = link({ createdAt: now - 10 });
    const newer = link({ createdAt: now - 5, token: 'Q'.repeat(43) });
    const off = revokedPublicLink(link({ createdAt: now }), now);
    expect(newestLivePublicLink([older, off, newer, null])).toBe(newer);
    expect(newestLivePublicLink([off, null])).toBeNull();
  });

  it('joins as a viewer link that never expires', () => {
    const joined = asViewerCollectionLink(link());
    expect(joined).toMatchObject({ role: 'viewer', ownerSub, collectionId, status: 'live' });
    expect(joined!.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(asViewerCollectionLink(revokedPublicLink(link(), now))!.status).toBe('revoked');
    expect(asViewerCollectionLink(null)).toBeNull();
  });
});

describe('publicRecipeBody', () => {
  it('keeps recipe content and drops the import check, variantOf, and stored internals', () => {
    const body = publicRecipeBody(
      recipe(recipeA, {
        notes: 'Rest it.',
        sourceUrl: 'https://example.com/r',
        importCheck: { warnings: ['ingredients-missing'] },
        sharedParentOwnerSub: 'someone',
        serverUpdatedAt: now,
        deletedAt: null,
        variantOf: '99999999-9999-4999-8999-999999999999',
      }),
    );
    expect(body.notes).toBe('Rest it.');
    expect(body.sourceUrl).toBe('https://example.com/r');
    expect(body).not.toHaveProperty('importCheck');
    expect(body).not.toHaveProperty('variantOf');
    expect(body).not.toHaveProperty('sharedParentOwnerSub');
    expect(body).not.toHaveProperty('serverUpdatedAt');
  });
});

describe('readPublicCollection', () => {
  it('returns live listed recipes in collection order, once each', async () => {
    const { deps, reads } = store();
    const result = await readPublicCollection(token, deps);
    expect(result?.body.collection).toEqual({ id: collectionId, name: 'Soups' });
    expect(result?.body.recipes.map((r) => r.id)).toEqual([recipeB, recipeA]);
    expect(reads).toEqual([[recipeB, recipeA, recipeGone]]);
  });

  it('never carries the owner identity', async () => {
    const { deps } = store();
    const json = JSON.stringify((await readPublicCollection(token, deps))?.body);
    expect(json).not.toContain(ownerEmail);
    expect(json).not.toContain(ownerSub);
    expect(json).not.toContain(token);
  });

  it('is null for every dead end', async () => {
    const cases: Array<[string, ReturnType<typeof store>['deps'], string]> = [
      ['unknown token', store().deps, 'U'.repeat(43)],
      ['bad shape', store().deps, 'short'],
      ['turned off', store({ link: revokedPublicLink(link(), now) }).deps, token],
      ['stored token differs', store({ link: link({ token: 'Q'.repeat(43) }) }).deps, token],
      ['owner no longer admitted', store({ admitted: false }).deps, token],
      ['collection missing', store({ collection: undefined }).deps, token],
      [
        'collection deleted',
        store({ collection: { id: collectionId, recipeIds: [recipeA], deletedAt: now } }).deps,
        token,
      ],
      [
        'collection id mismatch',
        store({ collection: { id: 'other', recipeIds: [recipeA] } }).deps,
        token,
      ],
    ];
    for (const [name, deps, input] of cases) {
      expect(await readPublicCollection(input, deps), name).toBeNull();
    }
  });

  it('skips the recipe read for an empty collection', async () => {
    const { deps, reads } = store({ collection: { id: collectionId, name: 'Empty', recipeIds: [] } });
    expect((await readPublicCollection(token, deps))?.body.recipes).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('lets an unknown membership throw (503, never 404)', async () => {
    const { deps } = store();
    deps.ownerAdmitted = async () => {
      throw new Error('membership unavailable');
    };
    await expect(readPublicCollection(token, deps)).rejects.toThrow('membership unavailable');
  });
});

describe('resolvePublicPhoto', () => {
  it('allows a cover or gallery photo of a listed live recipe', async () => {
    const { deps } = store();
    expect(
      await resolvePublicPhoto({ token, recipeId: recipeA, photoId: photoA }, deps),
    ).toEqual({ ownerSub });
    expect(
      await resolvePublicPhoto({ token, recipeId: recipeB, photoId: galleryB }, deps),
    ).toEqual({ ownerSub });
  });

  it('refuses a photo the recipe does not list, an unlisted or deleted recipe, or a dead link', async () => {
    const unlisted = '77777777-7777-4777-8777-777777777777';
    const { deps } = store({
      recipes: {
        [recipeA]: recipe(recipeA, { photoId: photoA }),
        [unlisted]: recipe(unlisted, { photoId: photoA }),
        [recipeGone]: recipe(recipeGone, { photoId: photoA, deletedAt: now }),
      },
    });
    expect(await resolvePublicPhoto({ token, recipeId: recipeA, photoId: galleryB }, deps)).toBeNull();
    expect(await resolvePublicPhoto({ token, recipeId: unlisted, photoId: photoA }, deps)).toBeNull();
    expect(await resolvePublicPhoto({ token, recipeId: recipeGone, photoId: photoA }, deps)).toBeNull();
    const off = store({ link: revokedPublicLink(link(), now) }).deps;
    expect(await resolvePublicPhoto({ token, recipeId: recipeA, photoId: photoA }, off)).toBeNull();
  });
});
