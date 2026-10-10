import { listLiveDocs } from '../../store.ts';

export type IngredientSection = {
  name?: string;
  items: { quantity?: number; unit?: string; item: string; note?: string; optional?: boolean }[];
};

export type AgentRecipe = {
  id: string;
  title: string;
  description?: string;
  sourceUrl?: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  ingredientSections: IngredientSection[];
  steps: { text: string }[];
  tags: string[];
  notes?: string;
  photoId?: string;
  galleryPhotoIds?: string[];
  createdAt: number;
  updatedAt: number;
};

export type AgentCollection = {
  id: string;
  name: string;
  recipeIds: string[];
};

export interface AgentLibrary {
  recipes: AgentRecipe[];
  collections: AgentCollection[];
  truncated: boolean;
  /** True only when recipe or collection documents were cut off during load. */
  loadTruncated: boolean;
  recipeById(id: string): AgentRecipe | undefined;
  collectionNameFor(recipeId: string): string;
  indexText(): string;
}

export type LoadAgentLibraryLimits = {
  maxDocs: number;
  maxBytes: number;
  maxIndexEntries: number;
  maxIndexChars: number;
};

// Ported from src/lib/collectionMembership.ts winningMembership. Keep in sync.
export function winningMembership(
  collections: readonly AgentCollection[],
): Map<string, string> {
  const sorted = [...collections].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const map = new Map<string, string>();
  for (const collection of sorted) {
    for (const recipeId of collection.recipeIds) {
      if (!map.has(recipeId)) {
        map.set(recipeId, collection.id);
      }
    }
  }
  return map;
}

function parseIngredientSections(raw: unknown): IngredientSection[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const sections: IngredientSection[] = [];
  for (const section of raw) {
    if (!section || typeof section !== 'object') {
      continue;
    }
    const rec = section as Record<string, unknown>;
    const items: IngredientSection['items'] = [];
    if (Array.isArray(rec.items)) {
      for (const item of rec.items) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const ir = item as Record<string, unknown>;
        if (typeof ir.item !== 'string' || ir.item.trim() === '') {
          continue;
        }
        const ing: IngredientSection['items'][number] = { item: ir.item };
        if (typeof ir.quantity === 'number' && Number.isFinite(ir.quantity)) {
          ing.quantity = ir.quantity;
        }
        if (typeof ir.unit === 'string' && ir.unit !== '') {
          ing.unit = ir.unit;
        }
        if (typeof ir.note === 'string' && ir.note !== '') {
          ing.note = ir.note;
        }
        if (ir.optional === true) {
          ing.optional = true;
        }
        items.push(ing);
      }
    }
    if (items.length === 0) {
      continue;
    }
    const sec: IngredientSection = { items };
    if (typeof rec.name === 'string' && rec.name.trim() !== '') {
      sec.name = rec.name;
    }
    sections.push(sec);
  }
  return sections;
}

function parseSteps(raw: unknown): { text: string }[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const steps: { text: string }[] = [];
  for (const step of raw) {
    if (step && typeof step === 'object' && typeof (step as { text?: unknown }).text === 'string') {
      steps.push({ text: (step as { text: string }).text });
    }
  }
  return steps;
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag === 'string' && tag !== '') {
      tags.push(tag);
    }
  }
  return tags;
}

export function narrowAgentRecipe(doc: Record<string, unknown>): AgentRecipe | null {
  if (typeof doc.id !== 'string' || doc.id === '') {
    return null;
  }
  if (typeof doc.title !== 'string' || doc.title.trim() === '') {
    return null;
  }
  const servings =
    typeof doc.servings === 'number' && Number.isFinite(doc.servings) && doc.servings > 0
      ? doc.servings
      : 1;
  const createdAt =
    typeof doc.createdAt === 'number' && Number.isFinite(doc.createdAt) ? doc.createdAt : 0;
  const updatedAt =
    typeof doc.updatedAt === 'number' && Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0;
  const recipe: AgentRecipe = {
    id: doc.id,
    title: doc.title,
    servings,
    ingredientSections: parseIngredientSections(doc.ingredientSections),
    steps: parseSteps(doc.steps),
    tags: parseTags(doc.tags),
    createdAt,
    updatedAt,
  };
  if (typeof doc.description === 'string' && doc.description !== '') {
    recipe.description = doc.description;
  }
  if (typeof doc.sourceUrl === 'string' && doc.sourceUrl !== '') {
    recipe.sourceUrl = doc.sourceUrl;
  }
  if (typeof doc.prepMinutes === 'number' && Number.isFinite(doc.prepMinutes)) {
    recipe.prepMinutes = doc.prepMinutes;
  }
  if (typeof doc.cookMinutes === 'number' && Number.isFinite(doc.cookMinutes)) {
    recipe.cookMinutes = doc.cookMinutes;
  }
  if (typeof doc.notes === 'string' && doc.notes !== '') {
    recipe.notes = doc.notes;
  }
  if (typeof doc.photoId === 'string' && doc.photoId !== '') {
    recipe.photoId = doc.photoId;
  }
  if (Array.isArray(doc.galleryPhotoIds)) {
    const ids = doc.galleryPhotoIds.filter((id): id is string => typeof id === 'string' && id !== '');
    if (ids.length > 0) {
      recipe.galleryPhotoIds = ids;
    }
  }
  return recipe;
}

