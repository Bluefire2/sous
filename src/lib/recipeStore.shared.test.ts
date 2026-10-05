import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { recipeStore } from './recipeStore';
import {
  clearLibrary,
  getRecipe,
  getRecipeOrigin,
  originAccess,
  recipeAccess,
  replaceFromPullWithShared,
  withSharedRecipeAccess,
  type ItemOrigin,
} from './libraryMemory';
import { pushOps } from './remote';
import type { PushOp } from './pushOps';
import type { Collection, Recipe } from './types';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
}));

vi.mock('./syncEngine', () => ({
  localWriteOverlapsPull: vi.fn(() => false),
  pullAfterLocalWrite: vi.fn(),
}));

const EDITABLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIEW_ONLY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EDIT_COLLECTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VIEW_COLLECTION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COVER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const GALLERY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_PHOTO = '12345678-1234-4234-8234-123456789012';

function recipe(id: string, lang?: string): Recipe {
  return {
    id,
    createdAt: 1,
    updatedAt: 2,
    title: 'Soup',
    servings: 4,
    ingredientSections: [{ items: [{ item: 'water' }] }],
    steps: [{ text: 'Boil.' }],
    tags: [],
    photoId: COVER,
    galleryPhotoIds: [GALLERY],
    ...(lang === undefined ? {} : { lang }),
  };
}

function collection(id: string, recipeIds: string[]): Collection {
  return { id, name: id, recipeIds, createdAt: 1, updatedAt: 2 };
}

const shared = (access?: 'editor' | 'viewer'): ItemOrigin => ({
  kind: 'shared',
  ownerSub: 'owner',
  ...(access ? { access } : {}),
});

function publishShared(editableLang?: string, editableVariantOf?: string): void {
  const collections = new Map([
    [EDIT_COLLECTION, collection(EDIT_COLLECTION, [EDITABLE_ID])],
    [VIEW_COLLECTION, collection(VIEW_COLLECTION, [VIEW_ONLY_ID])],
  ]);
  const collectionOrigins = new Map<string, ItemOrigin>([
    [EDIT_COLLECTION, shared('editor')],
    [VIEW_COLLECTION, shared('viewer')],
  ]);
  replaceFromPullWithShared(
    {
      recipes: new Map(),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    },
    {
      recipes: new Map([
        [
          EDITABLE_ID,
          {
            ...recipe(EDITABLE_ID, editableLang),
            ...(editableVariantOf === undefined ? {} : { variantOf: editableVariantOf }),
          },
        ],
        [VIEW_ONLY_ID, recipe(VIEW_ONLY_ID)],
      ]),
      collections,
      remotePhotoIds: new Set([COVER, GALLERY]),
      recipeOrigins: withSharedRecipeAccess(
        new Map([
          [EDITABLE_ID, shared()],
          [VIEW_ONLY_ID, shared()],
        ]),
        collections,
        collectionOrigins,
      ),
      collectionOrigins,
    },
  );
}

function pushed(): PushOp[] {
  return vi.mocked(pushOps).mock.calls.flatMap(([ops]) => ops);
}

afterEach(() => {
  clearLibrary();
  vi.mocked(pushOps).mockReset();
});

