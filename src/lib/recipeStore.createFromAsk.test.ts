import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { recipeStore } from './recipeStore';
import {
  addPendingBlob,
  clearLibrary,
  getPendingBlob,
  getRecipe,
  getSnapshot,
  listRecipes,
  upsertRecipe,
} from './libraryMemory';
import { fetchPhotoBlobOutcome, postPhoto, pushOps } from './remote';
import { installSharedRows } from './testLibrary';
import { installPhotoServerFake } from './testPhotoServer';
import type { Recipe, RecipeDraft } from './types';

vi.mock('./remote', () => ({
  postPhoto: vi.fn(),
  pushOps: vi.fn(),
  fetchPhotoBlobOutcome: vi.fn(),
}));

const COVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GALLERY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const draft: RecipeDraft = {
  title: 'Variant',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'salt' }] }],
  steps: [{ text: 'Stir.' }],
  tags: ['dinner'],
};

function parentRecipe(photoId?: string, galleryPhotoIds?: string[]): Recipe {
  return {
    id: PARENT_ID,
    title: 'Original',
    servings: 4,
    ingredientSections: [{ items: [{ item: 'water' }] }],
    steps: [{ text: 'Boil.' }],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
    ...(photoId !== undefined ? { photoId } : {}),
    ...(galleryPhotoIds !== undefined ? { galleryPhotoIds } : {}),
  };
}

afterEach(() => {
  clearLibrary();
  vi.mocked(postPhoto).mockReset();
  vi.mocked(pushOps).mockReset();
  vi.mocked(fetchPhotoBlobOutcome).mockReset();
});

