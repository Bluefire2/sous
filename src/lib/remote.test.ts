import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addCollectionGrant,
  applyPullChanges,
  createCollectionLink,
  fetchPhotoBlob,
  fetchPhotoBlobOutcome,
  firstPushRejection,
  leaveSharedCollection,
  normalizeChatChange,
  normalizeCookChange,
  parseCollectionLinksBody,
  pullSharedPage,
  pushOps,
  resetPushTimeoutForTests,
  setPushTimeoutForTests,
  SHARED_PARENT_OWNER_SUB_FIELD,
} from './remote';
import type { PushOp } from './pushOps';
import { isDiscardedPushReason } from './pushReasons';
import { t } from '../i18n';

const op: PushOp = {
  kind: 'recipe.delete',
  payload: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', updatedAt: 1 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
});

afterEach(() => {
  resetPushTimeoutForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('parseCollectionLinksBody', () => {
  it('keeps well-formed rows, defaults an unknown role to viewer, and passes the one-time url', () => {
    expect(
      parseCollectionLinksBody({
        url: 'https://sous.example/c/abc',
        links: [
          { id: 'a', role: 'editor', createdAt: 1, expiresAt: 2 },
          { id: 'b', role: 'owner', createdAt: 1, expiresAt: 2 },
          { id: 'c', createdAt: 'x', expiresAt: 2 },
          null,
        ],
      }),
    ).toEqual({
      url: 'https://sous.example/c/abc',
      links: [
        { id: 'a', role: 'editor', createdAt: 1, expiresAt: 2 },
        { id: 'b', role: 'viewer', createdAt: 1, expiresAt: 2 },
      ],
    });
  });

  it('keeps the revokedId of a revoke response', () => {
    expect(parseCollectionLinksBody({ revokedId: 'a'.repeat(64), links: [], partial: true })).toEqual({
      revokedId: 'a'.repeat(64),
      links: [],
      partial: true,
    });
  });

  it('keeps the minted id and the partial flag, and nothing else', () => {
    expect(
      parseCollectionLinksBody({ url: 'u', id: 'a'.repeat(64), links: [], partial: true, extra: 1 }),
    ).toEqual({ url: 'u', id: 'a'.repeat(64), links: [], partial: true });
    expect(parseCollectionLinksBody({ links: [], partial: 'yes', id: 5 })).toEqual({ links: [] });
  });

  it('has no url on a list or revoke response, and rejects a body without links', () => {
    expect(parseCollectionLinksBody({ links: [] })).toEqual({ links: [] });
    expect(parseCollectionLinksBody({ grants: [] })).toBeNull();
    expect(parseCollectionLinksBody(null)).toBeNull();
  });
});

describe('createCollectionLink', () => {
  it('posts the role and treats 401 as signed out', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const result = await createCollectionLink('col-1', 'editor');
    expect(result).toEqual({ kind: 'signedOut' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/collections/col-1/links',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ role: 'editor' }) }),
    );
  });
});

describe('sharing requests that never reach the server', () => {
  it('say offline when the browser is offline, and a generic failure otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    vi.stubGlobal('navigator', { onLine: false });
    await expect(addCollectionGrant('col-1', 'a@example.com', 'viewer')).resolves.toEqual({
      kind: 'error',
      message: t('error.sharingOffline'),
    });
    vi.stubGlobal('navigator', { onLine: true });
    await expect(addCollectionGrant('col-1', 'a@example.com', 'viewer')).resolves.toEqual({
      kind: 'error',
      message: t('error.sharingUpdate'),
    });
  });

  it('shows the server code text for an unknown email', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 'share-no-account', error: 'No account' }, 404)),
    );
    await expect(addCollectionGrant('col-1', 'a@example.com', 'viewer')).resolves.toMatchObject({
      kind: 'error',
      message: t('error.shareNoAccount'),
      status: 404,
    });
  });
});

