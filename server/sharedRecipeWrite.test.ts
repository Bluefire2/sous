import { describe, expect, it } from 'vitest';
import {
  findSharedRecipeAccess,
  orchestrateSharedRecipePut,
  planSharedRecipePut,
  recipePhotoIdsUnchanged,
  sharedRecipeDeleteAllowed,
  type SharedRecipeAccess,
  type SharedRecipeAccessIo,
  type SharedRecipePutTransaction,
} from './sharedRecipeWrite.ts';
import { compareMutation, readStoredMutationState } from './store.ts';
import {
  parseShareRole,
  requestedShareRole,
  strongerShareRole,
} from './shareAuth.ts';

const recipeId = '11111111-1111-4111-8111-111111111111';
const dinners = '22222222-2222-4222-8222-222222222222';
const lunches = '33333333-3333-4333-8333-333333333333';
const cover = '44444444-4444-4444-8444-444444444444';
const gallery = '55555555-5555-4555-8555-555555555555';
const otherPhoto = '66666666-6666-4666-8666-666666666666';

const ownerRecipe = {
  id: recipeId,
  title: 'Soup',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil' }],
  tags: [],
  photoId: cover,
  galleryPhotoIds: [gallery],
  createdAt: 1,
  updatedAt: 10,
  serverUpdatedAt: 11,
};

function editedPayload(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...ownerRecipe,
    title: 'Better soup',
    steps: [{ text: 'Boil gently' }],
    updatedAt: 20,
    ...fields,
  };
}

type Store = {
  shares: Array<{ grantId: string; data: Record<string, unknown> }>;
  collections: Map<string, Record<string, unknown>>;
  recipes: Map<string, Record<string, unknown>>;
};

function shareDoc(collectionId: string, role?: unknown, extra: Record<string, unknown> = {}) {
  return {
    grantId: `owner_${collectionId}`,
    data: {
      ownerSub: 'owner',
      collectionId,
      updatedAt: 1,
      ...(role === undefined ? {} : { role }),
      ...extra,
    },
  };
}

function store(partial: Partial<Store> = {}): Store {
  return {
    shares: [shareDoc(dinners, 'editor')],
    collections: new Map([
      [`owner/${dinners}`, { id: dinners, name: 'Dinners', recipeIds: [recipeId], updatedAt: 1 }],
      [`owner/${lunches}`, { id: lunches, name: 'Lunches', recipeIds: [recipeId], updatedAt: 1 }],
    ]),
    recipes: new Map([[`owner/${recipeId}`, { ...ownerRecipe }]]),
    ...partial,
  };
}

function io(data: Store): SharedRecipeAccessIo {
  return {
    listShares: async () => data.shares,
    readCollection: async (ownerSub, collectionId) =>
      data.collections.get(`${ownerSub}/${collectionId}`),
    readRecipe: async (ownerSub, id) => data.recipes.get(`${ownerSub}/${id}`),
  };
}

describe('share roles', () => {
  it('reads a missing or unknown stored role as viewer', () => {
    expect(parseShareRole(undefined)).toBe('viewer');
    expect(parseShareRole('owner')).toBe('viewer');
    expect(parseShareRole('editor')).toBe('editor');
  });

  it('defaults an omitted request role to viewer and rejects anything else unknown', () => {
    expect(requestedShareRole(undefined)).toBe('viewer');
    expect(requestedShareRole('editor')).toBe('editor');
    expect(requestedShareRole('admin')).toBeNull();
    expect(requestedShareRole(null)).toBeNull();
  });

  it('prefers editor', () => {
    expect(strongerShareRole('viewer', 'editor')).toBe('editor');
    expect(strongerShareRole('viewer', 'viewer')).toBe('viewer');
  });
});

