import { afterEach, describe, expect, it } from 'vitest';
import {
  addPendingBlob,
  cachePhotoBlob,
  captureSnapshot,
  chatParentIsShared,
  clearChatLocal,
  clearLibrary,
  cookParentIsShared,
  countOwnedNamedCollections,
  dropPendingBlob,
  dropPhoto,
  getRecipe,
  getSnapshot,
  isSharedRecipe,
  listCookLogs,
  markLoaded,
  markPhotoRemote,
  originAccess,
  ownedBackupGraphIds,
  removeCollectionLocal,
  removeCookLogLocal,
  removeRecipeLocal,
  replaceFromPull,
  replaceFromPullWithShared,
  restoreSnapshot,
  subscribe,
  upsertChat,
  upsertCollection,
  upsertCook,
  upsertCookLog,
  upsertRecipe,
} from './libraryMemory';
import { installSharedRows } from './testLibrary';
import type { ChatMessage, Collection, CookStateRow, Recipe } from './types';

function recipe(id: string, title: string): Recipe {
  return {
    id,
    title,
    servings: 1,
    ingredientSections: [],
    steps: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  clearLibrary();
});

describe('fullPull', () => {
  const owned = {
    recipes: new Map<string, Recipe>(),
    collections: new Map<string, Collection>(),
    chat: new Map(),
    cook: new Map(),
    cookLogs: new Map(),
    remotePhotoIds: new Set<string>(),
  };

  it('marks a pull that included shared rows, and clears that on an owned-only publish or sign-out', () => {
    expect(getSnapshot().fullPull).toBe(false);
    replaceFromPullWithShared(owned, {
      recipes: new Map(),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map(),
    });
    expect(getSnapshot().fullPull).toBe(true);
    const captured = captureSnapshot();
    replaceFromPull(owned);
    expect(getSnapshot().fullPull).toBe(false);
    restoreSnapshot(captured);
    expect(getSnapshot().fullPull).toBe(true);
    clearLibrary();
    expect(getSnapshot().fullPull).toBe(false);
    expect(getSnapshot().loaded).toBe(true);
  });
});