describe('recipeStore.createFromAsk', () => {
  it('copies the cover and gallery onto new ids and uploads those', async () => {
    const coverBlob = new Blob(['cover'], { type: 'image/jpeg' });
    const galleryBlob = new Blob(['gallery'], { type: 'image/jpeg' });
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    addPendingBlob(COVER, coverBlob);
    vi.mocked(fetchPhotoBlobOutcome).mockImplementation(async (id) =>
      id === GALLERY ? galleryBlob : 'missing',
    );
    const server = installPhotoServerFake();

    const created = await recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft);

    expect(server.calls).toEqual([
      'push:recipe.put',
      `photo:${created.photoId}`,
      `photo:${created.galleryPhotoIds?.[0]}`,
    ]);
    expect(created.photoId).toBeDefined();
    expect(created.photoId).not.toBe(COVER);
    expect(created.galleryPhotoIds).toEqual([expect.any(String)]);
    expect(created.galleryPhotoIds?.[0]).not.toBe(GALLERY);
    expect(created.galleryPhotoIds?.[0]).not.toBe(created.photoId);
    expect(fetchPhotoBlobOutcome).toHaveBeenCalledTimes(1);
    expect(fetchPhotoBlobOutcome).toHaveBeenCalledWith(GALLERY, undefined);
    expect(postPhoto).toHaveBeenCalledWith(
      created.photoId,
      created.id,
      created.updatedAt,
      coverBlob,
    );
    expect(postPhoto).toHaveBeenCalledWith(
      created.galleryPhotoIds?.[0],
      created.id,
      created.updatedAt,
      galleryBlob,
    );
    const pushed = vi.mocked(pushOps).mock.calls[0]?.[0];
    expect(pushed?.[0]).toMatchObject({
      kind: 'recipe.put',
      payload: { id: created.id, photoId: created.photoId, galleryPhotoIds: created.galleryPhotoIds },
    });
  });

  it('fetches a shared parent photo with the owner sub', async () => {
    const parent = parentRecipe(COVER, [GALLERY]);
    installSharedRows({
      recipes: new Map([[parent.id, parent]]),
      collections: new Map(),
      remotePhotoIds: new Set([COVER, GALLERY]),
      recipeOrigins: new Map([[parent.id, { kind: 'shared', ownerSub: 'owner-1' }]]),
      collectionOrigins: new Map(),
    });
    vi.mocked(fetchPhotoBlobOutcome).mockResolvedValue(new Blob(['bytes'], { type: 'image/jpeg' }));
    installPhotoServerFake();

    await recipeStore.createFromAsk(parent, draft);

    expect(fetchPhotoBlobOutcome).toHaveBeenCalledWith(COVER, 'owner-1');
    expect(fetchPhotoBlobOutcome).toHaveBeenCalledWith(GALLERY, 'owner-1');
  });

  it('omits a photo that could not be copied and still saves the recipe', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlobOutcome).mockImplementation(async (id) =>
      id === COVER ? new Blob(['cover'], { type: 'image/jpeg' }) : 'missing',
    );
    installPhotoServerFake();

    const created = await recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft);

    expect(created.photoId).toBeDefined();
    expect(created.galleryPhotoIds).toBeUndefined();
    expect(getRecipe(created.id)?.photoId).toBe(created.photoId);
  });

  it('creates nothing when the photo fetch signs the user out', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlobOutcome).mockImplementation(async (id) =>
      id === COVER ? new Blob(['cover'], { type: 'image/jpeg' }) : 'signedOut',
    );

    await expect(recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft)).rejects.toThrow(
      t('error.sessionExpired'),
    );
    expect(listRecipes().map((recipe) => recipe.id)).toEqual([PARENT_ID]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
    expect(pushOps).not.toHaveBeenCalled();
  });

  it('saves nothing when a photo fetch fails temporarily', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlobOutcome).mockImplementation(async (id) =>
      id === COVER ? new Blob(['cover'], { type: 'image/jpeg' }) : 'unavailable',
    );

    await expect(recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft)).rejects.toThrow(
      t('error.photosCopy'),
    );
    expect(listRecipes().map((recipe) => recipe.id)).toEqual([PARENT_ID]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
    expect(pushOps).not.toHaveBeenCalled();
  });

  it('leaves no recipe and drops copied blobs when create fails', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlobOutcome).mockResolvedValue(new Blob(['bytes'], { type: 'image/jpeg' }));
    installPhotoServerFake({ failPush: () => 'error' });

    await expect(recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft)).rejects.toThrow(
      t('error.recipeSave'),
    );
    expect(postPhoto).not.toHaveBeenCalled();
    expect(listRecipes().map((recipe) => recipe.id)).toEqual([PARENT_ID]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });

  it('deletes the new recipe when a copied photo does not upload', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlobOutcome).mockResolvedValue(new Blob(['bytes'], { type: 'image/jpeg' }));
    const server = installPhotoServerFake({ failPhoto: () => 'error' });

    await expect(recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft)).rejects.toThrow(
      t('error.photoSave'),
    );
    const put = server.pushed.find((op) => op.kind === 'recipe.put');
    expect(put).toBeDefined();
    expect(server.pushed.at(-1)).toMatchObject({
      kind: 'recipe.delete',
      payload: { id: put?.payload.id },
    });
    expect(server.liveRecipeIds.size).toBe(0);
    expect(listRecipes().map((recipe) => recipe.id)).toEqual([PARENT_ID]);
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });

  it('drops the moved copies when the cleanup delete is not confirmed', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlobOutcome).mockResolvedValue(new Blob(['bytes'], { type: 'image/jpeg' }));
    installPhotoServerFake({
      failPush: (ops) => (ops[0]?.kind === 'recipe.delete' ? 'error' : undefined),
      failPhoto: () => 'error',
    });

    await expect(recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), draft)).rejects.toThrow(
      t('error.photoSave'),
    );
    // A retry copies from the parent again, so nothing is kept for it.
    expect(getSnapshot().pendingBlobs.size).toBe(0);
  });

  it('ignores a photo id on the proposal', async () => {
    upsertRecipe(parentRecipe(COVER, [GALLERY]));
    vi.mocked(fetchPhotoBlobOutcome).mockResolvedValue(new Blob(['bytes'], { type: 'image/jpeg' }));
    installPhotoServerFake();

    const created = await recipeStore.createFromAsk(parentRecipe(COVER, [GALLERY]), {
      ...draft,
      photoId: 'hallucinated-cover',
      galleryPhotoIds: ['hallucinated-gallery'],
    });

    expect(created.photoId).not.toBe('hallucinated-cover');
    expect(created.photoId).not.toBe(COVER);
    expect(created.galleryPhotoIds).not.toContain('hallucinated-gallery');
    expect(created.galleryPhotoIds).not.toContain(GALLERY);
    expect(getPendingBlob(COVER)).toBeUndefined();
  });

  it('copies lang from an owned parent', async () => {
    const parent = { ...parentRecipe(), lang: 'it' };
    upsertRecipe(parent);
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parent, { ...draft, lang: 'fr' });

    expect(created.lang).toBe('it');
    expect(getRecipe(created.id)?.lang).toBe('it');
    const pushed = vi.mocked(pushOps).mock.calls[0]?.[0];
    expect(pushed?.[0]).toMatchObject({
      kind: 'recipe.put',
      payload: { id: created.id, lang: 'it' },
    });
  });

  it('copies lang from a shared parent', async () => {
    const parent = { ...parentRecipe(), lang: 'uk' };
    installSharedRows({
      recipes: new Map([[parent.id, parent]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([[parent.id, { kind: 'shared', ownerSub: 'owner-1' }]]),
      collectionOrigins: new Map(),
    });
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parent, draft);

    expect(recipeStore.isShared(parent.id)).toBe(true);
    expect(created.lang).toBe('uk');
    expect(recipeStore.isShared(created.id)).toBe(false);
    expect(getRecipe(created.id)?.lang).toBe('uk');
  });
});

