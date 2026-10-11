import {
  isPublicTokenShape,
  listedRecipeIds,
  publicRecipeBody,
  resolveLiveChain,
  type PublicReadDependencies,
} from './publicLinks.ts';
import { resolveRecipeLink, type RecipeLinkReadDependencies } from './recipeLinks.ts';
import { isLiveDoc, isUuid } from './store.ts';

/**
 * Link previews for public pages: `/p/<token>` and `/p/<token>/r/<recipeId>`
 * are the SPA shell, which a link-preview crawler sees as just "Sous". The
 * dispatcher (`scripts/server.ts`) asks here for Open Graph tags and puts
 * them in the shell's head; the body and the served `<title>` ("Sous") are
 * unchanged. A browser running the app then retitles the tab "<name> · Sous"
 * on its own (`docs/plans/screen-titles.md`); a crawler that runs no script
 * sees only the shell's "Sous" and these tags.
 *
 * The link is resolved with the visitor API's chain, in its order
 * (collection link first, then recipe link), and nothing is cached. Tags hold
 * the recipe's title, description, and main photo, or a collection's name;
 * never the sharer's name, an email, a `sub`, or the page URL. Every failure
 * serves the plain shell, so a preview can never break the page.
 *
 * The token is in the path: never log the path, the token, or the text.
 */

/**
 * Every visit to a `/p` page waits on this lookup before its first byte (the
 * service worker never serves `/p`), so keep it short: a crawler that misses
 * it just gets no tags.
 */
export const PREVIEW_LOOKUP_TIMEOUT_MS = 500;
/**
 * Lookups still running on this instance, including ones a request already
 * gave up on. Past the cap a page gets the plain shell without a lookup, so a
 * slow store or a burst of `/p` requests cannot pile up unauthenticated reads.
 * A lookup that never settled would hold its slot for good; the Firestore
 * client's per-call deadlines are what end a stuck read.
 */
export const MAX_PREVIEW_LOOKUPS_IN_FLIGHT = 20;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 200;

export type PreviewPath = { token: string; recipeId?: string };

export type PreviewMeta = { title: string; description?: string; imageUrl?: string };

export type PreviewDependencies = PublicReadDependencies & RecipeLinkReadDependencies;

/**
 * `/p/<token>` or `/p/<token>/r/<recipeId>`, with one trailing slash allowed;
 * null for any other shape. Takes the path as sent, not decoded: the SPA
 * decodes each segment but keeps an encoded slash inside one, so
 * `/p/<token>%2Fr%2F<id>` is a (dead) token page there, not a recipe page. A
 * token and a recipe id never need escaping, so any `%` is refused here; a
 * link that escapes plain characters still opens, just without a preview.
 */