describe('shared rows', () => {
  it('adds a shared recipe and refuses to overwrite an owned id', () => {
    const own = recipe('own-1', 'Mine');
    replaceFromPull({
      recipes: new Map([[own.id, own]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    });
    const collision = recipe('own-1', 'Theirs');
    const shared = recipe('shared-1', 'Shared soup');
    installSharedRows({
      recipes: new Map([
        [collision.id, collision],
        [shared.id, shared],
      ]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([
        [collision.id, { kind: 'shared', ownerSub: 'owner' }],
        [shared.id, { kind: 'shared', ownerSub: 'owner' }],
      ]),
      collectionOrigins: new Map(),
    });
    expect(getRecipe('own-1')?.title).toBe('Mine');
    expect(isSharedRecipe('own-1')).toBe(false);
    expect(getRecipe('shared-1')?.title).toBe('Shared soup');
    expect(isSharedRecipe('shared-1')).toBe(true);
  });

  it('marks a locally created recipe as owned', () => {
    upsertRecipe(recipe('new-1', 'Fresh'));
    expect(isSharedRecipe('new-1')).toBe(false);
  });
});

describe('replaceFromPullWithShared', () => {
  it('keeps owned cook logs when shared rows are merged in', () => {
    const log = {
      id: 'log-1',
      recipeId: 'owned-recipe',
      cookedOn: '2026-09-20',
      createdAt: 1,
      updatedAt: 2,
    };
    replaceFromPullWithShared(
      {
        recipes: new Map([['owned-recipe', recipe('owned-recipe', 'Mine')]]),
        collections: new Map(),
        chat: new Map(),
        cook: new Map(),
        cookLogs: new Map([[log.id, log]]),
        remotePhotoIds: new Set(),
      },
      {
        recipes: new Map([['shared-recipe', recipe('shared-recipe', 'Shared')]]),
        collections: new Map(),
        remotePhotoIds: new Set(),
        recipeOrigins: new Map([['shared-recipe', { kind: 'shared', ownerSub: 'owner' }]]),
        collectionOrigins: new Map(),
      },
    );
    expect(listCookLogs()).toEqual([log]);

    installSharedRows({
      recipes: new Map([['another-shared', recipe('another-shared', 'Also shared')]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([['another-shared', { kind: 'shared', ownerSub: 'owner' }]]),
      collectionOrigins: new Map(),
    });
    expect(listCookLogs()).toEqual([log]);
  });

  it('publishes one complete owned-precedence snapshot and preserves local caches', () => {
    addPendingBlob('pending-photo', new Blob(['pending']));
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });

    replaceFromPullWithShared(
      {
        recipes: new Map([['collision', recipe('collision', 'Mine')]]),
        collections: new Map([
          ['owned-collection', collection('owned-collection', 'Mine')],
        ]),
        chat: new Map(),
        cook: new Map(),
        cookLogs: new Map(),
        remotePhotoIds: new Set(['owned-photo']),
      },
      {
        recipes: new Map([
          ['collision', recipe('collision', 'Theirs')],
          ['shared-recipe', recipe('shared-recipe', 'Shared')],
        ]),
        collections: new Map([
          ['shared-collection', collection('shared-collection', 'Shared')],
        ]),
        remotePhotoIds: new Set(['shared-photo']),
        recipeOrigins: new Map([
          ['collision', { kind: 'shared', ownerSub: 'owner' }],
          ['shared-recipe', { kind: 'shared', ownerSub: 'owner' }],
        ]),
        collectionOrigins: new Map([
          ['shared-collection', { kind: 'shared', ownerSub: 'owner' }],
        ]),
      },
    );
    unsubscribe();

    const snapshot = getSnapshot();
    expect(calls).toBe(1);
    expect(snapshot.loaded).toBe(true);
    expect(snapshot.recipes.get('collision')?.title).toBe('Mine');
    expect(snapshot.recipeOrigins.get('collision')).toEqual({ kind: 'own' });
    expect(snapshot.recipeOrigins.get('shared-recipe')).toEqual({
      kind: 'shared',
      ownerSub: 'owner',
    });
    expect(snapshot.collectionOrigins.get('owned-collection')).toEqual({
      kind: 'own',
    });
    expect(snapshot.collectionOrigins.get('shared-collection')).toEqual({
      kind: 'shared',
      ownerSub: 'owner',
    });
    expect([...snapshot.remotePhotoIds]).toEqual(['owned-photo', 'shared-photo']);
    expect(snapshot.pendingBlobs.has('pending-photo')).toBe(true);
  });
});

function collection(id: string, name: string): Collection {
  return {
    id,
    name,
    recipeIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('countOwnedNamedCollections', () => {
  it('counts only owned and missing-origin collections', () => {
    replaceFromPull({
      recipes: new Map(),
      collections: new Map([
        ['owned-a', collection('owned-a', 'A')],
        ['owned-b', collection('owned-b', 'B')],
      ]),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    });
    expect(countOwnedNamedCollections()).toBe(2);

    installSharedRows({
      recipes: new Map(),
      collections: new Map([['shared-1', collection('shared-1', 'Shared')]]),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map(),
      collectionOrigins: new Map([
        ['shared-1', { kind: 'shared', ownerSub: 'alice' }],
      ]),
    });
    expect(countOwnedNamedCollections()).toBe(2);

    upsertCollection(collection('owned-c', 'C'));
    expect(countOwnedNamedCollections()).toBe(3);
  });
});

function message(id: string, recipeId: string): ChatMessage {
  return {
    id,
    recipeId,
    role: 'user',
    content: 'hi',
    createdAt: 3,
    photoIds: ['photo-1'],
  };
}

function cookRow(recipeId: string): CookStateRow {
  return {
    recipeId,
    servings: 2,
    currentStep: 0,
    checkedKeys: [],
    recipeUpdatedAt: 1,
  };
}

describe('chat and cook parent sidecars', () => {
  it('publishes owned sidecars and keeps them beside a shared recipe', () => {
    replaceFromPullWithShared(
      {
        recipes: new Map([['mine', recipe('mine', 'Mine')]]),
        collections: new Map(),
        chat: new Map([['m', message('m', 'revoked')]]),
        cook: new Map([['revoked', cookRow('revoked')]]),
        cookLogs: new Map(),
        remotePhotoIds: new Set(),
        chatParentOrigins: new Map([['m', 'owner-sub']]),
        cookParentOrigins: new Map([['revoked', 'owner-sub']]),
      },
      {
        recipes: new Map([['shared', recipe('shared', 'Shared')]]),
        collections: new Map(),
        remotePhotoIds: new Set(),
        recipeOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'owner-sub' }]]),
        collectionOrigins: new Map(),
      },
    );
    const snapshot = getSnapshot();
    expect(snapshot.chatParentOrigins.get('m')).toBe('owner-sub');
    expect(snapshot.cookParentOrigins.get('revoked')).toBe('owner-sub');
    expect(snapshot.recipeOrigins.get('mine')).toEqual({ kind: 'own' });
    expect(snapshot.recipeOrigins.get('shared')).toEqual({
      kind: 'shared',
      ownerSub: 'owner-sub',
    });
    expect(snapshot.recipeOrigins.has('revoked')).toBe(false);
    expect(chatParentIsShared('m', 'revoked')).toBe(true);
    expect(cookParentIsShared('revoked')).toBe(true);
  });

  it('infers a sidecar from a live shared origin and clears it for an owned origin', () => {
    installSharedRows({
      recipes: new Map([['shared', recipe('shared', 'Shared')]]),
      collections: new Map(),
      remotePhotoIds: new Set(),
      recipeOrigins: new Map([['shared', { kind: 'shared', ownerSub: 'alice' }]]),
      collectionOrigins: new Map(),
    });
    upsertChat(message('shared-message', 'shared'));
    upsertCook(cookRow('shared'));
    expect(getSnapshot().chatParentOrigins.get('shared-message')).toBe('alice');
    expect(getSnapshot().cookParentOrigins.get('shared')).toBe('alice');

    const ownedMessage = message('owned-message', 'owned');
    replaceFromPull({
      recipes: new Map([['owned', recipe('owned', 'Mine')]]),
      collections: new Map(),
      chat: new Map([[ownedMessage.id, ownedMessage]]),
      cook: new Map([['owned', cookRow('owned')]]),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
      chatParentOrigins: new Map([[ownedMessage.id, 'stale-owner']]),
      cookParentOrigins: new Map([['owned', 'stale-owner']]),
    });
    upsertChat(ownedMessage);
    upsertCook(cookRow('owned'));
    expect(getSnapshot().chatParentOrigins.has(ownedMessage.id)).toBe(false);
    expect(getSnapshot().cookParentOrigins.has('owned')).toBe(false);
  });

  it('keeps a persisted sidecar when a rewrite happens after the recipe origin is gone', () => {
    const revokedMessage = message('revoked-message', 'revoked');
    replaceFromPull({
      recipes: new Map(),
      collections: new Map(),
      chat: new Map([[revokedMessage.id, revokedMessage]]),
      cook: new Map([['revoked', cookRow('revoked')]]),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
      chatParentOrigins: new Map([[revokedMessage.id, 'alice']]),
      cookParentOrigins: new Map([['revoked', 'alice']]),
    });
    upsertChat({ ...revokedMessage, content: 'edited' });
    upsertCook({ ...cookRow('revoked'), servings: 4 });
    expect(getSnapshot().chatParentOrigins.get(revokedMessage.id)).toBe('alice');
    expect(getSnapshot().cookParentOrigins.get('revoked')).toBe('alice');
    expect(getSnapshot().recipeOrigins.has('revoked')).toBe(false);
  });

  it('removes sidecar state on clear, recipe removal, and sign-out', () => {
    const revokedMessage = message('revoked-message', 'revoked');
    replaceFromPull({
      recipes: new Map([['revoked', recipe('revoked', 'Gone')]]),
      collections: new Map(),
      chat: new Map([
        [revokedMessage.id, revokedMessage],
        ['other', message('other', 'other-recipe')],
      ]),
      cook: new Map([['revoked', cookRow('revoked')]]),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
      chatParentOrigins: new Map([
        [revokedMessage.id, 'alice'],
        ['other', 'alice'],
      ]),
      cookParentOrigins: new Map([['revoked', 'alice']]),
    });

    const captured = captureSnapshot();
    clearChatLocal('revoked');
    expect(getSnapshot().chat.has(revokedMessage.id)).toBe(false);
    expect(getSnapshot().chatParentOrigins.has(revokedMessage.id)).toBe(false);
    expect(getSnapshot().chatParentOrigins.get('other')).toBe('alice');
    expect(getSnapshot().cookParentOrigins.get('revoked')).toBe('alice');

    restoreSnapshot(captured);
    expect(getSnapshot().chatParentOrigins.get(revokedMessage.id)).toBe('alice');
    expect(getSnapshot().cookParentOrigins.get('revoked')).toBe('alice');

    removeRecipeLocal('revoked');
    expect(getSnapshot().chatParentOrigins.has(revokedMessage.id)).toBe(false);
    expect(getSnapshot().cookParentOrigins.has('revoked')).toBe(false);
    expect(getSnapshot().chatParentOrigins.get('other')).toBe('alice');

    clearLibrary();
    expect(getSnapshot().chatParentOrigins.size).toBe(0);
    expect(getSnapshot().cookParentOrigins.size).toBe(0);
    expect(getSnapshot().loaded).toBe(true);
  });

  it('excludes revoked shared-parent rows from owned overlap and keeps legacy orphans', () => {
    replaceFromPull({
      recipes: new Map([['owned', recipe('owned', 'Mine')]]),
      collections: new Map(),
      chat: new Map([
        ['revoked-chat', { ...message('revoked-chat', 'revoked'), photoIds: ['revoked-photo'] }],
        ['orphan-chat', { ...message('orphan-chat', 'missing'), photoIds: ['orphan-photo'] }],
        ['owned-chat', message('owned-chat', 'owned')],
      ]),
      cookLogs: new Map(),
      cook: new Map([
        ['revoked', cookRow('revoked')],
        ['missing', cookRow('missing')],
        ['owned', cookRow('owned')],
      ]),
      remotePhotoIds: new Set(['revoked-photo']),
      chatParentOrigins: new Map([['revoked-chat', 'former-owner']]),
      cookParentOrigins: new Map([['revoked', 'former-owner']]),
    });

    const ids = ownedBackupGraphIds();
    expect(ids.chatMessageIds.has('revoked-chat')).toBe(false);
    expect(ids.recipeIds.has('revoked')).toBe(false);
    expect(ids.photoIds.has('revoked-photo')).toBe(false);
    expect(ids.chatMessageIds.has('orphan-chat')).toBe(true);
    expect(ids.recipeIds.has('missing')).toBe(true);
    expect(ids.photoIds.has('orphan-photo')).toBe(true);
    expect(ids.chatMessageIds.has('owned-chat')).toBe(true);
    expect(ids.recipeIds.has('owned')).toBe(true);
    expect(ids.photoIds.has('photo-1')).toBe(true);
    expect(chatParentIsShared('orphan-chat', 'missing')).toBe(false);
    expect(cookParentIsShared('missing')).toBe(false);
    expect(chatParentIsShared('owned-chat', 'owned')).toBe(false);
  });
});

describe('copy-on-write writes', () => {
  function seed(): void {
    replaceFromPull({
      recipes: new Map([['r1', recipe('r1', 'One')]]),
      collections: new Map([['c1', collection('c1', 'C')]]),
      chat: new Map([['m1', message('m1', 'r1')]]),
      cook: new Map([['r1', cookRow('r1')]]),
      cookLogs: new Map([
        ['log-1', { id: 'log-1', recipeId: 'r1', cookedOn: '2026-09-20', createdAt: 1, updatedAt: 2 }],
      ]),
      remotePhotoIds: new Set(['photo-1']),
    });
  }

  function contents(snap: ReturnType<typeof getSnapshot>): unknown {
    return Object.fromEntries(
      Object.entries(snap).map(([key, value]) => [
        key,
        value instanceof Map || value instanceof Set ? [...value.entries()] : value,
      ]),
    );
  }

  it('caching a photo keeps every unrelated map', () => {
    seed();
    const before = getSnapshot();
    cachePhotoBlob('photo-2', new Blob(['x']));
    const after = getSnapshot();
    expect(after).not.toBe(before);
    expect(after.pendingBlobs).not.toBe(before.pendingBlobs);
    expect(after.remotePhotoIds).not.toBe(before.remotePhotoIds);
    for (const key of [
      'recipes',
      'collections',
      'chat',
      'cook',
      'cookLogs',
      'recipeOrigins',
      'collectionOrigins',
      'chatParentOrigins',
      'cookParentOrigins',
    ] as const) {
      expect(after[key]).toBe(before[key]);
    }
  });

  it('does not publish when a cached photo is already in place', () => {
    seed();
    const blob = new Blob(['x']);
    cachePhotoBlob('photo-2', blob);
    const before = getSnapshot();
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });
    cachePhotoBlob('photo-2', blob);
    markPhotoRemote('photo-1');
    unsubscribe();
    expect(calls).toBe(0);
    expect(getSnapshot()).toBe(before);
  });

  it('a cook log write keeps recipes and collections', () => {
    seed();
    const before = getSnapshot();
    upsertCookLog({ id: 'log-2', recipeId: 'r1', cookedOn: '2026-09-21', createdAt: 3, updatedAt: 3 });
    const after = getSnapshot();
    expect(after.cookLogs).not.toBe(before.cookLogs);
    expect(after.recipes).toBe(before.recipes);
    expect(after.collections).toBe(before.collections);
    expect(after.recipeOrigins).toBe(before.recipeOrigins);
  });

  it('never changes a snapshot that was already published', () => {
    const writes: Array<() => void> = [
      () => upsertRecipe(recipe('r2', 'Two')),
      () => upsertRecipe(recipe('r1', 'Shared now'), { kind: 'shared', ownerSub: 'alice' }),
      () => removeRecipeLocal('r1'),
      () => upsertChat(message('m2', 'r1')),
      () => clearChatLocal('r1'),
      () => upsertCook(cookRow('r1')),
      () => upsertCookLog({ id: 'log-3', recipeId: 'r1', cookedOn: '2026-09-22', createdAt: 4, updatedAt: 4 }),
      () => removeCookLogLocal('log-1'),
      () => addPendingBlob('photo-3', new Blob(['y'])),
      () => dropPendingBlob('photo-3'),
      () => markPhotoRemote('photo-4'),
      () => cachePhotoBlob('photo-5', new Blob(['z'])),
      () => dropPhoto('photo-1'),
      () => upsertCollection(collection('c2', 'D')),
      () => removeCollectionLocal('c1'),
      () => clearLibrary(),
      () =>
        replaceFromPull({
          recipes: new Map([['r9', recipe('r9', 'Pulled')]]),
          collections: new Map(),
          chat: new Map(),
          cook: new Map(),
          cookLogs: new Map(),
          remotePhotoIds: new Set(),
        }),
      () =>
        replaceFromPullWithShared(
          {
            recipes: new Map([['r9', recipe('r9', 'Pulled')]]),
            collections: new Map(),
            chat: new Map(),
            cook: new Map(),
            cookLogs: new Map(),
            remotePhotoIds: new Set(),
          },
          {
            recipes: new Map([['s1', recipe('s1', 'Shared')]]),
            collections: new Map(),
            remotePhotoIds: new Set(),
            recipeOrigins: new Map([['s1', { kind: 'shared', ownerSub: 'alice' }]]),
            collectionOrigins: new Map(),
          },
        ),
    ];
    for (const write of writes) {
      seed();
      addPendingBlob('photo-3', new Blob(['y']));
      const before = getSnapshot();
      const expected = contents(before);
      write();
      expect(getSnapshot()).not.toBe(before);
      expect(contents(before)).toEqual(expected);
    }
  });

  it('restoring a captured snapshot leaves both the current and the captured one untouched', () => {
    seed();
    const captured = captureSnapshot();
    const capturedContents = contents(captured);
    upsertRecipe(recipe('r2', 'Two'));
    const before = getSnapshot();
    const beforeContents = contents(before);
    restoreSnapshot(captured);
    expect(getSnapshot()).not.toBe(before);
    expect(contents(before)).toEqual(beforeContents);
    expect(contents(captured)).toEqual(capturedContents);
    expect(contents(getSnapshot())).toEqual(capturedContents);
  });

  it('marking an unloaded library loaded leaves the unloaded snapshot untouched', () => {
    seed();
    restoreSnapshot({ ...getSnapshot(), loaded: false });
    const before = getSnapshot();
    markLoaded();
    expect(getSnapshot()).not.toBe(before);
    expect(before.loaded).toBe(false);
    expect(getSnapshot().loaded).toBe(true);
  });

  it('a write that changes nothing keeps the snapshot and notifies no one', () => {
    const blob = new Blob(['y']);
    const noOps: Array<[string, () => void]> = [
      ['clearChatLocal with no messages', () => clearChatLocal('absent')],
      ['dropPhoto of an unknown photo', () => dropPhoto('absent')],
      ['removeCookLogLocal of an unknown log', () => removeCookLogLocal('absent')],
      ['removeCollectionLocal of an unknown collection', () => removeCollectionLocal('absent')],
      ['removeRecipeLocal of an unknown recipe', () => removeRecipeLocal('absent')],
      ['addPendingBlob of the same blob', () => addPendingBlob('photo-3', blob)],
      ['dropPendingBlob of an unknown blob', () => dropPendingBlob('absent')],
      ['markPhotoRemote of a remote photo', () => markPhotoRemote('photo-1')],
      ['cachePhotoBlob of the cached blob', () => cachePhotoBlob('photo-3', blob)],
      ['upsertRecipe of the same recipe', () => upsertRecipe(getSnapshot().recipes.get('r1')!)],
      ['upsertChat of the same message', () => upsertChat(getSnapshot().chat.get('m1')!)],
      ['upsertCook of the same row', () => upsertCook(getSnapshot().cook.get('r1')!)],
      ['upsertCookLog of the same log', () => upsertCookLog(getSnapshot().cookLogs.get('log-1')!)],
      [
        'upsertCollection of the same collection',
        () => upsertCollection(getSnapshot().collections.get('c1')!),
      ],
      ['markLoaded when loaded', () => markLoaded()],
    ];
    for (const [name, write] of noOps) {
      seed();
      cachePhotoBlob('photo-3', blob);
      const before = getSnapshot();
      let calls = 0;
      const unsubscribe = subscribe(() => {
        calls += 1;
      });
      write();
      unsubscribe();
      expect({ name, same: getSnapshot() === before, calls }).toEqual({ name, same: true, calls: 0 });
    }
  });

  it('clearing an already empty library notifies no one', () => {
    clearLibrary();
    const before = getSnapshot();
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });
    clearLibrary();
    unsubscribe();
    expect(getSnapshot()).toBe(before);
    expect(calls).toBe(0);
  });

  it('chat and cook writes on an owned recipe keep the parent-origin sidecars', () => {
    seed();
    const before = getSnapshot();
    upsertChat(message('m2', 'r1'));
    upsertCook({ ...cookRow('r1'), currentStep: 1 });
    const after = getSnapshot();
    expect(after.chat).not.toBe(before.chat);
    expect(after.cook).not.toBe(before.cook);
    expect(after.chatParentOrigins).toBe(before.chatParentOrigins);
    expect(after.cookParentOrigins).toBe(before.cookParentOrigins);
  });

  it('an origin-only recipe change replaces recipeOrigins', () => {
    seed();
    const before = getSnapshot();
    upsertRecipe(before.recipes.get('r1')!, { kind: 'shared', ownerSub: 'alice', access: 'editor' });
    const after = getSnapshot();
    expect(after.recipeOrigins).not.toBe(before.recipeOrigins);
    expect(originAccess(after.recipeOrigins.get('r1'))).toBe('editor');
  });

  it('removing a recipe drops its cook, chat, cook logs, sidecars and photos together', () => {
    seed();
    upsertRecipe(recipe('r1', 'One'), { kind: 'shared', ownerSub: 'alice' });
    upsertCook(cookRow('r1'));
    upsertChat(message('m1', 'r1'));
    removeRecipeLocal('r1');
    const snap = getSnapshot();
    expect(snap.recipes.has('r1')).toBe(false);
    expect(snap.recipeOrigins.has('r1')).toBe(false);
    expect(snap.cook.has('r1')).toBe(false);
    expect(snap.cookParentOrigins.has('r1')).toBe(false);
    expect(snap.chat.has('m1')).toBe(false);
    expect(snap.chatParentOrigins.has('m1')).toBe(false);
    expect(snap.cookLogs.size).toBe(0);
    expect(snap.remotePhotoIds.has('photo-1')).toBe(false);
    expect(snap.collections.has('c1')).toBe(true);
  });
});
