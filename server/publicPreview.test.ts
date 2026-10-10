import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashPublicToken, type PublicLinkRecord } from './publicLinks.ts';
import {
  injectPreview,
  previewHeadTags,
  previewHtml,
  previewPath,
  previewText,
  resolvePreview,
  type PreviewDependencies,
} from './publicPreview.ts';
import type { RecipeLinkRecord } from './recipeLinks.ts';

const ORIGIN = 'https://sous.example';
const COLLECTION_TOKEN = 'c'.repeat(32);
const RECIPE_TOKEN = 'r'.repeat(32);
const OWNER = 'owner-sub';
const COLLECTION_ID = '11111111-1111-4111-8111-111111111111';
const LISTED = '22222222-2222-4222-8222-222222222222';
const UNLISTED = '33333333-3333-4333-8333-333333333333';
const LINKED = '44444444-4444-4444-8444-444444444444';
const PHOTO = '55555555-5555-4555-8555-555555555555';

const SHELL = '<!doctype html>\n<html>\n  <head>\n    <title>Sous</title>\n  </head>\n  <body></body>\n</html>\n';

function recipe(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    createdAt: 1,
    updatedAt: 2,
    title: `Recipe ${id.slice(0, 4)}`,
    servings: 2,
    ingredientSections: [],
    steps: [],
    tags: [],
    ...extra,
  };
}

type World = {
  publicLink: PublicLinkRecord | null;
  recipeLink: RecipeLinkRecord | null;
  admitted: boolean;
  collection: Record<string, unknown> | undefined;
  /** Keyed by recipe id; every one is the owner's. */
  recipes: Record<string, Record<string, unknown>>;
  /** Recipes under some other account, keyed by `${sub}/${id}`. */
  foreign: Record<string, Record<string, unknown>>;
};

function world(overrides: Partial<World> = {}): World {
  return {
    publicLink: {
      ownerSub: OWNER,
      ownerEmail: 'owner@example.com',
      collectionId: COLLECTION_ID,
      token: COLLECTION_TOKEN,
      status: 'live',
      createdAt: 1,
    },
    recipeLink: {
      ownerSub: OWNER,
      ownerEmail: 'owner@example.com',
      ownerName: 'Owner Name',
      recipeId: LINKED,
      token: RECIPE_TOKEN,
      status: 'live',
      createdAt: 1,
    },
    admitted: true,
    collection: { id: COLLECTION_ID, name: 'Weeknights', recipeIds: [LISTED] },
    recipes: {
      [LISTED]: recipe(LISTED, { title: 'Listed soup', photoId: PHOTO }),
      [UNLISTED]: recipe(UNLISTED),
      [LINKED]: recipe(LINKED, { title: 'Overnight oats', description: 'Oats, soaked.' }),
    },
    foreign: {},
    ...overrides,
  };
}

function readAs(w: World, owner: string, id: string): Record<string, unknown> | undefined {
  return owner === OWNER ? w.recipes[id] : w.foreign[`${owner}/${id}`];
}

function deps(w: World): PreviewDependencies {
  return {
    readLink: async (id) =>
      w.publicLink !== null && id === hashPublicToken(w.publicLink.token) ? w.publicLink : null,
    readRecipeLink: async (id) =>
      w.recipeLink !== null && id === hashPublicToken(w.recipeLink.token) ? w.recipeLink : null,
    ownerAdmitted: async () => w.admitted,
    readCollection: async () => w.collection,
    readRecipes: async (owner, ids) => ids.map((id) => readAs(w, owner, id)),
    readRecipe: async (owner, id) => readAs(w, owner, id),
  };
}

describe('previewPath', () => {
  it('accepts a token page and a recipe page in a collection', () => {
    expect(previewPath(`/p/${COLLECTION_TOKEN}`)).toEqual({ token: COLLECTION_TOKEN });
    expect(previewPath(`/p/${COLLECTION_TOKEN}/r/${LISTED}`)).toEqual({
      token: COLLECTION_TOKEN,
      recipeId: LISTED,
    });
  });

  it('allows one trailing slash', () => {
    expect(previewPath(`/p/${COLLECTION_TOKEN}/`)).toEqual({ token: COLLECTION_TOKEN });
    expect(previewPath(`/p/${COLLECTION_TOKEN}/r/${LISTED}/`)).toEqual({
      token: COLLECTION_TOKEN,
      recipeId: LISTED,
    });
  });

  it('refuses an escaped path, which the SPA routes as a different page', () => {
    expect(previewPath(`/p/${COLLECTION_TOKEN}%2Fr%2F${LISTED}`)).toBeNull();
    expect(previewPath(`/p/${COLLECTION_TOKEN}%2F`)).toBeNull();
    expect(previewPath(`/p/${COLLECTION_TOKEN.slice(1)}%63`)).toBeNull();
  });

  it('refuses every other shape', () => {
    for (const path of [
      '/p',
      '/p/',
      '/p/short',
      `/p/${COLLECTION_TOKEN}//`,
      `/p/${COLLECTION_TOKEN}/r/not-a-uuid`,
      `/p/${COLLECTION_TOKEN}/r/${LISTED}/x`,
      `/p/${COLLECTION_TOKEN}/x/${LISTED}`,
      `/q/${COLLECTION_TOKEN}`,
    ]) {
      expect(previewPath(path), path).toBeNull();
    }
  });
});