describe('recipeStore.createFromAsk variant group', () => {
  const ORIGINAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  it('records an owned parent as the original', async () => {
    const parent = parentRecipe();
    upsertRecipe(parent);
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parent, draft);

    expect(created.variantOf).toBe(PARENT_ID);
    expect(getRecipe(created.id)?.variantOf).toBe(PARENT_ID);
    const pushed = vi.mocked(pushOps).mock.calls[0]?.[0];
    expect(pushed?.[0]).toMatchObject({ kind: 'recipe.put', payload: { variantOf: PARENT_ID } });
    // Nothing is written to the parent.
    expect(getRecipe(PARENT_ID)).toEqual(parent);
    expect(vi.mocked(pushOps).mock.calls).toHaveLength(1);
  });

  it("joins a variant parent's group instead of nesting under it", async () => {
    const parent = { ...parentRecipe(), variantOf: ORIGINAL };
    upsertRecipe(parent);
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parent, draft);

    expect(created.variantOf).toBe(ORIGINAL);
  });

  it('records a shared parent too', async () => {
    const parent = parentRecipe();
    installSharedRows({
      recipes: new Map([[parent.id, parent]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([[parent.id, { kind: 'shared', ownerSub: 'owner-1' }]]),
      collectionOrigins: new Map(),
    });
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parent, draft);

    expect(created.variantOf).toBe(PARENT_ID);
    expect(recipeStore.isShared(created.id)).toBe(false);
  });

  it('ignores a variantOf on the proposal', async () => {
    const parent = parentRecipe();
    upsertRecipe(parent);
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parent, { ...draft, variantOf: ORIGINAL });

    expect(created.variantOf).toBe(PARENT_ID);
  });
});