describe('isDiscardedPushReason', () => {
  it('accepts only invalid, unknown, and cap', () => {
    expect(isDiscardedPushReason('invalid')).toBe(true);
    expect(isDiscardedPushReason('unknown')).toBe(true);
    expect(isDiscardedPushReason('cap')).toBe(true);
    expect(isDiscardedPushReason('caps')).toBe(false);
    expect(isDiscardedPushReason('stale')).toBe(false);
  });
});

describe('firstPushRejection', () => {
  it('returns the first discarded-write reason', () => {
    expect(firstPushRejection(null)).toBeNull();
    expect(firstPushRejection({})).toBeNull();
    expect(firstPushRejection({ results: [{ applied: true }] })).toBeNull();
    expect(firstPushRejection({ results: [{ applied: false }] })).toBeNull();
    expect(
      firstPushRejection({
        results: [
          { applied: false, reason: 'stale' },
          { applied: false, reason: 'invalid' },
          { applied: false, reason: 'unknown' },
        ],
      }),
    ).toBe('invalid');
    expect(
      firstPushRejection({ results: [{ applied: false, reason: 'cap' }] }),
    ).toBe('cap');
    expect(
      firstPushRejection({ results: [{ applied: false, reason: 'unknown' }] }),
    ).toBe('unknown');
  });

  it('ignores ordinary last-write-wins and cascade outcomes', () => {
    expect(
      firstPushRejection({ results: [{ applied: false, reason: 'stale' }] }),
    ).toBeNull();
    expect(
      firstPushRejection({
        results: [{ applied: false, reason: 'already-deleted' }],
      }),
    ).toBeNull();
    expect(
      firstPushRejection({
        results: [{ applied: false, reason: 'recipe-deleted' }],
      }),
    ).toBeNull();
    expect(
      firstPushRejection({ results: [{ applied: false, reason: 'caps' }] }),
    ).toBeNull();
  });
});

describe('fetchPhotoBlobOutcome', () => {
  it('returns the blob on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    const outcome = await fetchPhotoBlobOutcome('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(outcome).toBeInstanceOf(Blob);
  });

  it('returns missing on 404 and unavailable on 503 or a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect(await fetchPhotoBlobOutcome('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('missing');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    expect(await fetchPhotoBlobOutcome('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('unavailable');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await fetchPhotoBlobOutcome('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('unavailable');
  });

  it('keeps fetchPhotoBlob collapsing missing and unavailable to null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect(await fetchPhotoBlob('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    expect(await fetchPhotoBlob('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
  });
});

describe('pushOps', () => {
  it.each([
    [{ applied: false, reason: 'invalid' }, 'invalid'],
    [{ applied: false, reason: 'unknown' }, 'unknown'],
    [{ applied: false, reason: 'cap' }, 'cap'],
    [{ applied: false, reason: 'stale' }, 'ok'],
    [{ applied: false, reason: 'already-deleted' }, 'ok'],
    [{ applied: false, reason: 'recipe-deleted' }, 'ok'],
    [{ applied: false }, 'ok'],
    [{ applied: true }, 'ok'],
  ] as const)('maps %j to %s', async (entry, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ results: [entry] })),
    );
    expect(await pushOps([op])).toBe(expected);
  });

  it('returns error when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await pushOps([op])).toBe('error');
  });

  it('returns error when the push hangs past the timeout', async () => {
    setPushTimeoutForTests(20);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            return;
          }
          const abort = () => reject(signal.reason);
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        });
      }),
    );
    await expect(pushOps([op])).resolves.toBe('error');
  });

  it('returns error on a non-OK status other than 401/403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect(await pushOps([op])).toBe('error');
  });

  it('returns signedOut on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    expect(await pushOps([op])).toBe('signedOut');
  });
});