describe('previewText', () => {
  it('flattens whitespace and control characters', () => {
    expect(previewText('  a\n\tb\u0000c\u0085d  ', 50)).toBe('a b c d');
  });

  it('cuts by character as people see it, never inside one', () => {
    const pasta = '\u{1f35d}';
    expect(previewText(pasta.repeat(4), 3)).toBe(`${pasta.repeat(2)}\u2026`);
    expect(previewText('abc', 3)).toBe('abc');
    expect(previewText('ab cd', 4)).toBe('ab\u2026');
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
    expect(previewText(family.repeat(3), 3)).toBe(family.repeat(3));
    expect(previewText(family.repeat(4), 3)).toBe(`${family.repeat(2)}\u2026`);
    const accented = 'e\u0301';
    expect(previewText(accented.repeat(4), 3)).toBe(`${accented.repeat(2)}\u2026`);
    const flag = '\u{1f1fa}\u{1f1e6}';
    expect(previewText(flag.repeat(3), 2)).toBe(`${flag}\u2026`);
  });

  it('never reads past a bounded prefix', () => {
    // max 10 reads 80 code units, so the tail is never seen; the text is
    // still marked as cut, since the source went on.
    expect(previewText(`Soup${' '.repeat(2_000)}tail`, 10)).toBe('Soup\u2026');
    const huge = 'soup '.repeat(200_000);
    expect(previewText(huge, 200)).toBe(`${'soup '.repeat(40).slice(0, 199).trimEnd()}\u2026`);
  });

  it('clips the prefix on a grapheme boundary', () => {
    // A four-person family is 11 code units: max 120 reads 960, which is 87
    // whole families; the 88th would cross the limit and is left out whole.
    const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}';
    expect(previewText(family.repeat(100), 120)).toBe(`${family.repeat(87)}\u2026`);
    // A letter with 20 marks is 21 code units: max 5 reads 40, one letter.
    const heavy = `e${'\u0301'.repeat(20)}`;
    expect(previewText(heavy.repeat(5), 5)).toBe(`${heavy}\u2026`);
    // 22 spaces and 'a' fill 23 of 24 units; the pasta emoji would cross.
    const cut = previewText(`${' '.repeat(22)}a\u{1f35d}${' '.repeat(100)}`, 3);
    expect(cut).toBe('a\u2026');
    expect(cut).not.toMatch(/[\ud800-\udbff]/);
  });

  it('gives no text, not a lone ellipsis, when only padding was read', () => {
    expect(previewText(`${' '.repeat(2_000)}Borscht`, 120)).toBe('');
    expect(previewText(`${'\u200e'.repeat(2_000)}Borscht`, 120)).toBe('');
  });

  it('drops bidi controls', () => {
    expect(previewText('a\u202eb\u2066c\u2069\u200fd\u061c', 50)).toBe('abcd');
  });

  it('treats a non-string as empty', () => {
    expect(previewText(undefined, 10)).toBe('');
    expect(previewText(42, 10)).toBe('');
  });
});

