import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { MAX_COLLECTION_RECIPE_IDS, MAX_NAMED_COLLECTIONS } from './compactCollection';
import {
  collectionPushErrorMessage,
  collectionStore,
  visibleMintedUrl,
} from './collectionStore';
import {
  clearLibrary,
  countOwnedNamedCollections,
  getCollection,
  getCollectionOrigin,
  listCollections,
  removeCollectionLocal,
  subscribe,
  upsertCollection,
  upsertRecipe,
} from './libraryMemory';
import { resetRereadScheduleForTests, setRereadQuietForTests } from './localWrite';
import { recipeStore } from './recipeStore';
import { installSharedRows } from './testLibrary';
import {
  addCollectionGrant,
  createCollectionLink,
  leaveSharedCollection,
  listCollectionGrants,
  listCollectionLinks,
  pushOps,
  revokeCollectionGrant,
  revokeCollectionLink,
  type CollectionLink,
} from './remote';
import { pullAfterLocalWrite } from './syncEngine';
import type { CollectionGrant } from './remote';
import type { Collection } from './types';

vi.mock('./remote', () => ({
  addCollectionGrant: vi.fn(),
  createCollectionLink: vi.fn(),
  leaveSharedCollection: vi.fn(),
  listCollectionGrants: vi.fn(),
  listCollectionLinks: vi.fn(),
  pushOps: vi.fn(),
  revokeCollectionGrant: vi.fn(),
  revokeCollectionLink: vi.fn(),
}));

vi.mock('./syncEngine', () => ({
  localWriteOverlapsPull: vi.fn(() => false),
  pullAfterLocalWrite: vi.fn(),
}));

function collection(id: string, name: string): Collection {
  return {
    id,
    name,
    recipeIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  clearLibrary();
  vi.mocked(addCollectionGrant).mockReset();
  vi.mocked(leaveSharedCollection).mockReset();
  vi.mocked(listCollectionGrants).mockReset();
  vi.mocked(pushOps).mockReset();
  vi.mocked(revokeCollectionGrant).mockReset();
  vi.mocked(pullAfterLocalWrite).mockReset();
});

describe('collectionPushErrorMessage', () => {
  it('uses the cap copy only for the dedicated cap reason on create', () => {
    expect(collectionPushErrorMessage('cap', true)).toBe(
      `You can have up to ${MAX_NAMED_COLLECTIONS} collections.`,
    );
    expect(collectionPushErrorMessage('invalid', true)).toBe(
      "Couldn't save the collection.",
    );
    expect(collectionPushErrorMessage('unknown', true)).toBe(
      "Couldn't save the collection.",
    );
    expect(collectionPushErrorMessage('cap', false)).toBe(
      "Couldn't save the collection.",
    );
  });

  it('keeps the signed-out copy', () => {
    expect(collectionPushErrorMessage('signedOut', true)).toBe(
      'Please sign in again — your session expired.',
    );
  });
});