describe('leaveSharedCollection', () => {
  const ownerSub = 'owner-sub';
  const collectionId = 'collection-id';

  it('treats a 404 (already gone) as success', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(leaveSharedCollection(ownerSub, collectionId)).resolves.toEqual({
      kind: 'ok',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/shared/leave',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ownerSub, collectionId }),
      }),
    );
  });

  it('reports ok for a successful leave', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    await expect(leaveSharedCollection(ownerSub, collectionId)).resolves.toEqual({
      kind: 'ok',
    });
  });

  it('signs the client out on 401/403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(leaveSharedCollection(ownerSub, collectionId)).resolves.toEqual({
      kind: 'signedOut',
    });
  });

  it('reports unavailable on 503 without signing out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(leaveSharedCollection(ownerSub, collectionId)).resolves.toEqual({
      kind: 'error',
      message: 'Sharing is temporarily unavailable.',
      status: 503,
    });
  });

  it('surfaces the server message on another error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Bad request' }, 400)),
    );
    await expect(leaveSharedCollection(ownerSub, collectionId)).resolves.toEqual({
      kind: 'error',
      message: 'Bad request',
      status: 400,
    });
  });

  it('maps a known error code instead of the English sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Bad request', code: 'bad-request' }, 400)),
    );
    await expect(leaveSharedCollection(ownerSub, collectionId)).resolves.toEqual({
      kind: 'error',
      message: 'That request was not valid.',
      status: 400,
    });
  });

  it('returns a generic error when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(leaveSharedCollection(ownerSub, collectionId)).resolves.toEqual({
      kind: 'error',
      message: "Couldn't leave the collection.",
    });
  });
});

describe('pullSharedPage', () => {
  it('requests the hardcoded shared page limit', async () => {
    const fetchMock = vi.fn(
      async () =>
        jsonResponse({
          changes: { collections: [], recipes: [], photos: [] },
          cursorToken: 'signed-cursor',
          hasMore: false,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await pullSharedPage(null);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sync/shared?limit=200',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }),
    );
    expect(page).toEqual({
      changes: { collections: [], recipes: [], photos: [] },
      cursorToken: 'signed-cursor',
      hasMore: false,
    });
  });

  it('maps only the typed snapshot-changed response to restart', async () => {
    localStorage.setItem('cook.session', 'present');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: 'shared-snapshot-changed' }, 409),
      ),
    );
    expect(await pullSharedPage('stale-cursor')).toBe('restart');
    expect(localStorage.getItem('cook.session')).toBe('present');
  });

  it('does not treat HTTP 200 as a generation restart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          error: 'shared-snapshot-changed',
          changes: { collections: [], recipes: [], photos: [] },
          cursorToken: 'token',
          hasMore: false,
        }),
      ),
    );
    const page = await pullSharedPage('stale-cursor');
    expect(page).not.toBe('restart');
    expect(page).toMatchObject({ hasMore: false, cursorToken: 'token' });
  });

  it('keeps other non-2xx responses on the existing error path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'shared-snapshot-changed' }, 500)),
    );
    expect(await pullSharedPage('cursor')).toBe('error');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, 409)),
    );
    expect(await pullSharedPage('cursor')).toBe('error');
  });

  it('keeps 401 and 403 as signed out', async () => {
    localStorage.setItem('cook.session', 'present');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'shared-snapshot-changed' }, 401)),
    );
    expect(await pullSharedPage('cursor')).toBe('signedOut');
    expect(localStorage.getItem('cook.session')).toBeNull();

    localStorage.setItem('cook.session', 'present');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'shared-snapshot-changed' }, 403)),
    );
    expect(await pullSharedPage('cursor')).toBe('signedOut');
    expect(localStorage.getItem('cook.session')).toBeNull();
  });
});