describe('resolvePreview', () => {
  it('names a public collection, without a description or image', async () => {
    expect(await resolvePreview({ token: COLLECTION_TOKEN }, ORIGIN, deps(world()))).toEqual({
      title: 'Weeknights',
    });
  });

  it('describes a listed recipe in a public collection, with its main photo', async () => {
    expect(
      await resolvePreview({ token: COLLECTION_TOKEN, recipeId: LISTED }, ORIGIN, deps(world())),
    ).toEqual({
      title: 'Listed soup',
      imageUrl: `${ORIGIN}/api/public/${COLLECTION_TOKEN}/recipes/${LISTED}/photos/${PHOTO}`,
    });
  });

  it("reads the recipe from the link owner's library only", async () => {
    const w = world();
    w.publicLink = { ...w.publicLink!, ownerSub: 'other-sub' };
    w.recipeLink = { ...w.recipeLink!, ownerSub: 'other-sub' };
    expect(await resolvePreview({ token: COLLECTION_TOKEN, recipeId: LISTED }, ORIGIN, deps(w))).toBeNull();
    expect(await resolvePreview({ token: RECIPE_TOKEN }, ORIGIN, deps(w))).toBeNull();
    w.foreign[`other-sub/${LINKED}`] = recipe(LINKED, { title: 'Their oats' });
    expect(await resolvePreview({ token: RECIPE_TOKEN }, ORIGIN, deps(w))).toEqual({ title: 'Their oats' });
  });

  it('refuses a recipe that is not listed, or deleted', async () => {
    const w = world();
    expect(await resolvePreview({ token: COLLECTION_TOKEN, recipeId: UNLISTED }, ORIGIN, deps(w))).toBeNull();
    w.recipes[LISTED] = recipe(LISTED, { deletedAt: 5 });
    expect(await resolvePreview({ token: COLLECTION_TOKEN, recipeId: LISTED }, ORIGIN, deps(w))).toBeNull();
  });

  it('describes a recipe link, never with the sharer', async () => {
    const meta = await resolvePreview({ token: RECIPE_TOKEN }, ORIGIN, deps(world()));
    expect(meta).toEqual({ title: 'Overnight oats', description: 'Oats, soaked.' });
    expect(previewHeadTags(meta!)).not.toContain('Owner Name');
  });

  it('gives a recipe link no /r/ page', async () => {
    expect(await resolvePreview({ token: RECIPE_TOKEN, recipeId: LINKED }, ORIGIN, deps(world()))).toBeNull();
  });

  it('tries the collection link before the recipe link', async () => {
    const w = world();
    w.recipeLink = { ...w.recipeLink!, token: COLLECTION_TOKEN };
    expect(await resolvePreview({ token: COLLECTION_TOKEN }, ORIGIN, deps(w))).toEqual({
      title: 'Weeknights',
    });
  });

  it('refuses a revoked link, an unadmitted owner, and a deleted collection', async () => {
    const revoked = world();
    revoked.publicLink = { ...revoked.publicLink!, status: 'revoked', revokedAt: 3 };
    revoked.recipeLink = { ...revoked.recipeLink!, status: 'revoked', revokedAt: 3 };
    expect(await resolvePreview({ token: COLLECTION_TOKEN }, ORIGIN, deps(revoked))).toBeNull();
    expect(await resolvePreview({ token: RECIPE_TOKEN }, ORIGIN, deps(revoked))).toBeNull();

    const unadmitted = world({ admitted: false });
    expect(await resolvePreview({ token: COLLECTION_TOKEN }, ORIGIN, deps(unadmitted))).toBeNull();
    expect(await resolvePreview({ token: RECIPE_TOKEN }, ORIGIN, deps(unadmitted))).toBeNull();

    const deleted = world({ collection: { id: COLLECTION_ID, name: 'Weeknights', deletedAt: 4 } });
    deleted.recipeLink = null;
    expect(await resolvePreview({ token: COLLECTION_TOKEN }, ORIGIN, deps(deleted))).toBeNull();
  });

  it('gives no tags to a blank title', async () => {
    const w = world({ collection: { id: COLLECTION_ID, name: '  ', recipeIds: [] } });
    expect(await resolvePreview({ token: COLLECTION_TOKEN }, ORIGIN, deps(w))).toBeNull();
    w.recipes[LINKED] = recipe(LINKED, { title: '\n' });
    expect(await resolvePreview({ token: RECIPE_TOKEN }, ORIGIN, deps(w))).toBeNull();
  });

  it('throws when membership is unknown', async () => {
    const d = deps(world());
    d.ownerAdmitted = async () => {
      throw new Error('membership unknown');
    };
    await expect(resolvePreview({ token: COLLECTION_TOKEN }, ORIGIN, d)).rejects.toThrow();
  });
});

describe('previewHeadTags', () => {
  it('escapes the text for an attribute', () => {
    const tags = previewHeadTags({ title: `"><script>alert('x')</script>&` });
    expect(tags).toContain(
      '<meta property="og:title" content="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;" />',
    );
    expect(tags).not.toContain('<script>');
  });

  it('uses a large card only with an image', () => {
    expect(previewHeadTags({ title: 'A' })).toContain('<meta name="twitter:card" content="summary" />');
    const withImage = previewHeadTags({ title: 'A', description: 'B', imageUrl: `${ORIGIN}/x` });
    expect(withImage).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(withImage).toContain('<meta property="og:description" content="B" />');
    expect(withImage).toContain(`<meta property="og:image" content="${ORIGIN}/x" />`);
    expect(withImage).toContain('<meta property="og:site_name" content="Sous" />');
  });
});

