import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequireMemberResult } from './membership.ts';
import { hashPublicToken } from './publicLinks.ts';
import {
  admitRecipeLinkSave,
  handleRecipeLinkSavePost,
  MAX_RECIPE_LINK_SAVES_PER_HOUR,
  planRecipeCopy,
  recipeCopyId,
  resetRecipeLinkSaveRateLimit,
  saveFromRecipeLink,
  withCopiedPhotos,
  type PhotoCopy,
  type RecipeCopyPlan,
  type RecipeLinkSaveHttpDependencies,
} from './recipeLinkSave.ts';
import type { LiveRecipeLink, RecipeLinkRecord } from './recipeLinks.ts';
import { isUuid } from './uuid.ts';

const token = 'S'.repeat(43);
const recipeId = '22222222-2222-4222-8222-222222222222';
const cover = '55555555-5555-4555-8555-555555555555';
const extra = '66666666-6666-4666-8666-666666666666';
const now = 1_700_000_000_000;

const original: Record<string, unknown> = {
  id: recipeId,
  title: 'Soup',
  servings: 2,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
  notes: 'Salt late.',
  lang: 'it',
  photoId: cover,
  galleryPhotoIds: [extra],
  importCheck: { at: 1, warnings: [] },
  variantOf: '99999999-9999-4999-8999-999999999999',
  savedFrom: { name: 'Eve', savedAt: 1 },
  createdAt: 1,
  updatedAt: 2,
  serverUpdatedAt: 3,
};

function link(overrides: Partial<RecipeLinkRecord> = {}): RecipeLinkRecord {
  return {
    ownerSub: 'owner',
    ownerEmail: 'owner@example.com',
    ownerName: 'Ada',
    recipeId,
    token,
    status: 'live',
    createdAt: 10,
    ...overrides,
  };
}

function idSource() {
  let n = 0;
  return () => {
    n += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
  };
}

type WritePlan = Extract<RecipeCopyPlan, { kind: 'write' }>;

function writePlan(plan: RecipeCopyPlan): WritePlan {
  if (plan.kind !== 'write') throw new Error(`expected a write plan, got ${plan.kind}`);
  return plan;
}

describe('recipeCopyId', () => {
  it('is a stable uuid per saver and link', () => {
    const id = recipeCopyId('saver', 'link');
    expect(isUuid(id)).toBe(true);
    expect(recipeCopyId('saver', 'link')).toBe(id);
    expect(recipeCopyId('other', 'link')).not.toBe(id);
    expect(recipeCopyId('saver', 'link2')).not.toBe(id);
  });
});

describe('planRecipeCopy', () => {
  const copyId = recipeCopyId('saver', 'link');
  const base = {
    recipeId: copyId,
    original,
    ownerName: 'Ada' as string | undefined,
    stored: undefined as Record<string, unknown> | undefined,
    now,
  };

  it('copies the visitor fields onto the copy id, plans new photo ids, and attaches none yet', () => {
    const plan = writePlan(planRecipeCopy({ ...base, newPhotoId: idSource() }));
    expect(plan.updatedAt).toBe(now);
    expect(plan.payload).toMatchObject({
      id: copyId,
      title: 'Soup',
      notes: 'Salt late.',
      lang: 'it',
      createdAt: now,
      updatedAt: now,
      savedFrom: { name: 'Ada', savedAt: now },
    });
    expect(plan.payload).not.toHaveProperty('importCheck');
    expect(plan.payload).not.toHaveProperty('variantOf');
    expect(plan.payload).not.toHaveProperty('serverUpdatedAt');
    expect(plan.photos.map((p) => [p.srcPhotoId, p.cover])).toEqual([
      [cover, true],
      [extra, false],
    ]);
    expect(new Set(plan.photos.map((p) => p.dstPhotoId)).size).toBe(2);
    // A photo is attached only once it has copied (withCopiedPhotos).
    expect(plan.payload).not.toHaveProperty('photoId');
    expect(plan.payload).not.toHaveProperty('galleryPhotoIds');
  });

  it('is already when the copy is live', () => {
    expect(
      planRecipeCopy({ ...base, stored: { id: copyId, updatedAt: 5 }, newPhotoId: idSource() }),
    ).toEqual({ kind: 'already', recipeId: copyId });
  });

  it('writes past a tombstone the saver left', () => {
    const plan = writePlan(
      planRecipeCopy({
        ...base,
        ownerName: undefined,
        stored: { id: copyId, updatedAt: now + 50, deletedAt: now + 50 },
        newPhotoId: idSource(),
      }),
    );
    expect(plan.updatedAt).toBe(now + 51);
    expect(plan.payload.savedFrom).toEqual({ savedAt: now });
  });

  it('copies a photo once when the gallery repeats it, and none when there are none', () => {
    const plan = writePlan(
      planRecipeCopy({
        ...base,
        original: { ...original, galleryPhotoIds: [cover, extra, extra, 'junk'] },
        newPhotoId: idSource(),
      }),
    );
    expect(plan.photos.map((p) => p.srcPhotoId)).toEqual([cover, extra]);
    const bare = writePlan(
      planRecipeCopy({
        ...base,
        original: { ...original, photoId: undefined, galleryPhotoIds: undefined },
        newPhotoId: idSource(),
      }),
    );
    expect(bare.photos).toEqual([]);
    expect(bare.payload).not.toHaveProperty('photoId');
    expect(bare.payload).not.toHaveProperty('galleryPhotoIds');
  });
});