describe('normalizeChatChange / normalizeCookChange', () => {
  it('leaves the locked domain key sets unchanged and ignores parent provenance', () => {
    expect(SHARED_PARENT_OWNER_SUB_FIELD).toBe('sharedParentOwnerSub');
    const chat = normalizeChatChange({
      id: 'c1',
      recipeId: 'r1',
      role: 'user',
      content: 'hi',
      createdAt: 3,
      photoIds: ['p1'],
      updatedAt: 3,
      serverUpdatedAt: 9,
      sharedParentOwnerSub: 'owner-sub',
      uid: 'nope',
    });
    expect(chat).not.toBe('tombstone');
    if (chat === 'tombstone') {
      return;
    }
    expect(Object.keys(chat).sort()).toEqual([
      'content',
      'createdAt',
      'id',
      'photoIds',
      'recipeId',
      'role',
    ]);
    expect(chat).not.toHaveProperty('sharedParentOwnerSub');

    const cook = normalizeCookChange({
      id: 'r1',
      recipeId: 'r1',
      servings: 2,
      currentStep: 1,
      doneSteps: [3],
      checkedKeys: ['0-0'],
      recipeUpdatedAt: 2,
      updatedAt: 4,
      sharedParentOwnerSub: 'owner-sub',
    });
    expect(cook).not.toBe('tombstone');
    if (cook === 'tombstone') {
      return;
    }
    // `doneSteps` is the deliberate addition from docs/plans/parallel-steps.md.
    expect(Object.keys(cook).sort()).toEqual([
      'checkedKeys',
      'currentStep',
      'doneSteps',
      'recipeId',
      'recipeUpdatedAt',
      'servings',
      'updatedAt',
    ]);
    expect(cook).not.toHaveProperty('sharedParentOwnerSub');
    expect(cook.updatedAt).toBe(4);
  });

  it('omits a missing or unusable cook updatedAt and still tombstones a delete', () => {
    const live = {
      recipeId: 'r1',
      servings: 2,
      currentStep: 1,
      checkedKeys: ['0-0'],
      recipeUpdatedAt: 2,
    };
    const cases = [
      live,
      { ...live, updatedAt: Number.NaN },
      { ...live, updatedAt: Number.POSITIVE_INFINITY },
      { ...live, updatedAt: '4' },
    ];
    for (const raw of cases) {
      const cook = normalizeCookChange(raw);
      expect(cook).not.toBe('tombstone');
      if (cook === 'tombstone') {
        continue;
      }
      expect(cook).not.toHaveProperty('updatedAt');
    }
    expect(normalizeCookChange({ ...live, deletedAt: 9 })).toBe('tombstone');
  });

  it('keeps doneSteps only when something is left after normalizing', () => {
    const live = {
      recipeId: 'r1',
      servings: 2,
      currentStep: 1,
      checkedKeys: [],
      recipeUpdatedAt: 2,
    };
    for (const doneSteps of [[], ['x', -1, 2.5], 'nope']) {
      const cook = normalizeCookChange({ ...live, doneSteps });
      expect(cook).not.toBe('tombstone');
      if (cook === 'tombstone') return;
      expect(cook).not.toHaveProperty('doneSteps');
      expect(cook.currentStep).toBe(1);
    }
    const folded = normalizeCookChange({ ...live, doneSteps: [1, 2] });
    expect(folded).toEqual({ ...live, currentStep: 3 });
    const kept = normalizeCookChange({ ...live, doneSteps: [5, 3, 3] });
    expect(kept).toEqual({ ...live, doneSteps: [3, 5] });
  });

  it('places provenance only in sidecars', () => {
    const acc = {
      recipes: new Map(),
      collections: new Map(),
      chat: new Map(),
      cook: new Map(),
      cookLogs: new Map(),
      remotePhotoIds: new Set<string>(),
      chatParentOrigins: new Map<string, string>(),
      cookParentOrigins: new Map<string, string>(),
    };
    applyPullChanges(acc, {
      recipes: [],
      chatMessages: [
        {
          id: 'c1',
          recipeId: 'r1',
          role: 'user',
          content: 'hi',
          createdAt: 3,
          sharedParentOwnerSub: 'owner-sub',
        },
      ],
      cookState: [
        {
          recipeId: 'r1',
          servings: 1,
          currentStep: 0,
          checkedKeys: [],
          recipeUpdatedAt: 1,
          sharedParentOwnerSub: 'owner-sub',
        },
      ],
      photos: [],
    });
    expect(acc.chat.get('c1')).not.toHaveProperty('sharedParentOwnerSub');
    expect(acc.cook.get('r1')).not.toHaveProperty('sharedParentOwnerSub');
    expect(acc.chatParentOrigins.get('c1')).toBe('owner-sub');
    expect(acc.cookParentOrigins.get('r1')).toBe('owner-sub');
  });
});