describe('findSharedRecipeAccess', () => {
  it('finds the owner and role through share → collection → listed live recipe', async () => {
    const access = await findSharedRecipeAccess(recipeId, io(store()));
    expect(access).toMatchObject({ ownerSub: 'owner', role: 'editor' });
    expect(access?.recipe).toMatchObject({ title: 'Soup' });
  });

  it('reads a share with no role as viewer', async () => {
    const access = await findSharedRecipeAccess(
      recipeId,
      io(store({ shares: [shareDoc(dinners)] })),
    );
    expect(access?.role).toBe('viewer');
  });

  it('takes the stronger role when two collections list the recipe', async () => {
    for (const shares of [
      [shareDoc(dinners, 'viewer'), shareDoc(lunches, 'editor')],
      [shareDoc(lunches, 'editor'), shareDoc(dinners, 'viewer')],
    ]) {
      const access = await findSharedRecipeAccess(recipeId, io(store({ shares })));
      expect(access?.role).toBe('editor');
    }
  });

  it('ignores a revoked share, an unlisted recipe, and a deleted recipe', async () => {
    expect(
      await findSharedRecipeAccess(
        recipeId,
        io(store({ shares: [shareDoc(dinners, 'editor', { deletedAt: 2 })] })),
      ),
    ).toBeNull();
    const unlisted = store();
    unlisted.collections.set(`owner/${dinners}`, {
      id: dinners,
      name: 'Dinners',
      recipeIds: [],
      updatedAt: 2,
    });
    expect(await findSharedRecipeAccess(recipeId, io(unlisted))).toBeNull();
    const deleted = store();
    deleted.recipes.set(`owner/${recipeId}`, { id: recipeId, updatedAt: 30, deletedAt: 30 });
    expect(await findSharedRecipeAccess(recipeId, io(deleted))).toBeNull();
    const collectionGone = store();
    collectionGone.collections.set(`owner/${dinners}`, {
      id: dinners,
      updatedAt: 3,
      deletedAt: 3,
    });
    expect(await findSharedRecipeAccess(recipeId, io(collectionGone))).toBeNull();
  });
});

describe('recipePhotoIdsUnchanged', () => {
  it('accepts the same cover and gallery, and treats an empty gallery as none', () => {
    expect(recipePhotoIdsUnchanged(ownerRecipe, editedPayload())).toBe(true);
    const bare = { ...ownerRecipe, photoId: undefined, galleryPhotoIds: undefined };
    expect(recipePhotoIdsUnchanged(bare, { ...bare, galleryPhotoIds: [] })).toBe(true);
  });

  it('rejects an added, removed, or swapped photo id', () => {
    const bare = { ...ownerRecipe, photoId: undefined, galleryPhotoIds: undefined };
    expect(recipePhotoIdsUnchanged(bare, { ...bare, photoId: otherPhoto })).toBe(false);
    expect(recipePhotoIdsUnchanged(ownerRecipe, editedPayload({ photoId: undefined }))).toBe(
      false,
    );
    expect(
      recipePhotoIdsUnchanged(ownerRecipe, editedPayload({ photoId: otherPhoto })),
    ).toBe(false);
    expect(
      recipePhotoIdsUnchanged(
        ownerRecipe,
        editedPayload({ galleryPhotoIds: [gallery, otherPhoto] }),
      ),
    ).toBe(false);
    expect(
      recipePhotoIdsUnchanged(ownerRecipe, editedPayload({ galleryPhotoIds: undefined })),
    ).toBe(false);
  });
});