describe('withCopiedPhotos', () => {
  const coverCopy: PhotoCopy = { srcPhotoId: cover, dstPhotoId: 'c1', cover: true };
  const extraCopy: PhotoCopy = { srcPhotoId: extra, dstPhotoId: 'g1', cover: false };

  it('attaches the copied cover and gallery', () => {
    expect(withCopiedPhotos({ title: 'Soup' }, [coverCopy, extraCopy])).toEqual({
      title: 'Soup',
      photoId: 'c1',
      galleryPhotoIds: ['g1'],
    });
  });

  it('attaches only what copied', () => {
    expect(withCopiedPhotos({ title: 'Soup' }, [extraCopy])).toEqual({
      title: 'Soup',
      galleryPhotoIds: ['g1'],
    });
    expect(withCopiedPhotos({ title: 'Soup' }, [])).toEqual({ title: 'Soup' });
  });

  it("keeps a cover and gallery the saver set meanwhile, and never repeats an id", () => {
    expect(
      withCopiedPhotos({ photoId: 'mine', galleryPhotoIds: ['g0', 'g1'] }, [coverCopy, extraCopy]),
    ).toEqual({ photoId: 'mine', galleryPhotoIds: ['g0', 'g1', 'c1'] });
  });
});

const member: RequireMemberResult = {
  kind: 'ok',
  sub: 'saver',
  email: 'saver@example.com',
  isOwner: false,
};

function saveDeps(overrides: Partial<RecipeLinkSaveHttpDependencies> = {}) {
  const writeCopy = vi.fn(
    async (saverSub: string, _live: LiveRecipeLink, at: number): Promise<RecipeCopyPlan> =>
      planRecipeCopy({
        recipeId: recipeCopyId(saverSub, hashPublicToken(token)),
        original,
        ownerName: 'Ada',
        stored: undefined,
        now: at,
        newPhotoId: idSource(),
      }),
  );
  const copyPhoto = vi.fn(
    async (_input: { srcUid: string; srcPhotoId: string; dstUid: string }) => true,
  );
  const attachPhotos = vi.fn(
    async (_sub: string, _id: string, _version: number, _copied: readonly PhotoCopy[]) => {},
  );
  const deps: RecipeLinkSaveHttpDependencies = {
    readRecipeLink: async (id) => (id === hashPublicToken(token) ? link() : null),
    ownerAdmitted: async () => true,
    readRecipe: async () => original,
    writeCopy,
    copyPhoto,
    attachPhotos,
    requireMember: async () => member,
    now: () => now,
    ...overrides,
  };
  return { deps, writeCopy, copyPhoto, attachPhotos };
}