describe('collectionStore.create cap', () => {
  it('counts only owned collections against the client cap', async () => {
    for (let i = 0; i < MAX_NAMED_COLLECTIONS - 1; i += 1) {
      upsertCollection(collection(`owned-${i}`, `Owned ${i}`));
    }
    expect(countOwnedNamedCollections()).toBe(MAX_NAMED_COLLECTIONS - 1);

    installSharedRows({
      recipes: new Map(),
      collections: new Map([
        ['shared-a', collection('shared-a', 'Shared A')],
        ['shared-b', collection('shared-b', 'Shared B')],
      ]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([
        ['shared-a', { kind: 'shared', ownerSub: 'alice' }],
        ['shared-b', { kind: 'shared', ownerSub: 'bob' }],
      ]),
    });
    expect(listCollections().length).toBeGreaterThanOrEqual(MAX_NAMED_COLLECTIONS);

    vi.mocked(pushOps).mockResolvedValue('ok');
    const created = await collectionStore.create('New owned');
    expect(created.name).toBe('New owned');
    expect(countOwnedNamedCollections()).toBe(MAX_NAMED_COLLECTIONS);
  });

  it('rejects create when owned count is already at the cap', async () => {
    for (let i = 0; i < MAX_NAMED_COLLECTIONS; i += 1) {
      upsertCollection(collection(`owned-${i}`, `Owned ${i}`));
    }
    installSharedRows({
      recipes: new Map(),
      collections: new Map([['shared-only', collection('shared-only', 'Shared')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([['shared-only', { kind: 'shared', ownerSub: 'alice' }]]),
    });

    await expect(collectionStore.create('One more')).rejects.toThrow(
      `You can have up to ${MAX_NAMED_COLLECTIONS} collections.`,
    );
    expect(pushOps).not.toHaveBeenCalled();
  });
});

describe('collectionStore owned name uniqueness', () => {
  it('create refuses an owned name in any case and allows a shared one', async () => {
    upsertCollection(collection('c1', 'Soups'));
    installSharedRows({
      recipes: new Map(),
      collections: new Map([['shared', collection('shared', 'Stews')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'alice' }]]),
    });
    vi.mocked(pushOps).mockResolvedValue('ok');

    await expect(collectionStore.create('  soups ')).rejects.toThrow(
      t('error.collectionNameTaken', { name: 'Soups' }),
    );
    expect(pushOps).not.toHaveBeenCalled();
    expect((await collectionStore.create('Stews')).name).toBe('Stews');
  });

  it('rename refuses another owned name but allows recasing its own', async () => {
    upsertCollection(collection('c1', 'Soups'));
    upsertCollection(collection('c2', 'Stews'));
    vi.mocked(pushOps).mockResolvedValue('ok');

    await expect(collectionStore.rename('c2', 'SOUPS')).rejects.toThrow(
      t('error.collectionNameTaken', { name: 'Soups' }),
    );
    expect(pushOps).not.toHaveBeenCalled();
    await collectionStore.rename('c1', 'soups');
    expect(getCollection('c1')?.name).toBe('soups');
  });
});

describe('read-only selectors', () => {
  it('report shared origin for incoming rows and owned for local rows', () => {
    upsertCollection(collection('owned', 'Mine'));
    installSharedRows({
      recipes: new Map([
        [
          'shared-recipe',
          {
            id: 'shared-recipe',
            title: 'Theirs',
            servings: 1,
            ingredientSections: [],
            steps: [],
            tags: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      ]),
      collections: new Map([['shared', collection('shared', 'Theirs')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([['shared-recipe', { kind: 'shared', ownerSub: 'alice' }]]),
      collectionOrigins: new Map([
        ['shared', { kind: 'shared', ownerSub: 'alice', ownerEmail: 'alice@example.com' }],
      ]),
    });

    expect(collectionStore.sharedBy('shared')).toBe('alice@example.com');
    expect(collectionStore.sharedBy('owned')).toBeUndefined();
    expect(collectionStore.isShared('shared')).toBe(true);
    expect(collectionStore.isShared('owned')).toBe(false);
    expect(recipeStore.isShared('shared-recipe')).toBe(true);
    expect(recipeStore.isShared('missing')).toBe(false);
  });
});

describe('collectionStore grant mutations', () => {
  it('adds a grant without listing grants internally', async () => {
    const grant: CollectionGrant = {
      sub: 'member-sub',
      email: 'member@example.com',
      createdAt: 123,
    };
    vi.mocked(addCollectionGrant).mockResolvedValue({ kind: 'ok', grant });

    await expect(collectionStore.addGrant('collection-id', grant.email)).resolves.toEqual(grant);

    expect(addCollectionGrant).toHaveBeenCalledTimes(1);
    expect(addCollectionGrant).toHaveBeenCalledWith('collection-id', grant.email, 'viewer');
    expect(listCollectionGrants).not.toHaveBeenCalled();
  });

  it('revokes a grant without listing grants internally', async () => {
    vi.mocked(revokeCollectionGrant).mockResolvedValue({ kind: 'ok' });

    await expect(
      collectionStore.revokeGrant('collection-id', 'member-sub'),
    ).resolves.toBeUndefined();

    expect(revokeCollectionGrant).toHaveBeenCalledTimes(1);
    expect(revokeCollectionGrant).toHaveBeenCalledWith('collection-id', 'member-sub');
    expect(listCollectionGrants).not.toHaveBeenCalled();
  });
});

describe('collectionStore.leave', () => {
  function installShared() {
    installSharedRows({
      recipes: new Map(),
      collections: new Map([['shared', collection('shared', 'Theirs')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'alice' }]]),
    });
  }

  it('refuses to leave an owned collection', async () => {
    upsertCollection(collection('owned', 'Mine'));

    await expect(collectionStore.leave('owned')).rejects.toThrow(
      'This collection is not shared with you.',
    );
    expect(leaveSharedCollection).not.toHaveBeenCalled();
    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });

  it('refuses to leave an unknown collection id', async () => {
    await expect(collectionStore.leave('does-not-exist')).rejects.toThrow(
      'This collection is not shared with you.',
    );
    expect(leaveSharedCollection).not.toHaveBeenCalled();
  });

  it('leaves a shared collection by its owner sub and rereads the server', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({ kind: 'ok' });
    let presentBeforePull: boolean | undefined;
    vi.mocked(pullAfterLocalWrite).mockImplementation(async () => {
      // The collection stays until the pull publishes state without it.
      presentBeforePull = getCollection('shared') !== undefined;
      removeCollectionLocal('shared');
      return 'ok';
    });

    await expect(collectionStore.leave('shared')).resolves.toBeUndefined();

    expect(leaveSharedCollection).toHaveBeenCalledTimes(1);
    expect(leaveSharedCollection).toHaveBeenCalledWith('alice', 'shared');
    expect(presentBeforePull).toBe(true);
    expect(getCollection('shared')).toBeUndefined();
    expect(pullAfterLocalWrite).toHaveBeenCalledTimes(1);
    expect(pullAfterLocalWrite).toHaveBeenCalledWith(expect.any(Number));
  });

  it('throws and keeps the collection when the follow-up pull fails', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({ kind: 'ok' });
    vi.mocked(pullAfterLocalWrite).mockResolvedValue('error');

    await expect(collectionStore.leave('shared')).rejects.toThrow(
      "Couldn't refresh after leaving.",
    );
    expect(getCollection('shared')).toBeDefined();
  });

  it('treats a signed-out follow-up pull as a sign-in error', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({ kind: 'ok' });
    vi.mocked(pullAfterLocalWrite).mockResolvedValue('signedOut');

    await expect(collectionStore.leave('shared')).rejects.toThrow(
      'Please sign in again — your session expired.',
    );
  });

  it('surfaces a signed-out leave result without pulling', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({ kind: 'signedOut' });

    await expect(collectionStore.leave('shared')).rejects.toThrow(
      'Please sign in again — your session expired.',
    );
    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });

  it('surfaces a server error without pulling', async () => {
    installShared();
    vi.mocked(leaveSharedCollection).mockResolvedValue({
      kind: 'error',
      message: "Couldn't leave the collection.",
    });

    await expect(collectionStore.leave('shared')).rejects.toThrow(
      "Couldn't leave the collection.",
    );
    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });
});

describe('collection links', () => {
  const linkA: CollectionLink = { id: 'a'.repeat(64), role: 'viewer', createdAt: 1, expiresAt: 2 };
  const linkB: CollectionLink = { id: 'b'.repeat(64), role: 'editor', createdAt: 3, expiresAt: 4 };
  const minted = { url: 'https://sous.example/c/token', id: linkA.id };

  afterEach(() => {
    vi.mocked(createCollectionLink).mockReset();
    vi.mocked(listCollectionLinks).mockReset();
  });

  it('shows the minted URL only while its link is in the live list', () => {
    expect(visibleMintedUrl(null, [linkA])).toBeNull();
    expect(visibleMintedUrl(minted, undefined)).toBeNull();
    expect(visibleMintedUrl(minted, [linkB, linkA])).toBe(minted.url);
    expect(visibleMintedUrl(minted, [linkB])).toBeNull();
    expect(visibleMintedUrl(minted, [])).toBeNull();
  });

  it('createLink returns the url and its id', async () => {
    vi.mocked(createCollectionLink).mockResolvedValue({
      kind: 'ok',
      url: minted.url,
      id: linkA.id,
      links: [linkB, linkA],
    });
    await expect(collectionStore.createLink('col-1', 'viewer')).resolves.toEqual({
      url: minted.url,
      linkId: linkA.id,
      links: [linkB, linkA],
    });
    expect(listCollectionLinks).not.toHaveBeenCalled();
  });

  it('revokeLink returns the server list after a full revoke', async () => {
    vi.mocked(revokeCollectionLink).mockResolvedValueOnce({
      kind: 'ok',
      revokedId: linkA.id,
      links: [linkB],
    });
    await expect(collectionStore.revokeLink('col-1', linkA.id, [linkA, linkB])).resolves.toEqual([
      linkB,
    ]);
    expect(listCollectionLinks).not.toHaveBeenCalled();
  });

  it('a partial revoke rereads once, and otherwise drops the revoked id locally', async () => {
    vi.mocked(revokeCollectionLink).mockResolvedValue({
      kind: 'ok',
      revokedId: linkA.id,
      links: [],
      partial: true,
    });
    vi.mocked(listCollectionLinks).mockResolvedValueOnce({ kind: 'ok', links: [linkB] });
    await expect(collectionStore.revokeLink('col-1', linkA.id, [linkA, linkB])).resolves.toEqual([
      linkB,
    ]);
    expect(listCollectionLinks).toHaveBeenCalledTimes(1);

    vi.mocked(listCollectionLinks).mockResolvedValueOnce({
      kind: 'error',
      message: 'Sharing is temporarily unavailable.',
      status: 503,
    });
    const shown = await collectionStore.revokeLink('col-1', linkA.id, [linkA, linkB]);
    expect(shown).toEqual([linkB]);
    // The shown URL for the revoked link is hidden by the same list.
    expect(visibleMintedUrl(minted, shown)).toBeNull();
    vi.mocked(revokeCollectionLink).mockReset();
  });

  it('createLink refetches a partial list and keeps the URL when that fails too', async () => {
    vi.mocked(createCollectionLink).mockResolvedValue({
      kind: 'ok',
      url: minted.url,
      id: linkA.id,
      links: [linkA],
      partial: true,
    });
    vi.mocked(listCollectionLinks).mockResolvedValueOnce({ kind: 'ok', links: [linkB, linkA] });
    await expect(collectionStore.createLink('col-1', 'viewer')).resolves.toMatchObject({
      url: minted.url,
      links: [linkB, linkA],
    });
    vi.mocked(listCollectionLinks).mockResolvedValueOnce({
      kind: 'error',
      message: 'Sharing is temporarily unavailable.',
      status: 503,
    });
    await expect(collectionStore.createLink('col-1', 'viewer')).resolves.toEqual({
      url: minted.url,
      linkId: linkA.id,
      links: [linkA],
    });
  });
});

describe('collectionStore after sign-out', () => {
  /** `remote` clears the library before it reports a 401. */
  async function signOut(): Promise<'signedOut'> {
    clearLibrary();
    return 'signedOut';
  }

  it('create does not leave the new collection behind', async () => {
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(collectionStore.create('Soups')).rejects.toThrow(t('error.sessionExpired'));

    expect(listCollections()).toEqual([]);
  });

  it('rename does not restore the old collection', async () => {
    upsertCollection(collection('c1', 'Soups'));
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(collectionStore.rename('c1', 'Stews')).rejects.toThrow(t('error.sessionExpired'));

    expect(listCollections()).toEqual([]);
  });

  it('remove does not restore the collection', async () => {
    upsertCollection(collection('c1', 'Soups'));
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(collectionStore.remove('c1')).rejects.toThrow(t('error.sessionExpired'));

    expect(listCollections()).toEqual([]);
  });

  it('remove still restores the collection when the delete fails for another reason', async () => {
    upsertCollection(collection('c1', 'Soups'));
    vi.mocked(pushOps).mockResolvedValue('error');

    await expect(collectionStore.remove('c1')).rejects.toThrow(t('error.collectionSave'));

    expect(getCollection('c1')?.name).toBe('Soups');
  });

  it('moveRecipe does not restore the collections it changed', async () => {
    upsertCollection({ ...collection('c1', 'Soups'), recipeIds: ['r1'] });
    upsertCollection(collection('c2', 'Stews'));
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(collectionStore.moveRecipe('r1', 'c2')).rejects.toThrow(t('error.sessionExpired'));

    expect(listCollections()).toEqual([]);
  });

  it('moveRecipe still restores the collections when the put fails for another reason', async () => {
    upsertCollection({ ...collection('c1', 'Soups'), recipeIds: ['r1'] });
    upsertCollection(collection('c2', 'Stews'));
    vi.mocked(pushOps).mockResolvedValue('error');

    await expect(collectionStore.moveRecipe('r1', 'c2')).rejects.toThrow(t('error.collectionSave'));

    expect(getCollection('c1')?.recipeIds).toEqual(['r1']);
    expect(getCollection('c2')?.recipeIds).toEqual([]);
  });
});

describe('collectionStore.moveRecipes', () => {
  function minimalRecipe(id: string) {
    return {
      id,
      title: id,
      servings: 1,
      ingredientSections: [{ items: [{ item: 'x' }] }],
      steps: [{ text: 'x' }],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
  }

  beforeEach(() => {
    setRereadQuietForTests(0);
  });

  afterEach(() => {
    resetRereadScheduleForTests();
  });

  it('pushes each touched owned collection once', async () => {
    upsertRecipe(minimalRecipe('r1'));
    upsertRecipe(minimalRecipe('r2'));
    upsertCollection({ ...collection('c1', 'Soups'), recipeIds: ['r1'] });
    upsertCollection({ ...collection('c2', 'Stews'), recipeIds: ['r2'] });
    upsertCollection(collection('c3', 'Pies'));
    const shared = { ...collection('shared', 'Theirs'), recipeIds: ['r1'] };
    installSharedRows({
      recipes: new Map(),
      collections: new Map([[shared.id, shared]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'alice' }]]),
    });
    vi.mocked(pushOps).mockResolvedValue('ok');

    await expect(collectionStore.moveRecipes(['r1', 'r2'], 'c3')).resolves.toEqual({ moved: 2 });

    expect(pushOps).toHaveBeenCalledTimes(1);
    const ops = vi.mocked(pushOps).mock.calls[0]?.[0];
    expect(ops?.map((op) => op.kind)).toEqual(['collection.put', 'collection.put', 'collection.put']);
    expect(ops?.map((op) => (op.kind === 'collection.put' ? op.payload.id : '')).sort()).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
    expect(getCollection('c1')?.recipeIds).toEqual([]);
    expect(getCollection('c2')?.recipeIds).toEqual([]);
    expect(getCollection('c3')?.recipeIds).toEqual(['r1', 'r2']);
    expect(getCollection('shared')?.recipeIds).toEqual(['r1']);
  });

  it('does nothing when given no ids', async () => {
    upsertCollection(collection('c1', 'Soups'));

    await expect(collectionStore.moveRecipes([], 'c1')).resolves.toEqual({ moved: 0 });

    expect(pushOps).not.toHaveBeenCalled();
  });

  it('moves owned recipes and skips a shared one', async () => {
    upsertRecipe(minimalRecipe('r1'));
    upsertCollection({ ...collection('c1', 'Soups'), recipeIds: ['r1'] });
    upsertCollection(collection('c2', 'Stews'));
    installSharedRows({
      recipes: new Map([['shared-recipe', minimalRecipe('shared-recipe')]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([['shared-recipe', { kind: 'shared', ownerSub: 'alice' }]]),
      collectionOrigins: new Map(),
    });
    vi.mocked(pushOps).mockResolvedValue('ok');

    await expect(collectionStore.moveRecipes(['r1', 'shared-recipe'], 'c2')).resolves.toEqual({
      moved: 1,
    });

    expect(getCollection('c1')?.recipeIds).toEqual([]);
    expect(getCollection('c2')?.recipeIds).toEqual(['r1']);
  });

  it('still restores collections when the put fails and schedules a reread', async () => {
    upsertRecipe(minimalRecipe('r1'));
    upsertRecipe(minimalRecipe('r2'));
    upsertCollection({ ...collection('c1', 'Soups'), recipeIds: ['r1'] });
    upsertCollection(collection('c2', 'Stews'));
    vi.mocked(pushOps).mockResolvedValue('error');
    vi.mocked(pullAfterLocalWrite).mockResolvedValue('ok');

    await expect(collectionStore.moveRecipes(['r1', 'r2'], 'c2')).rejects.toThrow(
      t('error.collectionSave'),
    );

    expect(getCollection('c1')?.recipeIds).toEqual(['r1']);
    expect(getCollection('c2')?.recipeIds).toEqual([]);
    await vi.waitFor(() => {
      expect(pullAfterLocalWrite).toHaveBeenCalled();
    });
  });

  it('does not reread after sign-out', async () => {
    async function signOut(): Promise<'signedOut'> {
      clearLibrary();
      return 'signedOut';
    }
    upsertRecipe(minimalRecipe('r1'));
    upsertCollection({ ...collection('c1', 'Soups'), recipeIds: ['r1'] });
    upsertCollection(collection('c2', 'Stews'));
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(collectionStore.moveRecipes(['r1'], 'c2')).rejects.toThrow(t('error.sessionExpired'));

    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });

  it('drops shared recipe ids and throws when every id was dropped', async () => {
    installSharedRows({
      recipes: new Map([['shared-recipe', minimalRecipe('shared-recipe')]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([['shared-recipe', { kind: 'shared', ownerSub: 'alice' }]]),
      collectionOrigins: new Map(),
    });
    upsertCollection(collection('c1', 'Soups'));

    await expect(collectionStore.moveRecipes(['shared-recipe'], 'c1')).rejects.toThrow(
      t('assistant.moveRecipesGone'),
    );
    expect(pushOps).not.toHaveBeenCalled();
  });

  it('refuses a shared destination', async () => {
    upsertRecipe(minimalRecipe('r1'));
    installSharedRows({
      recipes: new Map(),
      collections: new Map([['shared', collection('shared', 'Theirs')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'alice' }]]),
    });

    await expect(collectionStore.moveRecipes(['r1'], 'shared')).rejects.toThrow(
      t('error.sharedViewOnly'),
    );
    expect(pushOps).not.toHaveBeenCalled();
  });

  it('refuses when the destination would exceed the recipe cap', async () => {
    upsertCollection(collection('dest', 'Dest'));
    const ids = Array.from({ length: MAX_COLLECTION_RECIPE_IDS + 1 }, (_, i) => `r-${i}`);
    for (const id of ids) {
      upsertRecipe(minimalRecipe(id));
    }

    await expect(collectionStore.moveRecipes(ids, 'dest')).rejects.toThrow(t('error.collectionFull'));
    expect(pushOps).not.toHaveBeenCalled();
  });

  it('does not count an id the destination already holds toward the cap', async () => {
    const present = 'recipe-0';
    const full = Array.from({ length: MAX_COLLECTION_RECIPE_IDS }, (_, i) => `recipe-${i}`);
    upsertRecipe(minimalRecipe('extra'));
    upsertRecipe(minimalRecipe(present));
    upsertCollection({ ...collection('c1', 'Soups'), recipeIds: ['extra'] });
    upsertCollection({ ...collection('c2', 'Stews'), recipeIds: full });

    await expect(collectionStore.moveRecipes(['extra', present], 'c2')).rejects.toThrow(
      t('error.collectionFull'),
    );
    expect(pushOps).not.toHaveBeenCalled();
    expect(getCollection('c1')?.recipeIds).toEqual(['extra']);
    expect(getCollection('c2')?.recipeIds).toEqual(full);

    await expect(collectionStore.moveRecipes([present], 'c2')).resolves.toEqual({ moved: 0 });
    expect(pushOps).not.toHaveBeenCalled();
  });
});

describe('collectionStore.createWithRecipes', () => {
  function minimalRecipe(id: string) {
    return {
      id,
      title: id,
      servings: 1,
      ingredientSections: [{ items: [{ item: 'x' }] }],
      steps: [{ text: 'x' }],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
  }

  beforeEach(() => {
    setRereadQuietForTests(0);
  });

  afterEach(() => {
    resetRereadScheduleForTests();
  });

  it('creates an empty collection in one push', async () => {
    vi.mocked(pushOps).mockResolvedValue('ok');

    const created = await collectionStore.createWithRecipes('  Soups  ', []);

    expect(created.moved).toBe(0);
    expect(pushOps).toHaveBeenCalledTimes(1);
    const ops = vi.mocked(pushOps).mock.calls[0]?.[0];
    expect(ops).toEqual([
      {
        kind: 'collection.put',
        payload: expect.objectContaining({
          id: created.id,
          name: 'Soups',
          recipeIds: [],
        }),
      },
    ]);
    expect(getCollection(created.id)?.name).toBe('Soups');
    expect(getCollectionOrigin(created.id)).toEqual({ kind: 'own' });
  });

  it('files recipes and strips their old collections in one publish and one push', async () => {
    upsertRecipe(minimalRecipe('r1'));
    upsertRecipe(minimalRecipe('r2'));
    upsertCollection({ ...collection('c1', 'Weeknight'), recipeIds: ['r1'] });
    const shared = { ...collection('shared', 'Theirs'), recipeIds: ['r1'] };
    installSharedRows({
      recipes: new Map(),
      collections: new Map([[shared.id, shared]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'alice' }]]),
    });
    vi.mocked(pushOps).mockResolvedValue('ok');

    let publishes = 0;
    const unsubscribe = subscribe(() => {
      publishes += 1;
    });
    const created = await collectionStore.createWithRecipes('Soups', ['r1', 'r2']);
    unsubscribe();

    expect(publishes).toBe(1);
    expect(created.moved).toBe(2);
    expect(pushOps).toHaveBeenCalledTimes(1);
    const ops = vi.mocked(pushOps).mock.calls[0]?.[0] ?? [];
    expect(ops.map((op) => op.kind)).toEqual(['collection.put', 'collection.put']);
    // The server applies ops one by one; the create must land before any strip.
    expect(ops.map((op) => (op.payload as { id: string }).id)).toEqual([created.id, 'c1']);
    expect(getCollection('c1')?.recipeIds).toEqual([]);
    expect(getCollection(created.id)?.recipeIds).toEqual(['r1', 'r2']);
    expect(getCollection('shared')?.recipeIds).toEqual(['r1']);
  });

  it('rolls the new collection back when the push fails', async () => {
    upsertRecipe(minimalRecipe('r1'));
    upsertCollection({ ...collection('c1', 'Weeknight'), recipeIds: ['r1'] });
    vi.mocked(pushOps).mockResolvedValue('error');
    vi.mocked(pullAfterLocalWrite).mockResolvedValue('ok');

    await expect(collectionStore.createWithRecipes('Soups', ['r1'])).rejects.toThrow(
      t('error.collectionSave'),
    );

    expect(getCollection('c1')?.recipeIds).toEqual(['r1']);
    expect(listCollections().some((c) => c.name === 'Soups')).toBe(false);
    await vi.waitFor(() => {
      expect(pullAfterLocalWrite).toHaveBeenCalled();
    });
  });

  it('does not reread after sign-out', async () => {
    async function signOut(): Promise<'signedOut'> {
      clearLibrary();
      return 'signedOut';
    }
    upsertRecipe(minimalRecipe('r1'));
    vi.mocked(pushOps).mockImplementation(signOut);

    await expect(collectionStore.createWithRecipes('Soups', ['r1'])).rejects.toThrow(
      t('error.sessionExpired'),
    );

    expect(pullAfterLocalWrite).not.toHaveBeenCalled();
  });

  it('refuses a name that already exists', async () => {
    upsertCollection(collection('c1', 'Soups'));

    await expect(collectionStore.createWithRecipes('soups', [])).rejects.toThrow(
      t('error.collectionNameTaken', { name: 'Soups' }),
    );
    expect(pushOps).not.toHaveBeenCalled();
    expect(listCollections()).toHaveLength(1);
  });

  it('refuses when any recipe is missing and writes nothing', async () => {
    upsertRecipe(minimalRecipe('r1'));
    upsertCollection({ ...collection('c1', 'Weeknight'), recipeIds: ['r1'] });

    await expect(collectionStore.createWithRecipes('Soups', ['r1', 'gone'])).rejects.toThrow(
      t('assistant.moveRecipesGone'),
    );
    expect(pushOps).not.toHaveBeenCalled();
    expect(getCollection('c1')?.recipeIds).toEqual(['r1']);
    expect(listCollections().some((c) => c.name === 'Soups')).toBe(false);
  });

  it('refuses when owned collections are already at the cap', async () => {
    for (let i = 0; i < MAX_NAMED_COLLECTIONS; i += 1) {
      upsertCollection(collection(`owned-${i}`, `Owned ${i}`));
    }

    await expect(collectionStore.createWithRecipes('Soups', [])).rejects.toThrow(
      t('error.collectionCap', { max: MAX_NAMED_COLLECTIONS }),
    );
    expect(pushOps).not.toHaveBeenCalled();
  });
});
