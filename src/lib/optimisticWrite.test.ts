import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importLibrary } from './backup';
import { chatStore } from './chatStore';
import { collectionStore } from './collectionStore';
import { cookLogStore } from './cookLogStore';
import {
  clearLibrary,
  getCollection,
  getCook,
  getCookLog,
  getRecipe,
  getSnapshot,
  listChat,
  listCollections,
  localWritesOpen,
  markUnloadedForTests,
  replaceFromPull,
} from './libraryMemory';
import { photoStore } from './photoStore';
import {
  postPhoto,
  pullPage,
  pullSharedPage,
  pushOps,
  type PullChanges,
  type PullPage,
  type SharedPullPage,
} from './remote';
import { CreateRollbackError, recipeStore } from './recipeStore';
import { onSyncFinished, pullAll, resetDiscardedPullForTests, sync } from './syncEngine';
import { resetRereadScheduleForTests, setRereadQuietForTests } from './localWrite';
import { invalidateSession } from './session';
import type { Collection, CookStateRow, Recipe } from './types';
import { updateCookState } from './useCookState';

vi.mock('./remote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remote')>();
  return {
    ...actual,
    pushOps: vi.fn(async () => 'ok' as const),
    postPhoto: vi.fn(async () => 'ok' as const),
    pullPage: vi.fn(),
    pullSharedPage: vi.fn(),
  };
});

