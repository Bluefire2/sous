import { publicOrigin } from './env.ts';
import { errorJson } from './grantsHttp.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  requireMember,
  storeUnavailable,
  type RequireMemberResult,
} from './membership.ts';
import { publicPageUrl } from './publicLinks.ts';
import {
  ensureRecipeLink,
  readOwnerRecipeLink,
  revokeRecipeLinks,
  type RecipeLinkRecord,
} from './recipeLinks.ts';
import { isLiveDoc, isUuid, readDocData, readUserName } from './store.ts';

// ---------------------------------------------------------------------------
// Owner API: /api/recipes/:id/public — the recipe's owner, cookie session.
// GET reads, POST turns on (idempotent), POST …/revoke turns off. 404 for
// anyone else, including a member who reaches the recipe through a share.
// Body: `{ url }`, null when off. Mirrors the collection owner API in
// `server/publicLinksHttp.ts`.
// ---------------------------------------------------------------------------

export type RecipeLinkOwnerDependencies = {
  requireMember: (req: Request) => Promise<RequireMemberResult>;
  readRecipe: (ownerSub: string, recipeId: string) => Promise<Record<string, unknown> | undefined>;
  readOwnerName: (ownerSub: string) => Promise<string | undefined>;
  read: (ownerSub: string, recipeId: string) => Promise<RecipeLinkRecord | null>;
  ensure: typeof ensureRecipeLink;
  revoke: (ownerSub: string, recipeId: string, now: number) => Promise<void>;
  origin: () => string;
  now: () => number;
};

const liveOwnerDependencies: RecipeLinkOwnerDependencies = {
  requireMember,
  readRecipe: (ownerSub, recipeId) => readDocData(ownerSub, 'recipes', recipeId),
  readOwnerName: readUserName,
  read: readOwnerRecipeLink,
  ensure: ensureRecipeLink,
  revoke: revokeRecipeLinks,
  origin: publicOrigin,
  now: () => Date.now(),
};

export function recipeIdFromPublicPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/recipes\/([^/]+)\/public(?:\/revoke)?$/);
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

function notFound(): Response {
  return errorJson('not-found', 'Not found', 404);
}

async function recipeOwnerGate(
  req: Request,
  deps: RecipeLinkOwnerDependencies,
): Promise<{ sub: string; email: string; recipeId: string } | Response> {
  const recipeId = recipeIdFromPublicPath(new URL(req.url).pathname);
  if (recipeId === null) {
    return errorJson('bad-request', 'Bad request', 400);
  }
  const access = await deps.requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }
  try {
    const recipe = await deps.readRecipe(access.sub, recipeId);
    if (recipe === undefined || !isLiveDoc(recipe)) {
      return notFound();
    }
  } catch {
    return membershipUnavailable();
  }
  return { sub: access.sub, email: access.email, recipeId };
}

export async function handleRecipeLinkGet(
  req: Request,
  deps: RecipeLinkOwnerDependencies,
): Promise<Response> {
  const gate = await recipeOwnerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  try {
    const origin = deps.origin();
    const link = await deps.read(gate.sub, gate.recipeId);
    return ownerJson(link === null ? null : publicPageUrl(origin, link.token));
  } catch (err) {
    console.error('recipeLinkGet store error:', err instanceof Error ? err.name : 'unknown');
    return storeUnavailable();
  }
}

export async function handleRecipeLinkPost(
  req: Request,
  deps: RecipeLinkOwnerDependencies,
): Promise<Response> {
  const gate = await recipeOwnerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  try {
    const origin = deps.origin();
    const ownerName = await deps.readOwnerName(gate.sub);
    const outcome = await deps.ensure(
      { ownerSub: gate.sub, ownerEmail: gate.email, ownerName, recipeId: gate.recipeId },
      deps.now(),
    );
    if (outcome.kind === 'recipeMissing') {
      return notFound();
    }
    return ownerJson(publicPageUrl(origin, outcome.link.token));
  } catch (err) {
    console.error('recipeLinkPost store error:', err instanceof Error ? err.name : 'unknown');
    return storeUnavailable();
  }
}

export async function handleRecipeLinkRevokePost(
  req: Request,
  deps: RecipeLinkOwnerDependencies,
): Promise<Response> {
  const gate = await recipeOwnerGate(req, deps);
  if (gate instanceof Response) {
    return gate;
  }
  try {
    await deps.revoke(gate.sub, gate.recipeId, deps.now());
    return ownerJson(null);
  } catch (err) {
    console.error('recipeLinkRevokePost store error:', err instanceof Error ? err.name : 'unknown');
    return storeUnavailable();
  }
}

export const recipePublicLinkGet = (req: Request) => handleRecipeLinkGet(req, liveOwnerDependencies);
export const recipePublicLinkPost = (req: Request) =>
  handleRecipeLinkPost(req, liveOwnerDependencies);
export const recipePublicLinkRevokePost = (req: Request) =>
  handleRecipeLinkRevokePost(req, liveOwnerDependencies);