export function narrowAgentCollection(doc: Record<string, unknown>): AgentCollection | null {
  if (typeof doc.id !== 'string' || doc.id === '') {
    return null;
  }
  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  const recipeIds: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(doc.recipeIds)) {
    for (const id of doc.recipeIds) {
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id);
        recipeIds.push(id);
      }
    }
  }
  return { id: doc.id, name, recipeIds };
}

/** Collapse whitespace and drop angle brackets so a title cannot close the index block. */
export function libraryIndexField(value: string): string {
  return value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildLibraryIndexText(
  recipes: readonly AgentRecipe[],
  limits: { maxIndexEntries: number; maxIndexChars: number },
): { text: string; indexTruncated: boolean } {
  const sorted = [...recipes].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const lines: string[] = [];
  let indexTruncated = false;
  let charBudget = limits.maxIndexChars;
  for (let i = 0; i < sorted.length && lines.length < limits.maxIndexEntries; i++) {
    const recipe = sorted[i]!;
    const tags = recipe.tags.map(libraryIndexField).join(',');
    const line = `${recipe.id}\t${libraryIndexField(recipe.title)}\t${tags}`;
    const lineWithNewline = line + '\n';
    if (charBudget < lineWithNewline.length) {
      indexTruncated = true;
      break;
    }
    lines.push(line);
    charBudget -= lineWithNewline.length;
  }
  if (sorted.length > lines.length) {
    indexTruncated = true;
  }
  let text = `<library_data>\n${lines.join('\n')}\n</library_data>`;
  if (indexTruncated) {
    text += '\nLibrary index truncated.';
  }
  return { text, indexTruncated };
}

export function buildAgentLibrary(
  recipes: AgentRecipe[],
  collections: AgentCollection[],
  opts: { truncated: boolean; maxIndexEntries: number; maxIndexChars: number },
): AgentLibrary {
  const membership = winningMembership(collections);
  const collectionById = new Map(collections.map((c) => [c.id, c]));
  const recipeByIdMap = new Map(recipes.map((r) => [r.id, r]));
  const { text: indexTextValue, indexTruncated } = buildLibraryIndexText(recipes, {
    maxIndexEntries: opts.maxIndexEntries,
    maxIndexChars: opts.maxIndexChars,
  });
  const loadTruncated = opts.truncated;
  const truncated = opts.truncated || indexTruncated;

  return {
    recipes,
    collections,
    truncated,
    loadTruncated,
    recipeById(id: string) {
      return recipeByIdMap.get(id);
    },
    collectionNameFor(recipeId: string) {
      const collectionId = membership.get(recipeId);
      if (!collectionId) {
        return 'Unfiled';
      }
      const collection = collectionById.get(collectionId);
      return collection?.name && collection.name !== '' ? collection.name : collectionId;
    },
    indexText() {
      return indexTextValue;
    },
  };
}

export async function loadAgentLibrary(
  uid: string,
  limits: LoadAgentLibraryLimits,
): Promise<AgentLibrary> {
  const docLimits = { maxDocs: limits.maxDocs, maxBytes: limits.maxBytes };
  const [recipeResult, collectionResult] = await Promise.all([
    listLiveDocs(uid, 'recipes', docLimits),
    listLiveDocs(uid, 'collections', docLimits),
  ]);
  const recipes: AgentRecipe[] = [];
  for (const doc of recipeResult.docs) {
    const narrowed = narrowAgentRecipe(doc);
    if (narrowed) {
      recipes.push(narrowed);
    }
  }
  const collections: AgentCollection[] = [];
  for (const doc of collectionResult.docs) {
    const narrowed = narrowAgentCollection(doc);
    if (narrowed) {
      collections.push(narrowed);
    }
  }
  const truncated = recipeResult.truncated || collectionResult.truncated;
  return buildAgentLibrary(recipes, collections, {
    truncated,
    maxIndexEntries: limits.maxIndexEntries,
    maxIndexChars: limits.maxIndexChars,
  });
}