const RECIPE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_RECIPE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CHAT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PHOTO_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const COLLECTION_A = '11111111-1111-4111-8111-111111111111';
const COLLECTION_B = '22222222-2222-4222-8222-222222222222';
const CREATED_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function recipe(title = 'Soup'): Recipe {
  return {
    id: RECIPE_ID,
    title,
    servings: 2,
    ingredientSections: [{ items: [{ item: 'onion' }] }],
    steps: [{ text: 'Chop.' }, { text: 'Cook.' }],
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

function cook(currentStep: number): CookStateRow {
  return {
    recipeId: RECIPE_ID,
    servings: 2,
    currentStep,
    checkedKeys: [],
    recipeUpdatedAt: 2,
  };
}

function pullDoc<T extends object>(value: T): Record<string, unknown> {
  return { ...value } as Record<string, unknown>;
}

function ownedChanges(overrides: Partial<PullChanges> = {}): PullChanges {
  return {
    recipes: [],
    collections: [],
    chatMessages: [],
    cookState: [],
    photos: [],
    cookLogs: [],
    ...overrides,
  };
}

function ownedPage(changes: PullChanges): PullPage {
  return { changes, cursor: {}, hasMore: false };
}

function sharedPage(): SharedPullPage {
  return {
    changes: { recipes: [], collections: [], photos: [] },
    cursorToken: '',
    hasMore: false,
  };
}

function collection(id: string, name: string, recipeIds: string[]): Collection {
  return { id, name, recipeIds, createdAt: 1, updatedAt: 2 };
}

function seed(base: Recipe = recipe(), row: CookStateRow = cook(0)): void {
  replaceFromPull({
    recipes: new Map([[base.id, base]]),
    collections: new Map(),
    chat: new Map(),
    cook: new Map([[row.recipeId, row]]),
    cookLogs: new Map(),
    remotePhotoIds: new Set(),
  });
}

function gate<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * The app-open pull, as `sync` runs it: this sets `flight`, which is what
 * `localWriteOverlapsPull` and the follow-up reread look at. `pullAll` alone
 * does not.
 */
function startSync(first: PullPage, second: PullPage): {
  pending: Promise<void>;
  releaseFirst: () => void;
  releaseSecond: () => void;
} {
  const firstGate = gate<PullPage>();
  const secondGate = gate<PullPage>();
  let calls = 0;
  vi.mocked(pullPage).mockImplementation(() => {
    calls += 1;
    return calls === 1 ? firstGate.promise : secondGate.promise;
  });
  vi.mocked(pullSharedPage).mockResolvedValue(sharedPage());
  localStorage.setItem('cook.session', '{"sub":"me"}');
  const pending = sync();
  return {
    pending,
    releaseFirst: () => firstGate.release(first),
    releaseSecond: () => secondGate.release(second),
  };
}

/**
 * Same open pull as `startSync`, but the follow-up page stays pending until
 * `releaseSecond`. The failed `cookState.put` clock is only known after the
 * push, so the page cannot be closed over up front.
 */
function startSyncDeferredFollowUp(first: PullPage): {
  pending: Promise<void>;
  releaseFirst: () => void;
  releaseSecond: (page: PullPage) => void;
} {
  const firstGate = gate<PullPage>();
  const secondGate = gate<PullPage>();
  let calls = 0;
  vi.mocked(pullPage).mockImplementation(() => {
    calls += 1;
    return calls === 1 ? firstGate.promise : secondGate.promise;
  });
  vi.mocked(pullSharedPage).mockResolvedValue(sharedPage());
  localStorage.setItem('cook.session', '{"sub":"me"}');
  const pending = sync();
  return {
    pending,
    releaseFirst: () => firstGate.release(first),
    releaseSecond: (page) => secondGate.release(page),
  };
}

function cookPutPayload(callIndex: number): CookStateRow & { updatedAt: number } {
  const ops = vi.mocked(pushOps).mock.calls[callIndex]?.[0] ?? [];
  const put = ops.find((op) => op.kind === 'cookState.put');
  if (put?.kind !== 'cookState.put') {
    throw new Error('expected cookState.put');
  }
  return put.payload;
}

/** A pull that has captured its epoch and is waiting on the first page. */
function startPull(page: PullPage): {
  pending: Promise<Awaited<ReturnType<typeof pullAll>>>;
  release: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<PullPage>((resolve) => {
    release = () => resolve(page);
  });
  const pending = pullAll({
    pullPage: () => gate,
    pullSharedPage: async () => sharedPage(),
  });
  return { pending, release };
}

beforeEach(() => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  setRereadQuietForTests(0);
});

afterEach(() => {
  resetRereadScheduleForTests();
  clearLibrary();
  resetDiscardedPullForTests();
  vi.mocked(pushOps).mockReset();
  vi.mocked(pushOps).mockResolvedValue('ok');
  vi.mocked(postPhoto).mockReset();
  vi.mocked(pullPage).mockReset();
  vi.mocked(pullSharedPage).mockReset();
  localStorage.clear();
});

describe('optimistic writes vs an in-flight pull', () => {
  it('keeps both cook taps when the app-open pull started first', async () => {
    const base = recipe();
    seed(base, cook(0));
    const flight = startPull(ownedPage(ownedChanges({ cookState: [pullDoc(cook(0))] })));

    await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
    await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
    flight.release();

    const result = await flight.pending;
    expect(result.outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);
    expect(localWritesOpen()).toBe(0);
  });

  it('keeps a checkbox tap made while the pull is in flight', async () => {
    const base = recipe();
    seed(base, cook(0));
    const flight = startPull(
      ownedPage(ownedChanges({ cookState: [pullDoc({ ...cook(0), checkedKeys: [] })] })),
    );

    await updateCookState(base, (prev) => ({ ...prev, checkedKeys: ['0-0'] }));
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.checkedKeys).toEqual(['0-0']);
  });

  it('does not publish a pull that starts while the cook push is still open', async () => {
    const base = recipe();
    seed(base, cook(0));
    let releasePush: (result: 'ok') => void = () => {};
    vi.mocked(pushOps).mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePush = resolve;
        }),
    );

    const writing = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await vi.waitFor(() => {
      expect(pushOps).toHaveBeenCalled();
    });
    expect(localWritesOpen()).toBe(1);

    const flight = startPull(ownedPage(ownedChanges({ cookState: [pullDoc(cook(0))] })));
    releasePush('ok');
    await writing;
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(localWritesOpen()).toBe(0);
  });

  it('keeps a failed cook tap when the overlapping pull would revert it', async () => {
    const base = recipe();
    seed(base, cook(0));
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startPull(ownedPage(ownedChanges({ cookState: [pullDoc(cook(0))] })));

    await updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
  });

  it('applies a pull that starts after the cook write settles', async () => {
    const base = recipe();
    seed(base, cook(0));
    await updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));

    const result = await pullAll({
      pullPage: async () =>
        ownedPage(
          ownedChanges({
            recipes: [pullDoc(recipe())],
            cookState: [pullDoc(cook(0))],
          }),
        ),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(0);
    expect(localWritesOpen()).toBe(0);
  });

  it('keeps a chat message appended during the pull', async () => {
    seed();
    const flight = startPull(ownedPage(ownedChanges()));

    const message = await chatStore.append({
      recipeId: RECIPE_ID,
      role: 'user',
      content: 'more salt?',
    });
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(listChat(RECIPE_ID).map((row) => row.id)).toEqual([message.id]);
  });

  it('applies a pull that starts after the chat write settles', async () => {
    seed();
    await chatStore.append({
      recipeId: RECIPE_ID,
      role: 'user',
      content: 'more salt?',
    });

    const result = await pullAll({
      pullPage: async () =>
        ownedPage(
          ownedChanges({
            chatMessages: [
              {
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                recipeId: RECIPE_ID,
                role: 'user',
                content: 'from the server',
                createdAt: 9,
              },
            ],
          }),
        ),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(listChat(RECIPE_ID).map((row) => row.content)).toEqual(['from the server']);
  });

  it('keeps a recipe save made during the pull', async () => {
    const base = recipe('Soup');
    seed(base);
    const flight = startPull(ownedPage(ownedChanges({ recipes: [pullDoc(recipe('Soup'))] })));

    await recipeStore.save({ ...base, title: 'Stew' });
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getRecipe(RECIPE_ID)?.title).toBe('Stew');
  });

  it('applies a pull that starts after the recipe save settles', async () => {
    const base = recipe('Soup');
    seed(base);
    await recipeStore.save({ ...base, title: 'Stew' });

    const result = await pullAll({
      pullPage: async () => ownedPage(ownedChanges({ recipes: [pullDoc(recipe('Broth'))] })),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(getRecipe(RECIPE_ID)?.title).toBe('Broth');
  });

  it('keeps a collection created during the pull', async () => {
    seed();
    const flight = startPull(ownedPage(ownedChanges()));

    const created = await collectionStore.create('Dinners');
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(listCollections().map((row) => row.id)).toEqual([created.id]);
  });

  it('applies a pull that starts after the collection create settles', async () => {
    seed();
    await collectionStore.create('Dinners');

    const result = await pullAll({
      pullPage: async () => ownedPage(ownedChanges()),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(listCollections()).toEqual([]);
  });

  it('keeps a cook log created during the pull', async () => {
    seed();
    const flight = startPull(ownedPage(ownedChanges({ recipes: [pullDoc(recipe())] })));

    const log = await cookLogStore.create({
      recipeId: RECIPE_ID,
      cookedOn: '2026-09-20',
      lessons: 'Less salt.',
    });
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCookLog(log.id)?.lessons).toBe('Less salt.');
  });

  it('applies a pull that starts after the cook log create settles', async () => {
    seed();
    const log = await cookLogStore.create({
      recipeId: RECIPE_ID,
      cookedOn: '2026-09-20',
      lessons: 'Less salt.',
    });

    const result = await pullAll({
      pullPage: async () => ownedPage(ownedChanges({ recipes: [pullDoc(recipe())] })),
      pullSharedPage: async () => sharedPage(),
    });

    expect(result.outcome).toBe('ok');
    expect(getCookLog(log.id)).toBeUndefined();
  });

  it('rereads after a cook tap that overlapped the app-open pull', async () => {
    const base = recipe();
    seed(base, cook(0));
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(other)],
          cookState: [pullDoc(cook(1))],
        }),
      ),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const writing = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalled());
    await writing;
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(pullPage).toHaveBeenCalledOnce();

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(localWritesOpen()).toBe(0);
    await flight.pending;
  });

  it('rereads a failed cook tap and keeps the optimistic step', async () => {
    const base = recipe();
    seed(base, cook(0));
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(other)],
          cookState: [pullDoc(cook(0))],
        }),
      ),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const writing = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalled());
    await writing;
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(pullPage).toHaveBeenCalledOnce();

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(localWritesOpen()).toBe(0);
    await flight.pending;
  });

  it('does not restore a failed cook tap over a newer pulled step', async () => {
    const base = recipe();
    seed(base, cook(0));
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSyncDeferredFollowUp(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const writing = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalled());
    await writing;
    const failedAt = cookPutPayload(0).updatedAt;
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(getCook(RECIPE_ID)?.updatedAt).toBe(failedAt);
    expect(pullPage).toHaveBeenCalledOnce();

    const pulled = { ...cook(4), updatedAt: failedAt + 1 };
    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond(
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(other)],
          cookState: [pullDoc(pulled)],
        }),
      ),
    );
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getCook(RECIPE_ID)?.currentStep).toBe(4);
    expect(getCook(RECIPE_ID)?.updatedAt).toBe(failedAt + 1);
    expect(localWritesOpen()).toBe(0);

    // The next tap has to land after failedAt + 1. A real clock in the same
    // millisecond would not satisfy that.
    const later = failedAt + 10;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      vi.mocked(pushOps).mockResolvedValue('ok');
      await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
      const put = cookPutPayload(1);
      expect(put.currentStep).toBe(5);
      expect(put.updatedAt).toBeGreaterThan(failedAt + 1);
      expect(put.updatedAt).toBe(later);
      expect(put.updatedAt).not.toBe(2);
      expect(put.updatedAt).not.toBe(failedAt);
      expect(getCook(RECIPE_ID)?.updatedAt).toBe(put.updatedAt);
    } finally {
      now.mockRestore();
    }
    await flight.pending;
  });

  it('restores a failed cook tap when the pulled stamp is older', async () => {
    const base = recipe();
    seed(base, cook(0));
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSyncDeferredFollowUp(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const writing = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalled());
    await writing;
    const failedAt = cookPutPayload(0).updatedAt;
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(pullPage).toHaveBeenCalledOnce();

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond(
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(other)],
          cookState: [pullDoc({ ...cook(0), updatedAt: failedAt - 1 })],
        }),
      ),
    );
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(getCook(RECIPE_ID)?.updatedAt).toBe(failedAt);
    expect(localWritesOpen()).toBe(0);
    await flight.pending;
  });

  it('restores a failed cook tap when the pulled stamp matches', async () => {
    const base = recipe();
    seed(base, cook(0));
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSyncDeferredFollowUp(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const writing = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalled());
    await writing;
    const failedAt = cookPutPayload(0).updatedAt;
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(pullPage).toHaveBeenCalledOnce();

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond(
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(other)],
          cookState: [pullDoc({ ...cook(7), updatedAt: failedAt })],
        }),
      ),
    );
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(getCook(RECIPE_ID)?.updatedAt).toBe(failedAt);
    expect(localWritesOpen()).toBe(0);
    await flight.pending;
  });

  it('keeps a failed cook tap when a later write touches another row', async () => {
    setRereadQuietForTests(300);
    const base = recipe();
    const side = { ...recipe('Side'), id: OTHER_RECIPE_ID };
    const sideCook = { ...cook(0), recipeId: side.id };
    replaceFromPull({
      recipes: new Map([
        [base.id, base],
        [side.id, side],
      ]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map([
        [base.id, cook(0)],
        [side.id, sideCook],
      ]),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    });
    let pushes = 0;
    vi.mocked(pushOps).mockImplementation(async () => {
      pushes += 1;
      return pushes === 1 ? 'error' : 'ok';
    });
    const flight = startSync(
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(side)],
          cookState: [pullDoc(cook(0)), pullDoc(sideCook)],
        }),
      ),
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc({ ...side, title: 'From another device' })],
          cookState: [pullDoc(cook(0)), pullDoc({ ...sideCook, currentStep: 4 })],
        }),
      ),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    await updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await updateCookState(side, (prev) => ({ ...prev, currentStep: 4 }));
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(getCook(OTHER_RECIPE_ID)?.currentStep).toBe(4);
    expect(pullPage).toHaveBeenCalledOnce();

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
    expect(getCook(OTHER_RECIPE_ID)?.currentStep).toBe(4);
    expect(localWritesOpen()).toBe(0);
    await flight.pending;
  });

  it('keeps the later failed cook tap when an earlier one also failed', async () => {
    setRereadQuietForTests(300);
    const base = recipe();
    seed(base, cook(0));
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    await updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await updateCookState(base, (prev) => ({ ...prev, currentStep: 2 }));
    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);
    expect(pullPage).toHaveBeenCalledOnce();

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await flight.pending;

    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);
  });

  it('keeps a failed cook tap when another pull publishes during the quiet window', async () => {
    vi.useFakeTimers();
    try {
      setRereadQuietForTests(300);
      const base = recipe();
      seed(base, cook(0));
      vi.mocked(pushOps).mockResolvedValue('error');
      const firstGate = gate<PullPage>();
      let calls = 0;
      vi.mocked(pullPage).mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return firstGate.promise;
        }
        return Promise.resolve(
          ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
        );
      });
      vi.mocked(pullSharedPage).mockResolvedValue(sharedPage());
      localStorage.setItem('cook.session', '{"sub":"me"}');

      const opening = sync();
      expect(pullPage).toHaveBeenCalledOnce();

      await updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
      expect(getCook(RECIPE_ID)?.currentStep).toBe(1);

      firstGate.release(
        ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      );
      await opening;
      expect(getCook(RECIPE_ID)?.currentStep).toBe(1);

      await sync();
      expect(getCook(RECIPE_ID)?.currentStep).toBe(0);

      await vi.advanceTimersByTimeAsync(300);

      expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
      expect(localWritesOpen()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not put a failed cook tap back over a later successful one', async () => {
    setRereadQuietForTests(300);
    const base = recipe();
    seed(base, cook(0));
    let pushes = 0;
    vi.mocked(pushOps).mockImplementation(async () => {
      pushes += 1;
      return pushes === 1 ? 'error' : 'ok';
    });
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(2))] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    await updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await updateCookState(base, (prev) => ({ ...prev, currentStep: 2 }));
    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await flight.pending;

    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);
  });

  it('keeps a failed cook tap when the follow-up pull is superseded', async () => {
    const base = recipe();
    const side = { ...recipe('Side'), id: OTHER_RECIPE_ID };
    const sideCook = { ...cook(0), recipeId: side.id };
    replaceFromPull({
      recipes: new Map([
        [base.id, base],
        [side.id, side],
      ]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map([
        [base.id, cook(0)],
        [side.id, sideCook],
      ]),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    });
    const releases: Array<(result: 'ok' | 'error') => void> = [];
    vi.mocked(pushOps).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const outcomes: string[] = [];
    const stop = onSyncFinished((result) => {
      outcomes.push(result.outcome);
    });
    try {
      const flight = startSync(
        ownedPage(
          ownedChanges({
            recipes: [pullDoc(base), pullDoc(side)],
            cookState: [pullDoc(cook(0)), pullDoc(sideCook)],
          }),
        ),
        ownedPage(
          ownedChanges({
            recipes: [pullDoc(base), pullDoc(side)],
            cookState: [pullDoc(cook(0)), pullDoc({ ...sideCook, currentStep: 4 })],
          }),
        ),
      );
      await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

      const failed = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
      await vi.waitFor(() => expect(pushOps).toHaveBeenCalledOnce());
      flight.releaseFirst();
      releases[0]?.('error');
      await failed;
      await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));

      const sideTap = updateCookState(side, (prev) => ({ ...prev, currentStep: 4 }));
      await vi.waitFor(() => expect(pushOps).toHaveBeenCalledTimes(2));
      flight.releaseSecond();
      releases[1]?.('ok');
      await sideTap;
      await vi.waitFor(() => expect(outcomes).toEqual(['superseded', 'superseded', 'ok']));

      expect(getCook(RECIPE_ID)?.currentStep).toBe(1);
      expect(getCook(OTHER_RECIPE_ID)?.currentStep).toBe(4);
      expect(localWritesOpen()).toBe(0);
      await flight.pending;
    } finally {
      stop();
    }
  });

  it('shares one follow-up pull across a burst of cook taps', async () => {
    setRereadQuietForTests(200);
    const base = recipe();
    seed(base, cook(0));
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(other)],
          cookState: [pullDoc(cook(3))],
        }),
      ),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
    await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
    await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
    expect(getCook(RECIPE_ID)?.currentStep).toBe(3);
    expect(pullPage).toHaveBeenCalledOnce();

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getCook(RECIPE_ID)?.currentStep).toBe(3);
    expect(localWritesOpen()).toBe(0);
    await flight.pending;
  });

  it('rereads when the cook push outlasts the pull it superseded', async () => {
    const base = recipe();
    seed(base, cook(0));
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    let releasePush: (result: 'ok') => void = () => {};
    vi.mocked(pushOps).mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePush = resolve;
        }),
    );
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(other)],
          cookState: [pullDoc(cook(1))],
        }),
      ),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const writing = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalledOnce());
    flight.releaseFirst();
    await flight.pending;
    expect(pullPage).toHaveBeenCalledOnce();

    releasePush('ok');
    await writing;
    expect(pullPage).toHaveBeenCalledTimes(2);
    expect(getCook(RECIPE_ID)?.currentStep).toBe(1);

    flight.releaseSecond();
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));
    expect(localWritesOpen()).toBe(0);
  });

  it('rereads after a second cook tap when the first follow-up bailed', async () => {
    const base = recipe();
    seed(base, cook(0));
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    const releases: Array<(result: 'ok') => void> = [];
    vi.mocked(pushOps).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      ownedPage(
        ownedChanges({
          recipes: [pullDoc(base), pullDoc(other)],
          cookState: [pullDoc(cook(2))],
        }),
      ),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const first = updateCookState(base, (prev) => ({
      ...prev,
      currentStep: prev.currentStep + 1,
    }));
    const second = updateCookState(base, (prev) => ({
      ...prev,
      currentStep: prev.currentStep + 1,
    }));
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalledTimes(2));
    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);

    releases[0]?.('ok');
    await vi.waitFor(() => expect(localWritesOpen()).toBe(1));
    flight.releaseFirst();
    await flight.pending;

    releases[1]?.('ok');
    await Promise.all([first, second]);
    expect(pullPage).toHaveBeenCalledTimes(2);
    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);

    flight.releaseSecond();
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));
    expect(localWritesOpen()).toBe(0);
  });

  it('keeps the second cook tap when both pushes are in flight together', async () => {
    const base = recipe();
    seed(base, cook(0));
    const releases: Array<(result: 'ok') => void> = [];
    vi.mocked(pushOps).mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    const flight = startPull(ownedPage(ownedChanges({ cookState: [pullDoc(cook(0))] })));
    const first = updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
    const second = updateCookState(base, (prev) => ({
      ...prev,
      currentStep: prev.currentStep + 1,
    }));
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalledTimes(2));
    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);

    releases[0]?.('ok');
    releases[1]?.('ok');
    await Promise.all([first, second]);
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCook(RECIPE_ID)?.currentStep).toBe(2);
    expect(localWritesOpen()).toBe(0);
  });

  it('keeps a cleared chat when the pull still has the thread', async () => {
    seed();
    const message = {
      id: CHAT_ID,
      recipeId: RECIPE_ID,
      role: 'user' as const,
      content: 'keep me',
      createdAt: 3,
    };
    replaceFromPull({
      recipes: new Map([[RECIPE_ID, recipe()]]),
      collections: new Map(),
      chat: new Map([[message.id, message]]),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    });
    const flight = startPull(
      ownedPage(ownedChanges({ chatMessages: [pullDoc(message)] })),
    );

    await chatStore.clearForRecipe(RECIPE_ID);
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(listChat(RECIPE_ID)).toEqual([]);
  });

  it('keeps a deleted photo when the pull still lists it', async () => {
    replaceFromPull({
      recipes: new Map([[RECIPE_ID, recipe()]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set([PHOTO_ID]),
    });
    const flight = startPull(ownedPage(ownedChanges({ photos: [{ id: PHOTO_ID }] })));

    await photoStore.remove(PHOTO_ID);
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getSnapshot().remotePhotoIds.has(PHOTO_ID)).toBe(false);
  });

  it('puts a remote photo back when its delete fails and nothing will reread', async () => {
    replaceFromPull({
      recipes: new Map([[RECIPE_ID, recipe()]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set([PHOTO_ID]),
    });
    vi.mocked(pushOps).mockResolvedValue('error');

    await photoStore.remove(PHOTO_ID);

    expect(getSnapshot().remotePhotoIds.has(PHOTO_ID)).toBe(true);
    expect(pullPage).not.toHaveBeenCalled();
  });

  it('keeps a remote photo when the follow-up snapshot still lists it', async () => {
    replaceFromPull({
      recipes: new Map([[RECIPE_ID, recipe()]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set([PHOTO_ID]),
    });
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSync(
      ownedPage(ownedChanges({ photos: [{ id: PHOTO_ID }], recipes: [pullDoc(recipe())] })),
      ownedPage(
        ownedChanges({
          photos: [{ id: PHOTO_ID }],
          recipes: [pullDoc(recipe()), pullDoc(other)],
        }),
      ),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const removing = photoStore.remove(PHOTO_ID);
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalled());
    await removing;
    expect(pullPage).toHaveBeenCalledOnce();
    expect(getSnapshot().remotePhotoIds.has(PHOTO_ID)).toBe(false);

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getSnapshot().remotePhotoIds.has(PHOTO_ID)).toBe(true);
    await flight.pending;
  });

  it('leaves a photo gone when the follow-up snapshot omits it', async () => {
    replaceFromPull({
      recipes: new Map([[RECIPE_ID, recipe()]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set([PHOTO_ID]),
    });
    const other = { ...recipe('From another device'), id: OTHER_RECIPE_ID };
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSync(
      ownedPage(ownedChanges({ photos: [{ id: PHOTO_ID }], recipes: [pullDoc(recipe())] })),
      ownedPage(ownedChanges({ recipes: [pullDoc(recipe()), pullDoc(other)] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    await photoStore.remove(PHOTO_ID);
    expect(getSnapshot().remotePhotoIds.has(PHOTO_ID)).toBe(false);

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('From another device'));

    expect(getSnapshot().remotePhotoIds.has(PHOTO_ID)).toBe(false);
    await flight.pending;
  });

  it('does not put a photo back after the delete signs out', async () => {
    replaceFromPull({
      recipes: new Map([[RECIPE_ID, recipe()]]),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set([PHOTO_ID]),
    });
    vi.mocked(pushOps).mockImplementation(async () => {
      invalidateSession();
      return 'signedOut';
    });

    await photoStore.remove(PHOTO_ID);

    expect(getSnapshot().remotePhotoIds.has(PHOTO_ID)).toBe(false);
    expect(getRecipe(RECIPE_ID)).toBeUndefined();
  });

  it('keeps a removed collection when the pull still has it', async () => {
    const dinners = collection(COLLECTION_A, 'Dinners', [RECIPE_ID]);
    replaceFromPull({
      recipes: new Map([[RECIPE_ID, recipe()]]),
      collections: new Map([[dinners.id, dinners]]),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    });
    const flight = startPull(ownedPage(ownedChanges({ collections: [pullDoc(dinners)] })));

    await collectionStore.remove(COLLECTION_A);
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCollection(COLLECTION_A)).toBeUndefined();
  });

  it('keeps a recipe move when the pull still has the old membership', async () => {
    const from = collection(COLLECTION_A, 'From', [RECIPE_ID]);
    const to = collection(COLLECTION_B, 'To', []);
    replaceFromPull({
      recipes: new Map([[RECIPE_ID, recipe()]]),
      collections: new Map([
        [from.id, from],
        [to.id, to],
      ]),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set(),
    });
    const flight = startPull(
      ownedPage(ownedChanges({ collections: [pullDoc(from), pullDoc(to)] })),
    );

    await collectionStore.moveRecipe(RECIPE_ID, COLLECTION_B);
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getCollection(COLLECTION_A)?.recipeIds).toEqual([]);
    expect(getCollection(COLLECTION_B)?.recipeIds).toEqual([RECIPE_ID]);
  });

  it('finishes the first load when a create and its discard both fail during a pull', async () => {
    markUnloadedForTests();
    expect(getSnapshot().loaded).toBe(false);
    const kept = { ...recipe('Kept'), id: CREATED_ID };
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSync(
      ownedPage(ownedChanges()),
      ownedPage(ownedChanges({ recipes: [pullDoc(kept)] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());
    const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(CREATED_ID);
    try {
      const creating = recipeStore.create({
        title: 'Kept',
        servings: 2,
        ingredientSections: [{ items: [{ item: 'onion' }] }],
        steps: [{ text: 'Chop.' }, { text: 'Cook.' }],
        tags: [],
      });
      await vi.waitFor(() => {
        expect(pushOps).toHaveBeenCalledTimes(2);
        expect(localWritesOpen()).toBe(0);
      });
      expect(getSnapshot().loaded).toBe(false);

      flight.releaseFirst();
      await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
      expect(getSnapshot().loaded).toBe(false);
      flight.releaseSecond();

      await expect(creating).rejects.toBeInstanceOf(CreateRollbackError);
      expect(getSnapshot().loaded).toBe(true);
      expect(getRecipe(CREATED_ID)?.title).toBe('Kept');
      await flight.pending;
    } finally {
      uuid.mockRestore();
    }
  });

  it('keeps a recipe created while the pull is in flight', async () => {
    seed();
    const flight = startPull(ownedPage(ownedChanges({ recipes: [pullDoc(recipe())] })));

    const created = await recipeStore.create({
      title: 'New',
      servings: 1,
      ingredientSections: [],
      steps: [{ text: 'Go.' }],
      tags: [],
    });
    flight.release();

    expect((await flight.pending).outcome).toBe('superseded');
    expect(getRecipe(created.id)?.title).toBe('New');
  });

  it('rereads a partial backup import when the recipe push landed during a pull', async () => {
    const base = recipe('Already here');
    seed(base);
    const imported = { ...recipe('Imported'), id: OTHER_RECIPE_ID };
    const file = new File(
      [
        JSON.stringify({
          app: 'cook',
          version: 4,
          exportedAt: 1,
          exportedBySub: 'me',
          recipes: [imported],
          chatMessages: [
            {
              id: CHAT_ID,
              recipeId: OTHER_RECIPE_ID,
              role: 'user',
              content: 'from the backup',
              createdAt: 4,
            },
          ],
          photos: [],
          collections: [],
          cookState: [],
        }),
      ],
      'cook-backup.json',
      { type: 'application/json' },
    );
    let pushes = 0;
    vi.mocked(pushOps).mockImplementation(async () => {
      pushes += 1;
      return pushes === 1 ? 'ok' : 'error';
    });
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base)] })),
      ownedPage(ownedChanges({ recipes: [pullDoc(base), pullDoc(imported)] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const importing = importLibrary(file, 'me');
    const rejected = expect(importing).rejects.toThrow("Couldn't import the backup.");
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalledTimes(2));

    await rejected;
    expect(pullPage).toHaveBeenCalledOnce();
    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await flight.pending;
    await vi.waitFor(() => expect(getRecipe(OTHER_RECIPE_ID)?.title).toBe('Imported'));

    expect(getRecipe(RECIPE_ID)?.title).toBe('Already here');
    expect(listChat(OTHER_RECIPE_ID)).toEqual([]);
  });

  it('rereads a backup whose recipe push never landed and keeps the seed', async () => {
    const base = recipe('Already here');
    seed(base);
    const imported = { ...recipe('Imported'), id: OTHER_RECIPE_ID };
    const file = new File(
      [
        JSON.stringify({
          app: 'cook',
          version: 4,
          exportedAt: 1,
          exportedBySub: 'me',
          recipes: [imported],
          chatMessages: [],
          photos: [],
          collections: [],
          cookState: [],
        }),
      ],
      'cook-backup.json',
      { type: 'application/json' },
    );
    vi.mocked(pushOps).mockResolvedValue('error');
    const flight = startSync(
      ownedPage(ownedChanges({ recipes: [pullDoc(base), pullDoc(imported)] })),
      ownedPage(ownedChanges({ recipes: [pullDoc(base)] })),
    );
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

    const importing = importLibrary(file, 'me');
    const rejected = expect(importing).rejects.toThrow("Couldn't import the backup.");
    await vi.waitFor(() => expect(pushOps).toHaveBeenCalled());
    await rejected;
    expect(pullPage).toHaveBeenCalledOnce();
    expect(getRecipe(OTHER_RECIPE_ID)).toBeUndefined();
    expect(getRecipe(RECIPE_ID)?.title).toBe('Already here');

    flight.releaseFirst();
    await vi.waitFor(() => expect(pullPage).toHaveBeenCalledTimes(2));
    flight.releaseSecond();
    await flight.pending;

    expect(getRecipe(OTHER_RECIPE_ID)).toBeUndefined();
    expect(getRecipe(RECIPE_ID)?.title).toBe('Already here');
  });

  it('does not pull again after a follow-up read fails', async () => {
    const base = recipe();
    seed(base, cook(0));
    const outcomes: string[] = [];
    const stop = onSyncFinished((result) => {
      outcomes.push(result.outcome);
    });
    try {
      const firstGate = gate<PullPage>();
      let calls = 0;
      vi.mocked(pullPage).mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return firstGate.promise;
        }
        return Promise.resolve(
          ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(1))] })),
        );
      });
      vi.mocked(pullSharedPage).mockResolvedValue('error');
      localStorage.setItem('cook.session', '{"sub":"me"}');
      const pending = sync();
      await vi.waitFor(() => expect(pullPage).toHaveBeenCalledOnce());

      const first = updateCookState(base, (prev) => ({ ...prev, currentStep: 1 }));
      await vi.waitFor(() => expect(pushOps).toHaveBeenCalledOnce());
      await first;
      firstGate.release(
        ownedPage(ownedChanges({ recipes: [pullDoc(base)], cookState: [pullDoc(cook(0))] })),
      );
      await pending;
      await vi.waitFor(() => expect(outcomes).toEqual(['superseded', 'error']));

      const pullsAfterError = calls;
      await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
      await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
      await updateCookState(base, (prev) => ({ ...prev, currentStep: prev.currentStep + 1 }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toBe(pullsAfterError);
      expect(outcomes).toEqual(['superseded', 'error']);
      expect(getCook(RECIPE_ID)?.currentStep).toBe(4);
    } finally {
      stop();
    }
  });
});