describe('saving a variant', () => {
  const ORIGINAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const variant = (): Recipe => ({ ...parentRecipe(), variantOf: ORIGINAL });

  it('keeps the stored variantOf on a save that rebuilds the record without it', async () => {
    upsertRecipe(variant());
    vi.mocked(pushOps).mockResolvedValue('ok');
    const { variantOf: _dropped, ...rebuilt } = variant();

    await recipeStore.save({ ...rebuilt, title: 'Renamed' });

    expect(getRecipe(PARENT_ID)).toMatchObject({ title: 'Renamed', variantOf: ORIGINAL });
    const pushed = vi.mocked(pushOps).mock.calls[0]?.[0];
    expect(pushed?.[0]).toMatchObject({ kind: 'recipe.put', payload: { variantOf: ORIGINAL } });
  });

  it('cannot set, change, or clear it through a save', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');
    upsertRecipe(variant());
    await recipeStore.save({ ...variant(), variantOf: OTHER });
    expect(getRecipe(PARENT_ID)?.variantOf).toBe(ORIGINAL);
    await recipeStore.save({ ...variant(), variantOf: undefined });
    expect(getRecipe(PARENT_ID)?.variantOf).toBe(ORIGINAL);

    upsertRecipe(parentRecipe());
    await recipeStore.save({ ...parentRecipe(), variantOf: OTHER });
    expect(getRecipe(PARENT_ID)).not.toHaveProperty('variantOf');
  });

  it('keeps it through Ask Apply and a replacement import', async () => {
    upsertRecipe(variant());
    vi.mocked(pushOps).mockResolvedValue('ok');

    await recipeStore.applyDraft(PARENT_ID, draft);
    expect(getRecipe(PARENT_ID)?.variantOf).toBe(ORIGINAL);

    await recipeStore.replaceFromImport(PARENT_ID, { ...draft, title: 'Reimported' }, undefined);
    expect(getRecipe(PARENT_ID)).toMatchObject({ title: 'Reimported', variantOf: ORIGINAL });
  });
});

describe('recipeStore.applyDraft', () => {
  it('keeps the existing lang when the draft omits it', async () => {
    const existing = { ...parentRecipe(), lang: 'it', sourceUrl: 'https://example.com/soup' };
    upsertRecipe(existing);
    vi.mocked(pushOps).mockResolvedValue('ok');

    await recipeStore.applyDraft(existing.id, draft);

    expect(getRecipe(existing.id)?.lang).toBe('it');
    expect(getRecipe(existing.id)?.sourceUrl).toBe('https://example.com/soup');
    expect(getRecipe(existing.id)?.title).toBe(draft.title);
  });
});

describe('step lanes through Ask (docs/plans/parallel-steps.md)', () => {
  const laned = (): Recipe => ({
    ...parentRecipe(),
    steps: [
      { text: 'Boil.' },
      { text: 'Fry garlic.', lane: 'Sauce' },
      { text: 'Cook pasta.', lane: 'Pasta' },
    ],
  });

  it('Apply keeps stored lanes when the proposal has none', async () => {
    upsertRecipe(laned());
    vi.mocked(pushOps).mockResolvedValue('ok');

    await recipeStore.applyDraft(PARENT_ID, {
      ...draft,
      steps: [{ text: 'Boil.' }, { text: 'Fry garlic.' }, { text: 'Cook spaghetti.' }],
    });

    expect(getRecipe(PARENT_ID)?.steps).toEqual([
      { text: 'Boil.' },
      { text: 'Fry garlic.', lane: 'Sauce' },
      { text: 'Cook spaghetti.' },
    ]);
  });

  it('Apply takes a proposal that sets lanes as it is', async () => {
    upsertRecipe(laned());
    vi.mocked(pushOps).mockResolvedValue('ok');
    const steps = [{ text: 'Boil.', lane: 'Pasta' }, { text: 'Fry garlic.' }];

    await recipeStore.applyDraft(PARENT_ID, { ...draft, steps });

    expect(getRecipe(PARENT_ID)?.steps).toEqual(steps);
  });

  it('Save as variant carries the parent lanes', async () => {
    const parent = laned();
    upsertRecipe(parent);
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.createFromAsk(parent, {
      ...draft,
      steps: parent.steps.map(({ text }) => ({ text })),
    });

    expect(created.steps).toEqual(parent.steps);
  });
});

describe('recipeStore.create', () => {
  it('keeps lang when the draft has one', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await recipeStore.create({ ...draft, lang: 'zh-CN' });

    expect(created.lang).toBe('zh-Hans');
    expect(getRecipe(created.id)?.lang).toBe('zh-Hans');
  });
});