describe('saveFromRecipeLink', () => {
  it('saves, copies every photo from the owner tree, then attaches them', async () => {
    const { deps, copyPhoto, attachPhotos } = saveDeps();
    const outcome = await saveFromRecipeLink('saver', token, now, deps);
    expect(outcome).toMatchObject({ kind: 'ok', result: 'saved', photos: 2, photosCopied: 2 });
    expect(copyPhoto).toHaveBeenCalledTimes(2);
    expect(copyPhoto.mock.calls[0][0]).toMatchObject({
      srcUid: 'owner',
      srcPhotoId: cover,
      dstUid: 'saver',
    });
    expect(attachPhotos).toHaveBeenCalledTimes(1);
    const [sub, , version, copied] = attachPhotos.mock.calls[0];
    expect(sub).toBe('saver');
    expect(version).toBe(now);
    expect(copied.map((p) => p.srcPhotoId)).toEqual([cover, extra]);
  });

  it('attaches only the photos that copied, and nothing when none did', async () => {
    const attachPhotos = vi.fn(
      async (_sub: string, _id: string, _version: number, _copied: readonly PhotoCopy[]) => {},
    );
    const { deps } = saveDeps({
      copyPhoto: async (input) => input.srcPhotoId !== extra,
      attachPhotos,
    });
    const outcome = await saveFromRecipeLink('saver', token, now, deps);
    expect(outcome).toMatchObject({ result: 'saved', photos: 2, photosCopied: 1 });
    expect(attachPhotos.mock.calls[0][3].map((p) => p.srcPhotoId)).toEqual([cover]);

    const none = saveDeps({ copyPhoto: async () => false });
    expect(await saveFromRecipeLink('saver', token, now, none.deps)).toMatchObject({
      photosCopied: 0,
    });
    expect(none.attachPhotos).not.toHaveBeenCalled();
  });

  it("is own for the owner's own link and writes nothing", async () => {
    const { deps, writeCopy } = saveDeps();
    expect(await saveFromRecipeLink('owner', token, now, deps)).toMatchObject({
      result: 'own',
      recipeId,
    });
    expect(writeCopy).not.toHaveBeenCalled();
  });

  it('is already when the copy exists and copies no photos', async () => {
    const { deps, copyPhoto } = saveDeps({
      writeCopy: async () => ({ kind: 'already', recipeId: 'copy' }),
    });
    expect(await saveFromRecipeLink('saver', token, now, deps)).toMatchObject({
      result: 'already',
      recipeId: 'copy',
    });
    expect(copyPhoto).not.toHaveBeenCalled();
  });

  it('is dead for a dead link', async () => {
    const { deps } = saveDeps({ readRecipeLink: async () => null });
    expect(await saveFromRecipeLink('saver', token, now, deps)).toEqual({ kind: 'dead' });
  });
});

describe('handleRecipeLinkSavePost', () => {
  afterEach(() => {
    resetRecipeLinkSaveRateLimit();
    vi.restoreAllMocks();
  });

  function post(body: unknown): Request {
    return new Request('https://sous.example/api/public/save', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('answers 200 with the copy id and logs no token or name', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await handleRecipeLinkSavePost(post({ token }), saveDeps().deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recipeId: string; result: string };
    expect(body.result).toBe('saved');
    expect(isUuid(body.recipeId)).toBe(true);
    const line = log.mock.calls.flat().join(' ');
    expect(line).toContain('"event":"recipe_link_save"');
    expect(line).toContain('"photosCopied":2');
    expect(line).not.toContain(token);
    expect(line).not.toContain('Ada');
  });

  it('refuses a signed-out or unknown session', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const denied = await handleRecipeLinkSavePost(
      post({ token }),
      saveDeps({ requireMember: async () => ({ kind: 'denied' }) }).deps,
    );
    expect(denied.status).toBe(401);
    const unknown = await handleRecipeLinkSavePost(
      post({ token }),
      saveDeps({ requireMember: async () => ({ kind: 'unknown' }) }).deps,
    );
    expect(unknown.status).toBe(503);
  });

  it('answers 400 for a bad body and 404 for a dead link', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const body of ['nope', { token: 'short' }, [], '{}']) {
      const res = await handleRecipeLinkSavePost(post(body), saveDeps().deps);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const dead = await handleRecipeLinkSavePost(
      post({ token }),
      saveDeps({ readRecipeLink: async () => null }).deps,
    );
    expect(dead.status).toBe(404);
  });

  it('answers 503 on a store error without logging the message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleRecipeLinkSavePost(
      post({ token }),
      saveDeps({
        readRecipeLink: async () => {
          throw new Error(`boom ${token}`);
        },
      }).deps,
    );
    expect(res.status).toBe(503);
    expect(error.mock.calls.flat().join(' ')).not.toContain(token);
  });

  it('rate-limits saves per member', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps } = saveDeps();
    for (let i = 0; i < MAX_RECIPE_LINK_SAVES_PER_HOUR; i += 1) {
      expect((await handleRecipeLinkSavePost(post({ token }), deps)).status).toBe(200);
    }
    const res = await handleRecipeLinkSavePost(post({ token }), deps);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe('recipe-save-rate-limited');
  });
});

describe('admitRecipeLinkSave', () => {
  it('admits again once the window has passed', () => {
    const buckets = new Map<string, number[]>();
    expect(admitRecipeLinkSave(buckets, 's', 0, 1, 10)).toBe(true);
    expect(admitRecipeLinkSave(buckets, 's', 5, 1, 10)).toBe(false);
    expect(admitRecipeLinkSave(buckets, 's', 10, 1, 10)).toBe(true);
  });
});
