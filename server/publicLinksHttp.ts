import { publicOrigin } from './env.ts';
import { sharingOwnerAdmitted } from './grants.ts';
import {
  accessResponse,
  errorJson,
  requireOwnedLiveCollection,
  shareGrantErrorResponse,
} from './grantsHttp.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
  storeUnavailable,
  type RequireMemberResult,
} from './membership.ts';
import { storedPhotoResponse } from './photos.ts';
import { joinPublicLink, type PublicJoinOutcome } from './publicJoin.ts';
import {
  ensurePublicLink,
  hashPublicToken,
  isPublicTokenShape,
  publicApiPath,
  publicPageUrl,
  readOwnerPublicLink,
  readPublicCollection,
  readPublicLink,
  resolvePublicPhoto,
  revokePublicLinks,
  type PublicLinkRecord,
  type PublicReadDependencies,
} from './publicLinks.ts';
import {
  readRecipeLink,
  recipeLinkBody,
  resolveRecipeLink,
  resolveRecipeLinkPhoto,
  type RecipeLinkReadDependencies,
} from './recipeLinks.ts';
import { isUuid, readDocData, readDocsData } from './store.ts';

const BODY_LIMIT = 2_000;

/**
 * Visitor responses carry the token's URL in nobody's Referer and stay out
 * of search results. `no-store`: turning a link off must win on the next
 * request, so nothing may keep a copy.
 */
const VISITOR_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
};

function visitorJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...VISITOR_HEADERS },
  });
}

/** One answer for unknown, off, deleted, unlisted, and unadmitted owner. */
function visitorNotFound(): Response {
  return visitorJson({ error: 'Not found', code: 'not-found' }, 404);
}

function visitorUnavailable(): Response {
  return visitorJson({ error: 'Temporarily unavailable', code: 'unavailable' }, 503);
}

function withVisitorHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(VISITOR_HEADERS)) {
    // `storedPhotoResponse` sets its own Cache-Control, which is already no-store.
    if (key !== 'Cache-Control') {
      response.headers.set(key, value);
    }
  }
  return response;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await readBoundedText(req, BODY_LIMIT);
  if (raw === null) {
    return null;
  }
  try {
    const body: unknown = raw === '' ? {} : JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Visitor API: GET /api/public/<token>[/recipes/<id>/photos/<id>]. No session.
// The token is in the path, so these URLs are covered by the log exclusion in
// scripts/logExclusions.ts. Never log the request URL here.
//
// A token is a public collection link or a recipe link
// (`server/recipeLinks.ts`); the collection is tried first. The body says
// which: `{ kind: 'collection', collection, recipes }` or
// `{ kind: 'recipe', recipe, sharedBy? }`.
// ---------------------------------------------------------------------------

export type PublicVisitorDependencies = PublicReadDependencies &
  RecipeLinkReadDependencies & {
    photoResponse: (ownerSub: string, photoId: string, method: string) => Promise<Response>;
  };

export const liveVisitorDependencies: PublicVisitorDependencies = {
  readLink: readPublicLink,
  ownerAdmitted: sharingOwnerAdmitted,
  readCollection: (ownerSub, collectionId) => readDocData(ownerSub, 'collections', collectionId),
  readRecipes: (ownerSub, ids) => readDocsData(ownerSub, 'recipes', ids),
  readRecipeLink,
  readRecipe: (ownerSub, recipeId) => readDocData(ownerSub, 'recipes', recipeId),
  photoResponse: storedPhotoResponse,
};

export async function handlePublicGet(
  req: Request,
  deps: PublicVisitorDependencies,
): Promise<Response> {
  const path = publicApiPath(new URL(req.url).pathname);
  if (path === null) {
    return visitorNotFound();
  }
  try {
    if (path.kind === 'collection') {
      const result = await readPublicCollection(path.token, deps);
      if (result !== null) {
        return visitorJson({ kind: 'collection', ...result.body });
      }
      const recipe = await resolveRecipeLink(path.token, deps);
      return recipe === null
        ? visitorNotFound()
        : visitorJson(recipeLinkBody(recipe.link, recipe.recipe));
    }
    const allowed =
      (await resolvePublicPhoto(path, deps)) ?? (await resolveRecipeLinkPhoto(path, deps));
    if (allowed === null) {
      return visitorNotFound();
    }
    return withVisitorHeaders(await deps.photoResponse(allowed.ownerSub, path.photoId, req.method));
  } catch (err) {
    console.error('publicGet store error:', err instanceof Error ? err.name : 'unknown');
    return visitorUnavailable();
  }
}

export const publicGet = (req: Request) => handlePublicGet(req, liveVisitorDependencies);

// ---------------------------------------------------------------------------
// Member join: POST /api/public/join { token }. Cookie session, admitted
// member. The token rides in the body, never the URL.
// ---------------------------------------------------------------------------

export type PublicJoinDependencies = {
  requireMember: (req: Request) => Promise<RequireMemberResult>;
  readLink: (id: string) => Promise<PublicLinkRecord | null>;
  ownerAdmitted: (ownerSub: string) => Promise<boolean>;
  join: (token: string, redeemer: { sub: string; email: string }) => Promise<PublicJoinOutcome>;
};

const liveJoinDependencies: PublicJoinDependencies = {
  requireMember,
  readLink: readPublicLink,
  ownerAdmitted: sharingOwnerAdmitted,
  join: joinPublicLink,
};

/** 200 `{ collectionId, result: 'joined' | 'already' | 'own' }`, 404 dead, 409 full. */
export function publicJoinResponse(outcome: PublicJoinOutcome): Response {
  switch (outcome.kind) {
    case 'dead':
      return errorJson('not-found', 'Not found', 404);
    case 'cap':
      return shareGrantErrorResponse('full');
    case 'self':
      return publicJoinOk(outcome.collectionId, 'own');
    case 'idempotent':
      return publicJoinOk(outcome.collectionId, 'already');
    case 'write':
      return publicJoinOk(outcome.collectionId, 'joined');
    default: {
      const unreachable: never = outcome;
      throw new Error(`unexpected join outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

function publicJoinOk(collectionId: string, result: 'joined' | 'already' | 'own'): Response {
  return new Response(JSON.stringify({ collectionId, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function handlePublicJoinPost(
  req: Request,
  deps: PublicJoinDependencies,
): Promise<Response> {
  const access = await deps.requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }
  const body = await readJsonBody(req);
  if (body === null || !isPublicTokenShape(body.token)) {
    return errorJson('bad-request', 'Bad request', 400);
  }
  const token = body.token;
  try {
    // Checked outside the transaction, like a collection link's join page:
    // an unadmitted owner's link reads as dead.
    const link = await deps.readLink(hashPublicToken(token));
    if (
      link === null ||
      link.status !== 'live' ||
      link.token !== token ||
      (link.ownerSub !== access.sub && !(await deps.ownerAdmitted(link.ownerSub)))
    ) {
      return publicJoinResponse({ kind: 'dead' });
    }
    return publicJoinResponse(await deps.join(token, { sub: access.sub, email: access.email }));
  } catch (err) {
    console.error('publicJoinPost store error:', err instanceof Error ? err.name : 'unknown');
    return storeUnavailable();
  }
}

export const publicJoinPost = (req: Request) => handlePublicJoinPost(req, liveJoinDependencies);

// ---------------------------------------------------------------------------
// Owner API: /api/collections/:id/public — collection owner, cookie session.
// GET reads, POST turns on (idempotent), POST …/revoke turns off. 404 for
// anyone else. Body: `{ url }`, null when off.
// ---------------------------------------------------------------------------

export type PublicOwnerDependencies = {
  requireOwnedLiveCollection: typeof requireOwnedLiveCollection;
  read: (ownerSub: string, collectionId: string) => Promise<PublicLinkRecord | null>;
  ensure: typeof ensurePublicLink;
  revoke: (ownerSub: string, collectionId: string, now: number) => Promise<void>;
  origin: () => string;
  now: () => number;
};

const liveOwnerDependencies: PublicOwnerDependencies = {
  requireOwnedLiveCollection,
  read: readOwnerPublicLink,
  ensure: ensurePublicLink,
  revoke: revokePublicLinks,
  origin: publicOrigin,
  now: () => Date.now(),
};

export function collectionIdFromPublicPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/collections\/([^/]+)\/public(?:\/revoke)?$/);
  if (!match) {
    return null;
  }
  return isUuid(match[1]) ? match[1] : null;
}

function ownerJson(url: string | null): Response {
  return new Response(JSON.stringify({ url }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function publicOwnerGate(
  req: Request,
  deps: PublicOwnerDependencies,
): Promise<{ sub: string; email: string; collectionId: string } | Response> {
  const collectionId = collectionIdFromPublicPath(new URL(req.url).pathname);
  if (collectionId === null) {
    return errorJson('bad-request', 'Bad request', 400);
  }
  const access = await deps.requireOwnedLiveCollection(req, collectionId);
  const early = accessResponse(access);
  if (early) {
    return early;
  }
  if (access.kind !== 'ok') {
    return errorJson('not-found', 'Not found', 404);
  }
  return { sub: access.sub, email: access.email, collectionId };
}

export async function handlePublicLinkGet(
  req: Request,
  deps: PublicOwnerDependencies,
): Promise<Response> {
  const gate = await publicOwnerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  try {
    const origin = deps.origin();
    const link = await deps.read(gate.sub, gate.collectionId);
    return ownerJson(link === null ? null : publicPageUrl(origin, link.token));
  } catch (err) {
    console.error('publicLinkGet store error:', err instanceof Error ? err.name : 'unknown');
    return storeUnavailable();
  }
}

export async function handlePublicLinkPost(
  req: Request,
  deps: PublicOwnerDependencies,
): Promise<Response> {
  const gate = await publicOwnerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  try {
    const origin = deps.origin();
    const outcome = await deps.ensure(
      { ownerSub: gate.sub, ownerEmail: gate.email, collectionId: gate.collectionId },
      deps.now(),
    );
    if (outcome.kind === 'collectionMissing') {
      return errorJson('not-found', 'Not found', 404);
    }
    return ownerJson(publicPageUrl(origin, outcome.link.token));
  } catch (err) {
    console.error('publicLinkPost store error:', err instanceof Error ? err.name : 'unknown');
    return storeUnavailable();
  }
}

export async function handlePublicLinkRevokePost(
  req: Request,
  deps: PublicOwnerDependencies,
): Promise<Response> {
  const gate = await publicOwnerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  try {
    await deps.revoke(gate.sub, gate.collectionId, deps.now());
    return ownerJson(null);
  } catch (err) {
    console.error('publicLinkRevokePost store error:', err instanceof Error ? err.name : 'unknown');
    return storeUnavailable();
  }
}

export const collectionPublicLinkGet = (req: Request) =>
  handlePublicLinkGet(req, liveOwnerDependencies);
export const collectionPublicLinkPost = (req: Request) =>
  handlePublicLinkPost(req, liveOwnerDependencies);
export const collectionPublicLinkRevokePost = (req: Request) =>
  handlePublicLinkRevokePost(req, liveOwnerDependencies);
