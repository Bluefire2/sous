import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import {
  fetchPublicLink,
  joinPublicCollection,
  parsePublicCollection,
  parsePublicLink,
  publicPhotoUrl,
  savePublicRecipe,
} from './publicApi';
import { invalidateSession } from './session';

vi.mock('./session', () => ({ invalidateSession: vi.fn() }));

const recipe = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Soup',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'salt' }] }],
  steps: [{ text: 'Cook.' }],
  tags: [],
  createdAt: 1,
  updatedAt: 2,
};

describe('parsePublicCollection', () => {
  it('keeps the collection and usable recipes', () => {
    const parsed = parsePublicCollection({
      collection: { id: 'c1', name: 'Soups' },
      recipes: [recipe, { ...recipe, id: '', title: 'broken' }, null],
    });
    expect(parsed?.collection).toEqual({ id: 'c1', name: 'Soups' });
    expect(parsed?.recipes.map((r) => r.title)).toEqual(['Soup']);
  });

  it('rejects a wrong envelope', () => {
    expect(parsePublicCollection(null)).toBeNull();
    expect(parsePublicCollection({ recipes: [] })).toBeNull();
    expect(parsePublicCollection({ collection: { id: 'c1', name: 'x' } })).toBeNull();
    expect(parsePublicCollection({ collection: { id: 1, name: 'x' }, recipes: [] })).toBeNull();
  });
});

describe('publicPhotoUrl', () => {
  it('points at the public photo route for that recipe', () => {
    expect(publicPhotoUrl('tok', 'r1', 'p1')).toBe('/api/public/tok/recipes/r1/photos/p1');
  });
});

describe('joinPublicCollection', () => {
  function respond(status: number, body?: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        body === undefined
          ? new Response(null, { status })
          : new Response(typeof body === 'string' ? body : JSON.stringify(body), {
              status,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    );
  }

  beforeEach(() => {
    vi.mocked(invalidateSession).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the token and returns the joined collection', async () => {
    for (const result of ['joined', 'already', 'own'] as const) {
      respond(200, { collectionId: 'c1', result });
      expect(await joinPublicCollection('tok')).toEqual({ kind: 'ok', collectionId: 'c1', result });
    }
    const [path, init] = vi.mocked(fetch).mock.calls[0];
    expect(path).toBe('/api/public/join');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ token: 'tok' }) });
  });

  it('is a generic error when the request never reaches the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await joinPublicCollection('tok')).toEqual({ kind: 'error', message: t('public.joinFailed') });
  });

  it('signs out on 401 and 403', async () => {
    for (const status of [401, 403]) {
      respond(status, { error: 'Unauthorized' });
      expect(await joinPublicCollection('tok')).toEqual({ kind: 'signedOut' });
    }
    expect(invalidateSession).toHaveBeenCalledTimes(2);
  });

  it('is missing on 404 and full on 409, whatever the server says', async () => {
    respond(404, { error: 'Not found' });
    expect(await joinPublicCollection('tok')).toEqual({ kind: 'missing' });
    respond(409, { code: 'share-full', error: 'This collection is shared with 20 people.' });
    expect(await joinPublicCollection('tok')).toEqual({ kind: 'error', message: t('public.joinFull') });
    expect(invalidateSession).not.toHaveBeenCalled();
  });

  it('shows the server sentence for another failure, or the generic one', async () => {
    respond(503, { error: 'Membership unavailable' });
    expect(await joinPublicCollection('tok')).toEqual({ kind: 'error', message: 'Membership unavailable' });
    respond(500, 'not json');
    expect(await joinPublicCollection('tok')).toEqual({ kind: 'error', message: t('public.joinFailed') });
  });

  it('rejects a 200 whose body it does not understand', async () => {
    const bodies = [
      {},
      { collectionId: 'c1' },
      { collectionId: 1, result: 'joined' },
      { collectionId: 'c1', result: 'maybe' },
      'not json',
    ];
    for (const body of bodies) {
      respond(200, body);
      expect(await joinPublicCollection('tok'), JSON.stringify(body)).toEqual({
        kind: 'error',
        message: t('public.joinFailed'),
      });
    }
  });
});

describe('parsePublicLink', () => {
  it('reads a collection body with or without its kind', () => {
    const body = { collection: { id: 'c1', name: 'Soups' }, recipes: [recipe] };
    expect(parsePublicLink(body)).toEqual({ kind: 'collection', ...body });
    expect(parsePublicLink({ kind: 'collection', ...body })).toEqual({ kind: 'collection', ...body });
  });

  it('reads a recipe link, with the sharer when named', () => {
    expect(parsePublicLink({ kind: 'recipe', recipe, sharedBy: ' Ada ' })).toEqual({
      kind: 'recipe',
      recipe,
      sharedBy: 'Ada',
    });
    expect(parsePublicLink({ kind: 'recipe', recipe, sharedBy: 4 })).toEqual({
      kind: 'recipe',
      recipe,
    });
    expect(parsePublicLink({ kind: 'recipe', recipe: { title: 'x' } })).toBeNull();
    expect(parsePublicLink(null)).toBeNull();
  });
});

describe('fetchPublicLink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps 404 to missing, other failures to error, and parses a body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect(await fetchPublicLink('tok')).toEqual({ kind: 'missing' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    expect(await fetchPublicLink('tok')).toEqual({ kind: 'error' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ kind: 'recipe', recipe }), { status: 200 })),
    );
    expect(await fetchPublicLink('tok')).toEqual({ kind: 'ok', data: { kind: 'recipe', recipe } });
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  });
});

describe('savePublicRecipe', () => {
  function respond(status: number, body?: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        body === undefined
          ? new Response(null, { status })
          : new Response(JSON.stringify(body), {
              status,
              headers: { 'Content-Type': 'application/json' },
            }),
      ),
    );
  }

  beforeEach(() => {
    vi.mocked(invalidateSession).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the token and returns the copy', async () => {
    for (const result of ['saved', 'already', 'own'] as const) {
      respond(200, { recipeId: 'r9', result });
      expect(await savePublicRecipe('tok')).toEqual({ kind: 'ok', recipeId: 'r9', result });
    }
    const [path, init] = vi.mocked(fetch).mock.calls[0];
    expect(path).toBe('/api/public/save');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ token: 'tok' }) });
  });

  it('maps sign-out, a dead link, the rate limit, and a bad body', async () => {
    respond(401, { error: 'Unauthorized' });
    expect(await savePublicRecipe('tok')).toEqual({ kind: 'signedOut' });
    expect(invalidateSession).toHaveBeenCalledTimes(1);
    respond(404, { error: 'Not found' });
    expect(await savePublicRecipe('tok')).toEqual({ kind: 'missing' });
    respond(429, { error: 'Too many saves', code: 'recipe-save-rate-limited' });
    expect(await savePublicRecipe('tok')).toEqual({
      kind: 'error',
      message: t('public.saveRateLimited'),
    });
    respond(200, { recipeId: 'r9', result: 'joined' });
    expect(await savePublicRecipe('tok')).toEqual({ kind: 'error', message: t('public.saveFailed') });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await savePublicRecipe('tok')).toEqual({ kind: 'error', message: t('public.saveFailed') });
  });
});
