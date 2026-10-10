import { MAX_COLLECTION_RECIPE_IDS, MAX_NAMED_COLLECTIONS } from '../../../store.ts';
import type { CardSpec } from '../../harness/types.ts';
import type { AgentCollection, AgentLibrary } from '../library.ts';
import { winningMembership } from '../library.ts';

export type CollectionCreateFrom =
  | { kind: 'collection'; name: string }
  | { kind: 'unfiled' };

export type CollectionCreateSource = {
  id: string;
  from: CollectionCreateFrom;
};

export type CollectionCreateData = {
  name: string;
  recipeIds: string[];
  /** Proposal-time source of every filed recipe. Replay omits this. */
  sources: CollectionCreateSource[];
  preview: {
    id: string;
    title: string;
    from: CollectionCreateFrom;
  }[];
  total: number;
};

/** Kept in sync with the client parser by test/agentCardContract.test.ts. */
export const COLLECTION_CREATE_PREVIEW_LIMIT = 8;
export const COLLECTION_CREATE_TITLE_MAX = 120;
export const COLLECTION_CREATE_NAME_MAX = 80;
export const COLLECTION_CREATE_MAX_EXPLICIT_IDS = 100;

const PREVIEW_LIMIT = COLLECTION_CREATE_PREVIEW_LIMIT;
const TITLE_MAX = COLLECTION_CREATE_TITLE_MAX;
const NAME_MAX = COLLECTION_CREATE_NAME_MAX;
const MAX_EXPLICIT_IDS = COLLECTION_CREATE_MAX_EXPLICIT_IDS;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sliceTitle(title: string): string {
  if (title.length <= TITLE_MAX) {
    return title;
  }
  return title.slice(0, TITLE_MAX);
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function fromForRecipe(
  recipeId: string,
  membership: Map<string, string>,
  collectionById: Map<string, AgentCollection>,
): CollectionCreateFrom {
  const collectionId = membership.get(recipeId);
  if (!collectionId) {
    return { kind: 'unfiled' };
  }
  const collection = collectionById.get(collectionId);
  const name = collection?.name && collection.name !== '' ? collection.name : collectionId;
  return { kind: 'collection', name };
}

function selectRecipeIds(
  args: Record<string, unknown>,
  ctx: AgentLibrary,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const recipeIdsRaw = args.recipeIds;
  // Function calls often fill an optional array with [] or null; both mean
  // an empty collection, the same as leaving recipeIds out.
  if (recipeIdsRaw === undefined || recipeIdsRaw === null) {
    return { ok: true, ids: [] };
  }
  if (!Array.isArray(recipeIdsRaw) || recipeIdsRaw.length > MAX_EXPLICIT_IDS) {
    return { ok: false, error: 'recipeIds must be at most 100' };
  }
  if (recipeIdsRaw.length === 0) {
    return { ok: true, ids: [] };
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
  return { ok: true, ids };
}

function buildCreateData(
  name: string,
  moveIds: string[],
  ctx: AgentLibrary,
  membership: Map<string, string>,
  collectionById: Map<string, AgentCollection>,
): CollectionCreateData {
  const sources = moveIds.map((id) => ({
    id,
    from: fromForRecipe(id, membership, collectionById),
  }));
  const preview = sources.slice(0, PREVIEW_LIMIT).map((source) => {
    const recipe = ctx.recipeById(source.id)!;
    const title = recipe.title.trim() === '' ? source.id : recipe.title;
    return {
      id: source.id,
      title: sliceTitle(title),
      from: source.from,
    };
  });
  return {
    name,
    recipeIds: moveIds,
    sources,
    preview,
    total: moveIds.length,
  };
}

export function normalizeCollectionCreate(
  args: unknown,
  ctx: AgentLibrary,
): { ok: true; data: CollectionCreateData } | { ok: false; error: string } {
  if (!isPlainObject(args)) {
    return { ok: false, error: 'invalid payload' };
  }
  if (ctx.loadTruncated) {
    return { ok: false, error: 'library load was truncated; cannot create a collection' };
  }
  if (ctx.collections.length >= MAX_NAMED_COLLECTIONS) {
    return { ok: false, error: 'owned collection cap reached' };
  }

  const nameRaw = args.name;
  if (typeof nameRaw !== 'string') {
    return { ok: false, error: 'name required' };
  }
  const name = nameRaw.trim();
  if (name === '') {
    return { ok: false, error: 'name required' };
  }
  if (name.length > NAME_MAX) {
    return { ok: false, error: 'name too long' };
  }

  const key = nameKey(name);
  const matches = ctx.collections.filter((c) => nameKey(c.name) === key);
  if (matches.length > 1) {
    const listed = matches
      .map((c) => `${c.name !== '' ? c.name : c.id} (${c.id})`)
      .join(', ');
    return { ok: false, error: `ambiguous collection name; matches: ${listed}` };
  }
  if (matches.length === 1) {
    const existing = matches[0]!;
    const existingName = existing.name !== '' ? existing.name : existing.id;
    return {
      ok: false,
      error: `a collection named "${existingName}" already exists; call propose_collection_move with collectionId "${existing.id}"`,
    };
  }

  const selResult = selectRecipeIds(args, ctx);
  if (!selResult.ok) {
    return selResult;
  }

  const membership = winningMembership(ctx.collections);
  const collectionById = new Map(ctx.collections.map((c) => [c.id, c]));
  return {
    ok: true,
    data: buildCreateData(name, selResult.ids, ctx, membership, collectionById),
  };
}

function fromShapeOk(value: unknown): value is CollectionCreateFrom {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.kind === 'unfiled') {
    return true;
  }
  return value.kind === 'collection' && typeof value.name === 'string' && value.name !== '';
}

function previewShapeOk(preview: unknown): boolean {
  if (!Array.isArray(preview) || preview.length > PREVIEW_LIMIT) {
    return false;
  }
  for (const row of preview) {
    if (!isPlainObject(row)) {
      return false;
    }
    if (typeof row.id !== 'string' || row.id === '') {
      return false;
    }
    if (typeof row.title !== 'string' || row.title === '' || row.title.length > TITLE_MAX) {
      return false;
    }
    if (!fromShapeOk(row.from)) {
      return false;
    }
  }
  return true;
}

function sourcesShapeOk(sources: unknown, recipeIds: string[]): boolean {
  if (!Array.isArray(sources) || sources.length !== recipeIds.length) {
    return false;
  }
  for (let i = 0; i < sources.length; i += 1) {
    const entry = sources[i];
    if (!isPlainObject(entry) || entry.id !== recipeIds[i] || !fromShapeOk(entry.from)) {
      return false;
    }
  }
  return true;
}

/** Full card, or the replay summary that omits recipe ids. */
function isValidDataShape(data: unknown): data is CollectionCreateData {
  if (!isPlainObject(data) || !previewShapeOk(data.preview)) {
    return false;
  }
  if (typeof data.name !== 'string') {
    return false;
  }
  const name = data.name.trim();
  if (name === '' || name.length > NAME_MAX) {
    return false;
  }
  if (typeof data.total !== 'number' || !Number.isInteger(data.total)) {
    return false;
  }
  if (data.total < 0 || data.total > MAX_COLLECTION_RECIPE_IDS) {
    return false;
  }
  if (data.recipeIds === undefined) {
    return data.sources === undefined;
  }
  if (!Array.isArray(data.recipeIds) || data.recipeIds.length > MAX_COLLECTION_RECIPE_IDS) {
    return false;
  }
  for (const id of data.recipeIds) {
    if (typeof id !== 'string' || id === '') {
      return false;
    }
  }
  if (data.total !== data.recipeIds.length) {
    return false;
  }
  if (data.sources === undefined) {
    return false;
  }
  return sourcesShapeOk(data.sources, data.recipeIds);
}

export function revalidateCollectionCreate(
  data: unknown,
  ctx: AgentLibrary,
): { ok: true; data: CollectionCreateData } | { ok: false; error: string } {
  if (!isValidDataShape(data)) {
    return { ok: false, error: 'invalid card data' };
  }

  const recipeIds = data.recipeIds ?? [];
  for (const id of recipeIds) {
    if (!ctx.recipeById(id)) {
      return { ok: false, error: 'recipe no longer in library' };
    }
  }

  return {
    ok: true,
    data: {
      name: data.name.trim(),
      recipeIds,
      sources: data.sources ?? [],
      preview: data.preview,
      total: data.total,
    },
  };
}

export function collectionCreateHistoryText(data: CollectionCreateData): string {
  if (data.total === 0) {
    return `Proposed creating ${data.name} with no recipes. Not confirmed. Call list_collections for the current collections.`;
  }
  return `Proposed creating ${data.name} with ${data.total} recipes. Not confirmed. Call list_collections for the current collections.`;
}

export const collectionCreateCard: CardSpec<AgentLibrary, CollectionCreateData> = {
  type: 'collection_create',
  version: 1,
  toolName: 'propose_create_collection',
  description:
    'Propose creating an owned collection, optionally filing recipe ids into it. The user must confirm on the card. The collection does not exist until they confirm.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the new owned collection.' },
      recipeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Owned recipe ids to file into the new collection (at most 100). Omit for an empty collection.',
      },
    },
    required: ['name'],
  },
  rule:
    'Call propose_create_collection to create one owned collection. Choose recipe ids from the library index or from search_recipes, then pass them here; omit recipeIds for an empty collection. Do not also call propose_collection_move for a collection that does not exist yet, and do not claim the collection was created. If search_recipes returns as many hits as the limit you asked for, at most 20, say the set may be incomplete. If the name already exists, call propose_collection_move with that collectionId instead.',
  normalize: normalizeCollectionCreate,
  revalidate: revalidateCollectionCreate,
  historyText: collectionCreateHistoryText,
};