describe('planSharedRecipePut', () => {
  const editor: SharedRecipeAccess = { ownerSub: 'owner', role: 'editor', recipe: ownerRecipe };
  const base = {
    recipeId,
    access: editor,
    ownerAdmitted: true,
    payload: editedPayload(),
    clientUpdatedAt: 20,
    serverUpdatedAt: 99,
  };

  it('keeps a normalized lang on an editor save and drops one it cannot understand', () => {
    const kept = planSharedRecipePut({
      ...base,
      payload: editedPayload({ lang: 'it-IT' }),
    });
    expect(kept).toMatchObject({ kind: 'write', body: { lang: 'it', title: 'Better soup' } });

    const hans = planSharedRecipePut({
      ...base,
      payload: editedPayload({ lang: 'zh-CN' }),
    });
    expect(hans).toMatchObject({ kind: 'write', body: { lang: 'zh-Hans' } });

    const dropped = planSharedRecipePut({
      ...base,
      payload: editedPayload({ lang: 'garbage!!' }),
    });
    expect(dropped.kind).toBe('write');
    if (dropped.kind !== 'write') return;
    expect(dropped.body).not.toHaveProperty('lang');
  });

  it('lets an editor write text to the owner row, keeping identity and photos', () => {
    const plan = planSharedRecipePut({
      ...base,
      payload: editedPayload({ createdAt: 5, ownerSub: 'attacker', role: 'editor' }),
    });
    expect(plan.kind).toBe('write');
    if (plan.kind !== 'write') return;
    expect(plan.ownerSub).toBe('owner');
    expect(plan.body).toMatchObject({
      id: recipeId,
      title: 'Better soup',
      steps: [{ text: 'Boil gently' }],
      createdAt: 1,
      photoId: cover,
      galleryPhotoIds: [gallery],
      updatedAt: 20,
      serverUpdatedAt: 99,
    });
    expect(plan.body).not.toHaveProperty('ownerSub');
    expect(plan.body).not.toHaveProperty('role');
  });

  it("keeps the owner's variantOf whatever the editor sends", () => {
    const original = '77777777-7777-4777-8777-777777777777';
    const editorsOwn = '88888888-8888-4888-8888-888888888888';
    const variant: SharedRecipeAccess = { ...editor, recipe: { ...ownerRecipe, variantOf: original } };
    for (const payload of [editedPayload({ variantOf: editorsOwn }), editedPayload()]) {
      const plan = planSharedRecipePut({ ...base, access: variant, payload });
      expect(plan).toMatchObject({ kind: 'write', body: { variantOf: original } });
    }
    const plain = planSharedRecipePut({ ...base, payload: editedPayload({ variantOf: editorsOwn }) });
    expect(plain.kind).toBe('write');
    if (plain.kind !== 'write') return;
    expect(plain.body).not.toHaveProperty('variantOf');
  });

  it('rejects a viewer, a stranger, and an editor whose owner is no longer admitted', () => {
    for (const input of [
      { ...base, access: { ...editor, role: 'viewer' as const } },
      { ...base, access: null },
      { ...base, ownerAdmitted: false },
    ]) {
      expect(planSharedRecipePut(input)).toEqual({
        kind: 'reject',
        result: { applied: false, reason: 'invalid' },
      });
    }
  });

  it('rejects an editor put that changes a photo id', () => {
    for (const fields of [
      { photoId: otherPhoto },
      { photoId: undefined },
      { galleryPhotoIds: [gallery, otherPhoto] },
      { galleryPhotoIds: [otherPhoto] },
      { galleryPhotoIds: undefined },
    ]) {
      expect(planSharedRecipePut({ ...base, payload: editedPayload(fields) })).toEqual({
        kind: 'reject',
        result: { applied: false, reason: 'invalid' },
      });
    }
  });

  it('stores a far-future editor stamp as server time, so a later owner save still wins', () => {
    const plan = planSharedRecipePut({ ...base, clientUpdatedAt: 9_999_999_999_999 });
    expect(plan).toMatchObject({ kind: 'write', body: { updatedAt: 99, serverUpdatedAt: 99 } });
    if (plan.kind !== 'write') return;
    const ownerLater = compareMutation(readStoredMutationState(plan.body), 100, 'put');
    expect(ownerLater).toEqual({ allow: true, undeleting: false });
  });

  it('keeps last-write-wins against the owner row', () => {
    expect(planSharedRecipePut({ ...base, clientUpdatedAt: 5 })).toEqual({
      kind: 'reject',
      result: { applied: false, reason: undefined, current: ownerRecipe },
    });
  });
});

describe('orchestrateSharedRecipePut', () => {
  function run(data: Store, admitted = true, payload = editedPayload()) {
    const events: string[] = [];
    const writes: Array<{ ownerSub: string; id: string; body: Record<string, unknown> }> = [];
    const tx: SharedRecipePutTransaction = {
      ...io(data),
      writeRecipe: (ownerSub, id, body) => {
        events.push('write');
        writes.push({ ownerSub, id, body });
      },
    };
    const reads = io(data);
    tx.listShares = async () => {
      events.push('listShares');
      return reads.listShares();
    };
    const result = orchestrateSharedRecipePut(
      { recipeId, payload, clientUpdatedAt: 20 },
      {
        now: () => 99,
        ownerAdmitted: async () => admitted,
        runTransaction: async (work) => work(tx),
      },
    );
    return { result, events, writes };
  }

  it('writes an editor put to the owner tree after reading access in the same transaction', async () => {
    const { result, events, writes } = run(store());
    await expect(result).resolves.toEqual({ applied: true, serverUpdatedAt: 99 });
    expect(events).toEqual(['listShares', 'write']);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ ownerSub: 'owner', id: recipeId });
  });

  it('writes nothing for a viewer, a photo change, or an unadmitted owner', async () => {
    for (const attempt of [
      run(store({ shares: [shareDoc(dinners, 'viewer')] })),
      run(store({ shares: [shareDoc(dinners)] })),
      run(store(), true, editedPayload({ galleryPhotoIds: [otherPhoto] })),
      run(store(), false),
    ]) {
      await expect(attempt.result).resolves.toEqual({ applied: false, reason: 'invalid' });
      expect(attempt.writes).toEqual([]);
    }
  });
});

describe('sharedRecipeDeleteAllowed', () => {
  const editor: SharedRecipeAccess = { ownerSub: 'owner', role: 'editor', recipe: ownerRecipe };

  it('lets the owner delete and refuses an editor or viewer', () => {
    expect(sharedRecipeDeleteAllowed(true, null)).toBe(true);
    expect(sharedRecipeDeleteAllowed(false, null)).toBe(true);
    expect(sharedRecipeDeleteAllowed(false, editor)).toBe(false);
    expect(sharedRecipeDeleteAllowed(false, { ...editor, role: 'viewer' })).toBe(false);
  });
});