describe('injectPreview', () => {
  it('puts the tags before the one </head> and leaves the rest alone', () => {
    const html = injectPreview(SHELL, { title: 'Soup' })!;
    expect(html).toBe(
      SHELL.replace('  </head>', `    ${previewHeadTags({ title: 'Soup' })}\n  </head>`),
    );
  });

  it('starts the tags on their own line when the build put a tag before </head>', () => {
    const html = injectPreview('<head>\n    <title>Sous</title>\n  <link rel="manifest">  </head>', { title: 'Soup' })!;
    expect(html).toBe(
      `<head>\n    <title>Sous</title>\n  <link rel="manifest">\n    ${previewHeadTags({ title: 'Soup' })}\n  </head>`,
    );
  });

  it('refuses a shell with no </head> or two', () => {
    expect(injectPreview('<html><body></body></html>', { title: 'A' })).toBeNull();
    expect(injectPreview('<head></head><head></head>', { title: 'A' })).toBeNull();
  });
});

describe('previewHtml', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const readIndex = async () => SHELL;
  const origin = () => ORIGIN;

  it('serves the shell with tags for a live link', async () => {
    const html = await previewHtml(`/p/${RECIPE_TOKEN}`, { readIndex, origin, deps: deps(world()) });
    expect(html).toContain('<meta property="og:title" content="Overnight oats" />');
  });

  it('answers null for a bad path or a dead link, without reading the shell', async () => {
    const read = vi.fn(readIndex);
    expect(await previewHtml('/p/short', { readIndex: read, origin, deps: deps(world()) })).toBeNull();
    const dead = world({ publicLink: null, recipeLink: null });
    expect(await previewHtml(`/p/${RECIPE_TOKEN}`, { readIndex: read, origin, deps: deps(dead) })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('logs only the error class on a store failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d = deps(world());
    d.readLink = async () => {
      throw new TypeError(`secret ${COLLECTION_TOKEN}`);
    };
    expect(await previewHtml(`/p/${COLLECTION_TOKEN}`, { readIndex, origin, deps: d })).toBeNull();
    expect(log).toHaveBeenCalledWith('publicPreview error:', 'TypeError');
    expect(JSON.stringify(log.mock.calls)).not.toContain(COLLECTION_TOKEN);
  });

  it('answers null when the origin is not configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const noOrigin = () => {
      throw new Error('PUBLIC_ORIGIN');
    };
    expect(await previewHtml(`/p/${RECIPE_TOKEN}`, { readIndex, origin: noOrigin, deps: deps(world()) })).toBeNull();
  });

  it('serves the plain shell without a lookup while too many are still running', async () => {
    const releases: Array<() => void> = [];
    const slow = deps(world());
    const readLink = slow.readLink;
    slow.readLink = (id) =>
      new Promise((resolve) => releases.push(() => resolve(readLink(id))));
    const options = { readIndex, origin, deps: slow, timeoutMs: 10, maxInFlight: 2 };
    expect(await previewHtml(`/p/${COLLECTION_TOKEN}`, options)).toBeNull();
    expect(await previewHtml(`/p/${COLLECTION_TOKEN}`, options)).toBeNull();
    expect(releases).toHaveLength(2);

    // Both abandoned lookups still hold their slots.
    expect(await previewHtml(`/p/${COLLECTION_TOKEN}`, options)).toBeNull();
    expect(releases).toHaveLength(2);

    for (const release of releases) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A cap of 1 passes only if every slot was given back.
    const fast = { readIndex, origin, deps: deps(world()), maxInFlight: 1 };
    expect(await previewHtml(`/p/${COLLECTION_TOKEN}`, fast)).toContain('content="Weeknights"');
  });

  it('gives up on a slow lookup, and a late failure is not unhandled', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail: (err: Error) => void = () => undefined;
    const d = deps(world());
    d.readLink = () => new Promise((_, reject) => (fail = reject));
    const started = Date.now();
    expect(await previewHtml(`/p/${COLLECTION_TOKEN}`, { readIndex, origin, deps: d, timeoutMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    fail(new Error('late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log).not.toHaveBeenCalled();
  });
});