describe('shared recipe access', () => {
  it('reads a missing access as viewer and an own row as owner', () => {
    expect(originAccess({ kind: 'own' })).toBe('owner');
    expect(originAccess(shared())).toBe('viewer');
    expect(originAccess(shared('editor'))).toBe('editor');
    expect(originAccess(undefined)).toBeUndefined();
  });

  it('makes a recipe editable when any editor collection lists it', () => {
    const collections = new Map([
      [EDIT_COLLECTION, collection(EDIT_COLLECTION, [EDITABLE_ID])],
      [VIEW_COLLECTION, collection(VIEW_COLLECTION, [EDITABLE_ID, VIEW_ONLY_ID])],
    ]);
    const next = withSharedRecipeAccess(
      new Map<string, ItemOrigin>([
        [EDITABLE_ID, shared()],
        [VIEW_ONLY_ID, shared('editor')],
        ['own', { kind: 'own' }],
      ]),
      collections,
      new Map([
        [EDIT_COLLECTION, shared('editor')],
        [VIEW_COLLECTION, shared()],
      ]),
    );
    expect(originAccess(next.get(EDITABLE_ID))).toBe('editor');
    expect(originAccess(next.get(VIEW_ONLY_ID))).toBe('viewer');
    expect(next.get('own')).toEqual({ kind: 'own' });
  });

  it('gives a shared recipe the owner email from a collection that lists it', () => {
    const next = withSharedRecipeAccess(
      new Map<string, ItemOrigin>([
        [EDITABLE_ID, shared()],
        [VIEW_ONLY_ID, shared()],
        ['own', { kind: 'own' }],
      ]),
      new Map([[VIEW_COLLECTION, collection(VIEW_COLLECTION, [EDITABLE_ID])]]),
      new Map<string, ItemOrigin>([
        [VIEW_COLLECTION, { kind: 'shared', ownerSub: 'owner', ownerEmail: 'owner@example.com' }],
      ]),
    );
    expect(next.get(EDITABLE_ID)).toMatchObject({ ownerEmail: 'owner@example.com' });
    // Not listed by any collection with an email: no email, never a guess.
    expect(next.get(VIEW_ONLY_ID)).not.toHaveProperty('ownerEmail');
    expect(next.get('own')).toEqual({ kind: 'own' });
  });

  it('copies the owner email only from that recipe owner', () => {
    const next = withSharedRecipeAccess(
      new Map<string, ItemOrigin>([
        [EDITABLE_ID, { kind: 'shared', ownerSub: 'alice' }],
        [VIEW_ONLY_ID, { kind: 'shared', ownerSub: 'alice' }],
      ]),
      new Map([
        ['alice-col', collection('alice-col', [EDITABLE_ID])],
        // Listed later, so a map keyed only by recipe id would keep this email.
        ['bob-col', collection('bob-col', [EDITABLE_ID, VIEW_ONLY_ID])],
      ]),
      new Map<string, ItemOrigin>([
        ['alice-col', { kind: 'shared', ownerSub: 'alice', ownerEmail: 'alice@example.com' }],
        ['bob-col', { kind: 'shared', ownerSub: 'bob', ownerEmail: 'bob@example.com' }],
      ]),
    );
    expect(next.get(EDITABLE_ID)).toMatchObject({ ownerEmail: 'alice@example.com' });
    expect(next.get(VIEW_ONLY_ID)).not.toHaveProperty('ownerEmail');
  });

  it('is published with the shared pull and is not a Recipe field', () => {
    publishShared();
    expect(recipeAccess(EDITABLE_ID)).toBe('editor');
    expect(recipeAccess(VIEW_ONLY_ID)).toBe('viewer');
    expect(getRecipe(EDITABLE_ID)).not.toHaveProperty('access');
  });
});