export function previewPath(pathname: string): PreviewPath | null {
  const parts = (pathname.endsWith('/') ? pathname.slice(0, -1) : pathname).split('/');
  // ['', 'p', token] or ['', 'p', token, 'r', recipeId]
  if (parts[0] !== '' || parts[1] !== 'p' || !isPublicTokenShape(parts[2])) {
    return null;
  }
  if (parts.length === 3) {
    return { token: parts[2] };
  }
  if (parts.length === 5 && parts[3] === 'r' && isUuid(parts[4])) {
    return { token: parts[2], recipeId: parts[4] };
  }
  return null;
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Code units read per grapheme kept; far more than any real text needs. */
const SOURCE_UNITS_PER_GRAPHEME = 8;

/** Code units past the limit read to find the last grapheme boundary before it. */
const CLIP_LOOKAHEAD = 32;

/** Bidi controls: ALM, LRM, RLM, LRE-RLO, LRI-PDI. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * One line of plain text, at most `max` characters as people see them
 * (graphemes, so an emoji sequence or an accented letter is never split),
 * `…` when cut. Bidi controls are dropped so recipe text cannot reorder the
 * preview around it.
 *
 * Only a bounded prefix is read, ending on a grapheme boundary: nothing caps a
 * stored description, and this runs for every signed-out visit to a `/p`
 * page. Text that goes on past the prefix is marked as cut even when what was
 * read would fit, since the reader is not seeing all of it.
 */
export function previewText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') {
    return '';
  }
  const limit = max * SOURCE_UNITS_PER_GRAPHEME;
  let source = raw;
  const clipped = raw.length > limit;
  if (clipped) {
    // Boundaries up to the limit depend only on the text around them, so a
    // window just past it decides them; segmenting all of `raw` would copy it.
    let end = 0;
    for (const { index, segment } of graphemes.segment(raw.slice(0, limit + CLIP_LOOKAHEAD))) {
      if (index + segment.length > limit) {
        break;
      }
      end = index + segment.length;
    }
    source = raw.slice(0, end);
  }
  const flat = source
    .replace(BIDI_CONTROLS, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts: string[] = [];
  for (const { segment } of graphemes.segment(flat)) {
    parts.push(segment);
    if (parts.length > max) {
      break;
    }
  }
  if (parts.length <= max && !clipped) {
    return flat;
  }
  const kept = parts.slice(0, max - 1).join('').trimEnd();
  // Nothing but padding before the clip: no text, not a lone "…".
  return kept === '' ? '' : `${kept}…`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function recipeMeta(
  token: string,
  recipeId: string,
  recipe: Record<string, unknown>,
  origin: string,
): PreviewMeta | null {
  const body = publicRecipeBody(recipe);
  const title = previewText(body.title, TITLE_MAX);
  if (title === '') {
    return null;
  }
  const meta: PreviewMeta = { title };
  const description = previewText(body.description, DESCRIPTION_MAX);
  if (description !== '') {
    meta.description = description;
  }
  if (isUuid(body.photoId)) {
    meta.imageUrl = `${origin}/api/public/${token}/recipes/${recipeId}/photos/${body.photoId}`;
  }
  return meta;
}

/** The tags for a live link, or null for every way it is not one. Throws on store errors. */
export async function resolvePreview(
  path: PreviewPath,
  origin: string,
  deps: PreviewDependencies,
): Promise<PreviewMeta | null> {
  const chain = await resolveLiveChain(path.token, deps);
  if (chain !== null) {
    if (path.recipeId === undefined) {
      const title = previewText(chain.collection.name, TITLE_MAX);
      return title === '' ? null : { title };
    }
    if (!listedRecipeIds(chain.collection).includes(path.recipeId)) {
      return null;
    }
    const [recipe] = await deps.readRecipes(chain.link.ownerSub, [path.recipeId]);
    if (recipe === undefined || !isLiveDoc(recipe) || recipe.id !== path.recipeId) {
      return null;
    }
    return recipeMeta(path.token, path.recipeId, recipe, origin);
  }
  // A recipe link has one page, `/p/<token>`.
  if (path.recipeId !== undefined) {
    return null;
  }
  const live = await resolveRecipeLink(path.token, deps);
  if (live === null) {
    return null;
  }
  return recipeMeta(path.token, live.link.recipeId, live.recipe, origin);
}

export function previewHeadTags(meta: PreviewMeta): string {
  const tag = (attr: 'property' | 'name', key: string, value: string) =>
    `<meta ${attr}="${key}" content="${escapeAttribute(value)}" />`;
  const tags = [
    tag('property', 'og:type', 'website'),
    tag('property', 'og:site_name', 'Sous'),
    tag('property', 'og:title', meta.title),
  ];
  if (meta.description !== undefined) {
    tags.push(tag('property', 'og:description', meta.description));
  }
  if (meta.imageUrl !== undefined) {
    tags.push(tag('property', 'og:image', meta.imageUrl));
  }
  tags.push(tag('name', 'twitter:card', meta.imageUrl === undefined ? 'summary' : 'summary_large_image'));
  return tags.join('\n    ');
}

/** The shell with the tags before its `</head>`; null unless it has exactly one. */
export function injectPreview(indexHtml: string, meta: PreviewMeta): string | null {
  const at = indexHtml.indexOf('</head>');
  if (at === -1 || indexHtml.indexOf('</head>', at + 1) !== -1) {
    return null;
  }
  // Own lines, indented like the shell's head, whatever the build left before `</head>`.
  return `${indexHtml.slice(0, at).trimEnd()}\n    ${previewHeadTags(meta)}\n  ${indexHtml.slice(at)}`;
}

export type PreviewHtmlOptions = {
  readIndex: () => Promise<string>;
  origin: () => string;
  deps: PreviewDependencies;
  timeoutMs?: number;
  maxInFlight?: number;
};

const TIMED_OUT = Symbol('timed out');

let lookupsInFlight = 0;

/**
 * The shell with preview tags for a resolved public page, or null: serve the
 * plain shell. `pathname` is the request path as sent (see `previewPath`). A
 * slow lookup is abandoned after `timeoutMs`; a store error logs its class
 * name only.
 */
export async function previewHtml(
  pathname: string,
  options: PreviewHtmlOptions,
): Promise<string | null> {
  const path = previewPath(pathname);
  if (path === null || lookupsInFlight >= (options.maxInFlight ?? MAX_PREVIEW_LOOKUPS_IN_FLIGHT)) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = resolvePreview(path, options.origin(), options.deps);
    lookupsInFlight += 1;
    // An abandoned lookup may still fail; it must not become an unhandled
    // rejection, and it holds its slot until it settles.
    void lookup
      .catch(() => undefined)
      .finally(() => {
        lookupsInFlight -= 1;
      });
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), options.timeoutMs ?? PREVIEW_LOOKUP_TIMEOUT_MS);
    });
    const meta = await Promise.race([lookup, timeout]);
    if (meta === TIMED_OUT || meta === null) {
      return null;
    }
    return injectPreview(await options.readIndex(), meta);
  } catch (err) {
    console.error('publicPreview error:', err instanceof Error ? err.name : 'unknown');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
