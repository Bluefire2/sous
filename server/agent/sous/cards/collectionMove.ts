import { MAX_COLLECTION_RECIPE_IDS } from '../../../store.ts';
import type { CardSpec } from '../../harness/types.ts';
import type { AgentCollection, AgentLibrary } from '../library.ts';
import { winningMembership } from '../library.ts';

export type CollectionMoveDestination =
  | { kind: 'collection'; id: string; name: string }
  | { kind: 'unfiled' };

export type CollectionMovePreviewFrom =
  | { kind: 'collection'; name: string }
  | { kind: 'unfiled' };

export type CollectionMoveSource = {
  id: string;
  from: CollectionMovePreviewFrom;
};

export type CollectionMoveData = {
  destination: CollectionMoveDestination;
  recipeIds: string[];
  /** Proposal-time source of every moved recipe. Replay omits this. */
  sources: CollectionMoveSource[];
  preview: {
    id: string;
    title: string;
    from: CollectionMovePreviewFrom;
  }[];
  total: number;
};

/** Kept in sync with the client parser by test/agentCardContract.test.ts. */
export const COLLECTION_MOVE_PREVIEW_LIMIT = 8;
export const COLLECTION_MOVE_TITLE_MAX = 120;
const PREVIEW_LIMIT = COLLECTION_MOVE_PREVIEW_LIMIT;
const TITLE_MAX = COLLECTION_MOVE_TITLE_MAX;
const MAX_EXPLICIT_IDS = 100;
const UNFILED_NAME_ALIASES = new Set(['recipes', 'unfiled']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sliceTitle(title: string): string {
  if (title.length <= TITLE_MAX) {
    return title;
  }
  return title.slice(0, TITLE_MAX);
}

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function previewFromForRecipe(
  recipeId: string,
  membership: Map<string, string>,
  collectionById: Map<string, AgentCollection>,
): CollectionMovePreviewFrom {
  const collectionId = membership.get(recipeId);
  if (!collectionId) {
    return { kind: 'unfiled' };
  }
  const collection = collectionById.get(collectionId);
  const name = collection?.name && collection.name !== '' ? collection.name : collectionId;
  return { kind: 'collection', name };
}

function isInDestination(
  recipeId: string,
  destination: CollectionMoveDestination,
  membership: Map<string, string>,
): boolean {
  const winner = membership.get(recipeId);
  if (destination.kind === 'unfiled') {
    return winner === undefined;
  }
  return winner === destination.id;
}

type ResolvedDestination =
  | { ok: true; destination: CollectionMoveDestination; collection?: AgentCollection }
  | { ok: false; error: string };

function resolveDestination(
  args: Record<string, unknown>,
  collections: readonly AgentCollection[],
): ResolvedDestination {
  const hasCollectionId = args.collectionId !== undefined;
  const hasName = args.name !== undefined;
  const hasUnfiled = args.unfiled === true;

  let destCount = 0;
  if (hasCollectionId) {
    destCount += 1;
  }
  if (hasName) {
    destCount += 1;
  }
  if (hasUnfiled) {
    destCount += 1;
  }
  if (destCount !== 1) {
    return { ok: false, error: 'invalid payload' };
  }

  if (hasUnfiled) {
    return { ok: true, destination: { kind: 'unfiled' } };
  }

  if (hasCollectionId) {
    const rawId = args.collectionId;
    if (typeof rawId !== 'string' || rawId === '') {
      return { ok: false, error: 'invalid payload' };
    }
    if (normalizeNameKey(rawId) === 'unfiled') {
      return { ok: true, destination: { kind: 'unfiled' } };
    }
    const collection = collections.find((c) => c.id === rawId);
    if (!collection) {
      return { ok: false, error: 'unknown collection' };
    }
    const name = collection.name !== '' ? collection.name : collection.id;
    return {
      ok: true,
      destination: { kind: 'collection', id: collection.id, name },
      collection,
    };
  }

  const nameRaw = args.name;
  if (typeof nameRaw !== 'string' || nameRaw.trim() === '') {
    return { ok: false, error: 'invalid payload' };
  }
  const key = normalizeNameKey(nameRaw);
  const ownedNames = collections.map((c) => c.name);
  const matches = collections.filter((c) => normalizeNameKey(c.name) === key);
  if (matches.length > 1) {
    const names = matches.map((c) => (c.name !== '' ? c.name : c.id)).join(', ');
    return { ok: false, error: `ambiguous collection name; matches: ${names}` };
  }
  if (matches.length === 1) {
    const collection = matches[0]!;
    const name = collection.name !== '' ? collection.name : collection.id;
    return {
      ok: true,
      destination: { kind: 'collection', id: collection.id, name },
      collection,
    };
  }
  if (UNFILED_NAME_ALIASES.has(key)) {
    return { ok: true, destination: { kind: 'unfiled' } };
  }
  const listed =
    ownedNames.filter((n) => n !== '').join(', ') ||
    '(no named collections)';
  return {
    ok: false,
    error: `no owned collection named "${nameRaw.trim()}"; owned collections: ${listed}. Shared collections cannot be destinations.`,
  };
}

function selectRecipeIds(
  args: Record<string, unknown>,
  ctx: AgentLibrary,
  membership: Map<string, string>,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const hasAll = args.all === true;
  const hasRecipeIds = args.recipeIds !== undefined;
  const hasFrom = args.fromCollectionId !== undefined;

  let selCount = 0;
  if (hasAll) {
    selCount += 1;
  }
  if (hasRecipeIds) {
    selCount += 1;
  }
  if (hasFrom) {
    selCount += 1;
  }
  if (selCount !== 1) {
    return { ok: false, error: 'invalid payload' };
  }

  if (hasAll) {
    if (ctx.loadTruncated) {
      return { ok: false, error: 'library load was truncated; cannot select all recipes' };
    }
    return { ok: true, ids: ctx.recipes.map((r) => r.id) };
  }

  if (hasFrom) {
    if (ctx.loadTruncated) {
      return {
        ok: false,
        error: 'library load was truncated; cannot select by collection',
      };
    }
    const fromRaw = args.fromCollectionId;
    if (typeof fromRaw !== 'string' || fromRaw === '') {
      return { ok: false, error: 'invalid payload' };
    }
    const source = resolveSource(fromRaw, ctx.collections);
    if (!source.ok) {
      return source;
    }
    const ids: string[] = [];
    for (const recipe of ctx.recipes) {
      const winner = membership.get(recipe.id);
      if (source.kind === 'unfiled') {
        if (!winner) {
          ids.push(recipe.id);
        }
      } else if (winner === source.id) {
        ids.push(recipe.id);
      }
    }
    return { ok: true, ids };
  }

  const recipeIdsRaw = args.recipeIds;
  if (!Array.isArray(recipeIdsRaw) || recipeIdsRaw.length < 1 || recipeIdsRaw.length > MAX_EXPLICIT_IDS) {
    return { ok: false, error: 'recipeIds must be 1–100' };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of recipeIdsRaw) {
    if (typeof id !== 'string' || id === '') {
      return { ok: false, error: 'invalid recipe id' };
    }
    if (!ctx.recipeById(id)) {
      return { ok: false, error: 'unknown recipe id' };
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    return { ok: false, error: 'recipeIds must be 1–100' };
  }
  return { ok: true, ids };
}

function resolveSource(
  fromRaw: string,
  collections: readonly AgentCollection[],
): { ok: true; kind: 'unfiled' } | { ok: true; kind: 'collection'; id: string } | { ok: false; error: string } {
  const key = normalizeNameKey(fromRaw);
  const nameMatches = collections.filter((c) => normalizeNameKey(c.name) === key);
  if (nameMatches.length > 1) {
    const names = nameMatches.map((c) => (c.name !== '' ? c.name : c.id)).join(', ');
    return { ok: false, error: `ambiguous source collection; matches: ${names}` };
  }
  if (nameMatches.length === 1) {
    return { ok: true, kind: 'collection', id: nameMatches[0]!.id };
  }
  if (collections.some((c) => c.id === fromRaw)) {
    return { ok: true, kind: 'collection', id: fromRaw };
  }
  if (UNFILED_NAME_ALIASES.has(key)) {
    return { ok: true, kind: 'unfiled' };
  }
  return { ok: false, error: `unknown source collection "${fromRaw.trim()}"` };
}

function buildMoveData(
  destination: CollectionMoveDestination,
  moveIds: string[],
  ctx: AgentLibrary,
  membership: Map<string, string>,
  collectionById: Map<string, AgentCollection>,
): CollectionMoveData {
  const sources = moveIds.map((id) => ({
    id,
    from: previewFromForRecipe(id, membership, collectionById),
  }));
  const preview = sources.slice(0, PREVIEW_LIMIT).map((source) => {
    const recipe = ctx.recipeById(source.id)!;
    return {
      id: source.id,
      title: sliceTitle(recipe.title),
      from: source.from,
    };
  });
  return {
    destination,
    recipeIds: moveIds,
    sources,
    preview,
    total: moveIds.length,
  };
}

function unionWouldExceedCap(
  destinationCollection: AgentCollection,
  moveIds: string[],
): boolean {
  const set = new Set(destinationCollection.recipeIds);
  for (const id of moveIds) {
    set.add(id);
  }
  return set.size > MAX_COLLECTION_RECIPE_IDS;
}

export function normalizeCollectionMove(
  args: unknown,
  ctx: AgentLibrary,
): { ok: true; data: CollectionMoveData } | { ok: false; error: string } {
  if (!isPlainObject(args)) {
    return { ok: false, error: 'invalid payload' };
  }

  const membership = winningMembership(ctx.collections);
  const collectionById = new Map(ctx.collections.map((c) => [c.id, c]));

  const destResult = resolveDestination(args, ctx.collections);
  if (!destResult.ok) {
    return destResult;
  }
  const { destination, collection: destCollection } = destResult;

  const selResult = selectRecipeIds(args, ctx, membership);
  if (!selResult.ok) {
    return selResult;
  }

  const moveIds = selResult.ids.filter((id) => !isInDestination(id, destination, membership));

  if (moveIds.length === 0) {
    return { ok: false, error: 'selected recipes are already in the destination' };
  }

  if (moveIds.length > MAX_COLLECTION_RECIPE_IDS) {
    return { ok: false, error: 'move exceeds 500 recipe limit' };
  }

  if (destination.kind === 'collection' && destCollection) {
    if (unionWouldExceedCap(destCollection, moveIds)) {
      return { ok: false, error: 'destination collection would exceed 500 recipes' };
    }
  }

  return {
    ok: true,
    data: buildMoveData(destination, moveIds, ctx, membership, collectionById),
  };
}

function destinationShapeOk(dest: unknown): dest is CollectionMoveDestination {
  if (!isPlainObject(dest)) {
    return false;
  }
  if (dest.kind === 'unfiled') {
    return true;
  }
  return (
    dest.kind === 'collection' &&
    typeof dest.id === 'string' &&
    dest.id !== '' &&
    typeof dest.name === 'string'
  );
}

function previewShapeOk(preview: unknown): boolean {
  if (!Array.isArray(preview) || preview.length > PREVIEW_LIMIT) {
    return false;
  }
  for (const row of preview) {
    if (!isPlainObject(row) || typeof row.id !== 'string' || typeof row.title !== 'string') {
      return false;
    }
    if (row.title.length > TITLE_MAX) {
      return false;
    }
    if (!isPlainObject(row.from)) {
      return false;
    }
  }
  return true;
}

/** Full card, or the replay summary that omits recipe ids. */
function isValidDataShape(data: unknown): data is CollectionMoveData {
  if (!isPlainObject(data) || !destinationShapeOk(data.destination) || !previewShapeOk(data.preview)) {
    return false;
  }
  if (typeof data.total !== 'number' || !Number.isInteger(data.total)) {
    return false;
  }
  if (data.total < 1 || data.total > MAX_COLLECTION_RECIPE_IDS) {
    return false;
  }
  if (data.recipeIds === undefined) {
    return true;
  }
  if (!Array.isArray(data.recipeIds) || data.recipeIds.length > MAX_COLLECTION_RECIPE_IDS) {
    return false;
  }
  for (const id of data.recipeIds) {
    if (typeof id !== 'string' || id === '') {
      return false;
    }
  }
  return data.total === data.recipeIds.length;
}

export function revalidateCollectionMove(
  data: unknown,
  ctx: AgentLibrary,
): { ok: true; data: CollectionMoveData } | { ok: false; error: string } {
  if (!isValidDataShape(data)) {
    return { ok: false, error: 'invalid card data' };
  }

  const recipeIds = data.recipeIds ?? [];
  for (const id of recipeIds) {
    if (!ctx.recipeById(id)) {
      return { ok: false, error: 'recipe no longer in library' };
    }
  }

  const currentDestination = data.destination;
  let destination = currentDestination;
  if (currentDestination.kind === 'collection') {
    const destinationId = currentDestination.id;
    const collection = ctx.collections.find((c) => c.id === destinationId);
    if (!collection) {
      return { ok: false, error: 'destination collection no longer exists' };
    }
    const name = collection.name !== '' ? collection.name : collection.id;
    destination = { kind: 'collection', id: collection.id, name };
  }

  return {
    ok: true,
    data: {
      destination,
      recipeIds,
      sources: data.sources ?? [],
      preview: data.preview,
      total: data.total,
    },
  };
}

export function collectionMoveHistoryText(data: CollectionMoveData): string {
  const destLabel =
    data.destination.kind === 'unfiled'
      ? 'Recipes'
      : data.destination.name;
  return `Proposed moving ${data.total} recipes into ${destLabel}. Not confirmed. Call list_collections for the current membership.`;
}

export const collectionMoveCard: CardSpec<AgentLibrary, CollectionMoveData> = {
  type: 'collection_move',
  version: 1,
  toolName: 'propose_collection_move',
  description:
    'Propose moving owned recipes into an existing collection or back to unfiled. The user must confirm on the card.',
  parameters: {
    type: 'object',
    properties: {
      all: { type: 'boolean', description: 'Move every recipe in the library.' },
      recipeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Move 1–100 recipe ids.',
      },
      fromCollectionId: {
        type: 'string',
        description: 'Move recipes whose winning collection is this id, or unfiled.',
      },
      collectionId: { type: 'string', description: 'Destination collection id, or unfiled.' },
      name: { type: 'string', description: 'Destination collection name (owned only).' },
      unfiled: { type: 'boolean', description: 'Move recipes back to unfiled.' },
    },
  },
  rule:
    'Call list_collections first; use this tool to file or unfile; pass collectionId when list_collections already returned one; treat Recipes / Unfiled / no collection as unfiled only when no owned collection has that name; pass all:true for every owned recipe and fromCollectionId for one source collection; do not claim the move already happened; a missing name is created with propose_create_collection, not this tool.',
  normalize: normalizeCollectionMove,
  revalidate: revalidateCollectionMove,
  historyText: collectionMoveHistoryText,
};