describe('recipeStore on a shared recipe', () => {
  it('saves an editor change as one shared recipe.put, with no photo ops', async () => {
    publishShared();
    vi.mocked(pushOps).mockResolvedValue('ok');
    await recipeStore.save({ ...recipe(EDITABLE_ID), title: 'Better soup', createdAt: 99 });
    const ops = pushed();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'recipe.put',
      shared: true,
      payload: { id: EDITABLE_ID, title: 'Better soup', createdAt: 1, photoId: COVER },
    });
    expect(getRecipe(EDITABLE_ID)?.title).toBe('Better soup');
    expect(getRecipeOrigin(EDITABLE_ID)).toMatchObject({ kind: 'shared', access: 'editor' });
  });

  it('refuses an editor photo change before pushing anything', async () => {
    publishShared();
    for (const change of [
      { photoId: OTHER_PHOTO },
      { photoId: undefined },
      { galleryPhotoIds: [GALLERY, OTHER_PHOTO] },
      { galleryPhotoIds: undefined },
    ]) {
      await expect(
        recipeStore.save({ ...recipe(EDITABLE_ID), ...change }),
      ).rejects.toThrow("Photos on a shared recipe can't be changed.");
    }
    expect(pushOps).not.toHaveBeenCalled();
    expect(getRecipe(EDITABLE_ID)).toEqual(recipe(EDITABLE_ID));
  });

  it('does not restore a shared recipe after sign-out', async () => {
    publishShared();
    vi.mocked(pushOps).mockImplementation(async () => {
      clearLibrary();
      return 'signedOut';
    });

    await expect(
      recipeStore.save({ ...recipe(EDITABLE_ID), title: 'Better soup' }),
    ).rejects.toThrow(t('error.sessionExpired'));

    expect(getRecipe(EDITABLE_ID)).toBeUndefined();
  });

  it('does not roll a failed editor save back over a newer in-flight save', async () => {
    publishShared();
    let releaseFirst: (result: 'invalid') => void = () => {};
    let calls = 0;
    vi.mocked(pushOps).mockImplementation(
      () =>
        new Promise((resolve) => {
          calls += 1;
          if (calls === 1) {
            releaseFirst = resolve;
            return;
          }
          resolve('ok');
        }),
    );

    const first = recipeStore.save({ ...recipe(EDITABLE_ID), title: 'First' });
    const rejected = expect(first).rejects.toThrow("Couldn't save the recipe.");
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalledOnce());
    const second = recipeStore.save({ ...recipe(EDITABLE_ID), title: 'Second' });
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalledTimes(2));
    releaseFirst('invalid');

    await rejected;
    await second;
    expect(getRecipe(EDITABLE_ID)?.title).toBe('Second');
  });

  it('rolls back an editor save the server discards, keeping the shared origin', async () => {
    publishShared();
    vi.mocked(pushOps).mockResolvedValue('invalid');
    await expect(
      recipeStore.save({ ...recipe(EDITABLE_ID), title: 'Better soup' }),
    ).rejects.toThrow("Couldn't save the recipe.");
    expect(getRecipe(EDITABLE_ID)?.title).toBe('Soup');
    expect(recipeAccess(EDITABLE_ID)).toBe('editor');
  });

  it('keeps lang when an editor saves and when an Ask draft omits it', async () => {
    publishShared('it');
    vi.mocked(pushOps).mockResolvedValue('ok');
    await recipeStore.save({ ...recipe(EDITABLE_ID, 'it'), title: 'Minestra' });
    expect(pushed()[0]).toMatchObject({
      shared: true,
      payload: { title: 'Minestra', lang: 'it', photoId: COVER },
    });
    const { id: _id, createdAt: _c, updatedAt: _u, lang: _lang, ...draft } = recipe(
      EDITABLE_ID,
      'it',
    );
    await recipeStore.applyDraft(EDITABLE_ID, { ...draft, title: 'Zuppa' });
    expect(pushed().at(-1)).toMatchObject({
      shared: true,
      payload: { title: 'Zuppa', lang: 'it' },
    });
  });

  it("keeps the owner's variantOf when an editor saves without it or with another", async () => {
    publishShared(undefined, VIEW_ONLY_ID);
    vi.mocked(pushOps).mockResolvedValue('ok');
    await recipeStore.save({ ...recipe(EDITABLE_ID), title: 'Better soup' });
    await recipeStore.save({ ...recipe(EDITABLE_ID), title: 'Best soup', variantOf: OTHER_PHOTO });
    for (const op of pushed()) {
      expect(op).toMatchObject({ shared: true, payload: { variantOf: VIEW_ONLY_ID } });
    }
    expect(pushed()).toHaveLength(2);
    expect(getRecipe(EDITABLE_ID)).toMatchObject({ title: 'Best soup', variantOf: VIEW_ONLY_ID });
  });

  it('keeps photos when an editor applies an Ask draft', async () => {
    publishShared();
    vi.mocked(pushOps).mockResolvedValue('ok');
    const { id: _id, createdAt: _c, updatedAt: _u, ...draft } = recipe(EDITABLE_ID);
    await recipeStore.applyDraft(EDITABLE_ID, {
      ...draft,
      title: 'Spicy soup',
      photoId: OTHER_PHOTO,
      galleryPhotoIds: [OTHER_PHOTO],
    });
    expect(pushed()[0]).toMatchObject({
      shared: true,
      payload: { title: 'Spicy soup', photoId: COVER, galleryPhotoIds: [GALLERY] },
    });
  });

  it('keeps a viewer read-only and never lets an editor delete', async () => {
    publishShared();
    await expect(
      recipeStore.save({ ...recipe(VIEW_ONLY_ID), title: 'Mine now' }),
    ).rejects.toThrow('view-only');
    await expect(recipeStore.remove(EDITABLE_ID)).rejects.toThrow('view-only');
    await expect(recipeStore.remove(VIEW_ONLY_ID)).rejects.toThrow('view-only');
    expect(pushOps).not.toHaveBeenCalled();
  });
});
