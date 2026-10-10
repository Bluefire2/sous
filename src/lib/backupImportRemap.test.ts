import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLibrary,
  getRecipe,
  replaceFromPull,
} from './libraryMemory';
import { installSharedRows } from './testLibrary';
import {
  backupGraphIds,
  cloneUuid,
  decideBackupImportMode,
  deterministicCloneIds,
  remapBackupImport,
  type BackupGraphIds,
  type BackupImportEntities,
} from './backupImportRemap';
import type { ChatMessage, Collection, CookStateRow, Recipe } from './types';

const ALICE = 'alice-sub';
const CAROL = 'carol-sub';
afterEach(() => {
  clearLibrary();
});

const ALICE_RECIPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALICE_COLLECTION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALICE_PHOTO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ALICE_CHAT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function seqUuid(): () => string {
  let n = 0;
  return () =>
    `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function entities(overrides: Partial<BackupImportEntities> = {}): BackupImportEntities {
  const recipe: Recipe = {
    id: ALICE_RECIPE,
    title: 'Soup',
    servings: 2,
    ingredientSections: [{ items: [{ item: 'water' }] }],
    steps: [{ text: 'Boil' }],
    tags: [],
    photoId: ALICE_PHOTO,
    galleryPhotoIds: [ALICE_PHOTO],
    lang: 'it',
    createdAt: 1,
    updatedAt: 2,
  };
  const collection: Collection = {
    id: ALICE_COLLECTION,
    name: 'Mine',
    recipeIds: [ALICE_RECIPE],
    createdAt: 1,
    updatedAt: 2,
  };
  const chat: ChatMessage = {
    id: ALICE_CHAT,
    recipeId: ALICE_RECIPE,
    role: 'user',
    content: 'hi',
    photoIds: [ALICE_PHOTO],
    createdAt: 3,
  };
  const cook: CookStateRow = {
    recipeId: ALICE_RECIPE,
    servings: 2,
    currentStep: 0,
    checkedKeys: ['0:0'],
    recipeUpdatedAt: 2,
  };
  return {
    recipes: [recipe],
    collections: [collection],
    chatMessages: [chat],
    cookState: [cook],
    cookLogs: [],
    backupPhotoIds: [ALICE_PHOTO],
    ...overrides,
  };
}

function graphIds(
  values: Partial<Record<keyof BackupGraphIds, string[]>> = {},
): BackupGraphIds {
  return {
    recipeIds: new Set(values.recipeIds),
    collectionIds: new Set(values.collectionIds),
    chatMessageIds: new Set(values.chatMessageIds),
    cookLogIds: new Set(values.cookLogIds),
    photoIds: new Set(values.photoIds),
  };
}

describe('decideBackupImportMode', () => {
  const backupIds = graphIds({
    recipeIds: [ALICE_RECIPE],
    collectionIds: [ALICE_COLLECTION],
    chatMessageIds: [ALICE_CHAT],
    photoIds: [ALICE_PHOTO],
  });

  it('preserves explicit same-account provenance regardless of overlap', () => {
    expect(
      decideBackupImportMode(ALICE, ALICE, backupIds, graphIds()),
    ).toBe('preserve');
  });

  it('clones explicit foreign provenance despite owned overlap', () => {
    expect(
      decideBackupImportMode(ALICE, CAROL, backupIds, backupIds),
    ).toBe('clone');
  });

  it.each([
    ['recipeIds', ALICE_RECIPE],
    ['collectionIds', ALICE_COLLECTION],
    ['chatMessageIds', ALICE_CHAT],
    ['photoIds', ALICE_PHOTO],
  ] as const)('preserves missing provenance on owned %s overlap', (key, id) => {
    expect(
      decideBackupImportMode(
        undefined,
        ALICE,
        backupIds,
        graphIds({ [key]: [id] }),
      ),
    ).toBe('preserve');
  });

  it('clones missing provenance with no overlap or cross-namespace overlap', () => {
    expect(
      decideBackupImportMode(undefined, ALICE, backupIds, graphIds()),
    ).toBe('clone');
    expect(
      decideBackupImportMode(
        undefined,
        ALICE,
        backupIds,
        graphIds({ photoIds: [ALICE_RECIPE] }),
      ),
    ).toBe('clone');
  });
});

describe('cloneUuid', () => {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('is a stable version-8 UUID the server accepts', async () => {
    const first = await cloneUuid(CAROL, 'recipe', ALICE_RECIPE);
    expect(first).toMatch(UUID_RE);
    expect(first[14]).toBe('8');
    expect(await cloneUuid(CAROL, 'recipe', ALICE_RECIPE)).toBe(first);
    expect(first).not.toBe(ALICE_RECIPE);
  });

  it('differs by importing account and by namespace', async () => {
    const carol = await cloneUuid(CAROL, 'recipe', ALICE_RECIPE);
    expect(await cloneUuid(ALICE, 'recipe', ALICE_RECIPE)).not.toBe(carol);
    expect(await cloneUuid(CAROL, 'photo', ALICE_RECIPE)).not.toBe(carol);
  });

  it('clone mode with deterministic ids is idempotent across imports', async () => {
    const input = entities();
    const cloneIds = await deterministicCloneIds(backupGraphIds(input), CAROL);
    const first = remapBackupImport(input, 'clone', cloneIds);
    const second = remapBackupImport(
      input,
      'clone',
      await deterministicCloneIds(backupGraphIds(input), CAROL),
    );
    expect(second).toEqual(first);
    expect(first.recipes[0]?.id).toBe(await cloneUuid(CAROL, 'recipe', ALICE_RECIPE));
    expect(first.collections[0]?.recipeIds).toEqual([first.recipes[0]?.id]);
  });
});

describe('remapBackupImport', () => {
  it('same-account mode keeps ids and references', () => {
    const input = entities();
    const out = remapBackupImport(input, 'preserve', seqUuid());
    expect(out.recipes[0]?.id).toBe(ALICE_RECIPE);
    expect(out.recipes[0]?.lang).toBe('it');
    expect(out.collections[0]?.id).toBe(ALICE_COLLECTION);
    expect(out.collections[0]?.recipeIds).toEqual([ALICE_RECIPE]);
    expect(out.chatMessages[0]?.id).toBe(ALICE_CHAT);
    expect(out.chatMessages[0]?.recipeId).toBe(ALICE_RECIPE);
    expect(out.cookState[0]?.recipeId).toBe(ALICE_RECIPE);
    expect(out.photoIdMap.get(ALICE_PHOTO)).toBe(ALICE_PHOTO);
  });

  it('clone mode remaps every entity and reference', () => {
    const input = entities();
    const nextUuid = seqUuid();
    const out = remapBackupImport(input, 'clone', nextUuid);
    const newRecipe = out.recipes[0]!;
    const newCollection = out.collections[0]!;
    const newChat = out.chatMessages[0]!;
    const newCook = out.cookState[0]!;
    const newPhoto = out.photoIdMap.get(ALICE_PHOTO)!;

    expect(newRecipe.id).not.toBe(ALICE_RECIPE);
    expect(newCollection.id).not.toBe(ALICE_COLLECTION);
    expect(newChat.id).not.toBe(ALICE_CHAT);
    expect(newPhoto).not.toBe(ALICE_PHOTO);

    expect(newCollection.recipeIds).toEqual([newRecipe.id]);
    expect(newRecipe.photoId).toBe(newPhoto);
    expect(newRecipe.lang).toBe('it');
    expect(newRecipe.galleryPhotoIds).toEqual([newPhoto]);
    expect(newChat.recipeId).toBe(newRecipe.id);
    expect(newChat.photoIds).toEqual([newPhoto]);
    expect(newCook.recipeId).toBe(newRecipe.id);
  });

  it('clone mode remaps variantOf through the recipe map and keeps an id outside it', () => {
    const variantId = '12121212-1212-4121-8121-121212121212';
    const sharedVariantId = '13131313-1313-4131-8131-131313131313';
    const sharedOriginal = '14141414-1414-4141-8141-141414141414';
    const base = entities().recipes[0]!;
    const input = entities({
      recipes: [
        base,
        { ...base, id: variantId, title: 'Spicy soup', variantOf: ALICE_RECIPE },
        { ...base, id: sharedVariantId, title: 'Their soup', variantOf: sharedOriginal },
      ],
    });
    // A shared original is never exported, so it must not join the graph.
    expect(backupGraphIds(input).recipeIds.has(sharedOriginal)).toBe(false);

    const out = remapBackupImport(input, 'clone', seqUuid());
    const [original, variant, sharedVariant] = out.recipes;
    expect(variant?.variantOf).toBe(original?.id);
    expect(variant?.variantOf).not.toBe(ALICE_RECIPE);
    expect(sharedVariant?.variantOf).toBe(sharedOriginal);
    expect(original?.variantOf).toBeUndefined();
  });

  it('builds complete recipe and photo ID universes from entities and references', () => {
    const orphanRecipe = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const orphanPhoto = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const input = entities({
      recipes: [],
      collections: [{ ...entities().collections[0]!, recipeIds: [orphanRecipe] }],
      chatMessages: [
        {
          ...entities().chatMessages[0]!,
          recipeId: orphanRecipe,
          photoIds: [orphanPhoto],
        },
      ],
      cookState: [{ ...entities().cookState[0]!, recipeId: orphanRecipe }],
      backupPhotoIds: [],
    });

    expect(backupGraphIds(input)).toEqual({
      recipeIds: new Set([orphanRecipe]),
      collectionIds: new Set([ALICE_COLLECTION]),
      chatMessageIds: new Set([ALICE_CHAT]),
      cookLogIds: new Set(),
      photoIds: new Set([orphanPhoto]),
    });
  });

  it('remaps orphan collection/chat/cook recipe and photo references consistently', () => {
    const orphanRecipe = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const orphanPhoto = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const input = entities({
      recipes: [],
      collections: [{ ...entities().collections[0]!, recipeIds: [orphanRecipe] }],
      cookState: [
        {
          recipeId: orphanRecipe,
          servings: 1,
          currentStep: 0,
          checkedKeys: [],
          recipeUpdatedAt: 0,
        },
      ],
      chatMessages: [
        {
          id: ALICE_CHAT,
          recipeId: orphanRecipe,
          role: 'assistant',
          content: 'orphan',
          photoIds: [orphanPhoto],
          createdAt: 1,
        },
      ],
      backupPhotoIds: [],
    });
    const out = remapBackupImport(input, 'clone', seqUuid());
    const remappedRecipeId = out.collections[0]!.recipeIds[0]!;
    const remappedPhotoId = out.chatMessages[0]!.photoIds![0]!;

    expect(remappedRecipeId).not.toBe(orphanRecipe);
    expect(out.chatMessages[0]?.recipeId).toBe(remappedRecipeId);
    expect(out.cookState[0]?.recipeId).toBe(remappedRecipeId);
    expect(remappedPhotoId).not.toBe(orphanPhoto);
    expect(out.photoIdMap.get(orphanPhoto)).toBe(remappedPhotoId);
  });

  it('import-then-share: cloned ids do not block Alice shared originals', () => {
    const nextUuid = seqUuid();
    const cloned = remapBackupImport(entities(), 'clone', nextUuid);
    const carolRecipeId = cloned.recipes[0]!.id;

    replaceFromPull({
      recipes: new Map([[carolRecipeId, cloned.recipes[0]!]]),
      collections: new Map([[cloned.collections[0]!.id, cloned.collections[0]!]]),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    });

    installSharedRows({
      recipes: new Map([
        [
          ALICE_RECIPE,
          {
            ...cloned.recipes[0]!,
            id: ALICE_RECIPE,
            title: 'Alice original',
          },
        ],
      ]),
      collections: new Map([
        [
          ALICE_COLLECTION,
          {
            id: ALICE_COLLECTION,
            name: 'Alice shared',
            recipeIds: [ALICE_RECIPE],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      ]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        [ALICE_RECIPE, { kind: 'shared', ownerSub: ALICE }],
      ]),
      collectionOrigins: new Map([
        [ALICE_COLLECTION, { kind: 'shared', ownerSub: ALICE }],
      ]),
    });

    expect(getRecipe(carolRecipeId)?.title).toBe('Soup');
    expect(getRecipe(ALICE_RECIPE)?.title).toBe('Alice original');
  });

  it('share-then-import: shared canonical rows stay when clone uses fresh ids', () => {
    const sharedRecipe: Recipe = {
      id: ALICE_RECIPE,
      title: 'Alice shared',
      servings: 1,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    installSharedRows({
      recipes: new Map([[ALICE_RECIPE, sharedRecipe]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        [ALICE_RECIPE, { kind: 'shared', ownerSub: ALICE }],
      ]),
      collectionOrigins: new Map(),
    });

    const cloned = remapBackupImport(entities(), 'clone', seqUuid());
    expect(cloned.recipes[0]?.id).not.toBe(ALICE_RECIPE);
    expect(getRecipe(ALICE_RECIPE)?.title).toBe('Alice shared');
  });
});
