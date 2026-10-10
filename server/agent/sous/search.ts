import type { AgentLibrary, AgentRecipe } from './library.ts';
import { winningMembership } from './library.ts';

export type SearchRecipesArgs = {
  query?: string;
  tags?: string[];
  collectionId?: string;
  maxTotalMinutes?: number;
  includeIngredients?: string[];
  excludeIngredients?: string[];
  limit?: number;
};

export type SearchRecipeHit = {
  id: string;
  title: string;
  tags: string[];
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  totalMinutes?: number;
  timeUnknown: boolean;
  collectionName: string;
  snippet: string;
};

export function recipeTotalMinutes(recipe: AgentRecipe): {
  totalMinutes?: number;
  timeUnknown: boolean;
} {
  const prep =
    typeof recipe.prepMinutes === 'number' && Number.isFinite(recipe.prepMinutes)
      ? recipe.prepMinutes
      : undefined;
  const cook =
    typeof recipe.cookMinutes === 'number' && Number.isFinite(recipe.cookMinutes)
      ? recipe.cookMinutes
      : undefined;
  if (prep !== undefined && cook !== undefined) {
    return { totalMinutes: prep + cook, timeUnknown: false };
  }
  if (prep !== undefined) {
    return { totalMinutes: prep, timeUnknown: false };
  }
  if (cook !== undefined) {
    return { totalMinutes: cook, timeUnknown: false };
  }
  return { timeUnknown: true };
}

function allIngredientItems(recipe: AgentRecipe): string[] {
  const items: string[] = [];
  for (const section of recipe.ingredientSections) {
    for (const ing of section.items) {
      items.push(ing.item);
    }
  }
  return items;
}

function ingredientHaystack(recipe: AgentRecipe): string {
  return allIngredientItems(recipe).join('\n').toLowerCase();
}

export function scoreRecipe(recipe: AgentRecipe, query: string): number {
  if (query === '') {
    return 0;
  }
  const q = query.toLowerCase();
  let score = 0;
  if (recipe.title.toLowerCase().includes(q)) {
    score += 100;
  }
  for (const tag of recipe.tags) {
    const t = tag.toLowerCase();
    if (t === q || t.includes(q)) {
      score += 40;
    }
  }
  for (const item of allIngredientItems(recipe)) {
    if (item.toLowerCase().includes(q)) {
      score += 20;
      break;
    }
  }
  if (recipe.description?.toLowerCase().includes(q)) {
    score += 5;
  }
  if (recipe.notes?.toLowerCase().includes(q)) {
    score += 5;
  }
  return score;
}

export function buildSnippet(recipe: AgentRecipe): string {
  if (recipe.description) {
    const trimmed = recipe.description.trim();
    if (trimmed.length <= 140) {
      return trimmed;
    }
    return trimmed.slice(0, 140);
  }
  for (const section of recipe.ingredientSections) {
    for (const ing of section.items) {
      if (ing.item.trim() !== '') {
        return ing.item.trim();
      }
    }
  }
  return '';
}

function passesTags(recipe: AgentRecipe, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) {
    return true;
  }
  const recipeTags = recipe.tags.map((t) => t.toLowerCase());
  for (const tag of tags) {
    const want = tag.toLowerCase();
    if (!recipeTags.some((t) => t === want)) {
      return false;
    }
  }
  return true;
}

function passesIncludeIngredients(recipe: AgentRecipe, terms: string[] | undefined): boolean {
  if (!terms || terms.length === 0) {
    return true;
  }
  const hay = ingredientHaystack(recipe);
  for (const term of terms) {
    if (!hay.includes(term.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function passesExcludeIngredients(recipe: AgentRecipe, terms: string[] | undefined): boolean {
  if (!terms || terms.length === 0) {
    return true;
  }
  const hay = ingredientHaystack(recipe);
  for (const term of terms) {
    if (hay.includes(term.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function passesCollection(
  recipe: AgentRecipe,
  collectionId: string | undefined,
  membership: Map<string, string>,
): boolean {
  if (!collectionId) {
    return true;
  }
  if (collectionId === 'unfiled') {
    return !membership.has(recipe.id);
  }
  return membership.get(recipe.id) === collectionId;
}

function passesMaxTotalMinutes(
  recipe: AgentRecipe,
  maxTotalMinutes: number | undefined,
): boolean {
  if (maxTotalMinutes === undefined || !Number.isFinite(maxTotalMinutes)) {
    return true;
  }
  const { totalMinutes, timeUnknown } = recipeTotalMinutes(recipe);
  if (timeUnknown) {
    return true;
  }
  return totalMinutes !== undefined && totalMinutes <= maxTotalMinutes;
}

function clampLimit(limit: number | undefined): number {
  const n = limit ?? 10;
  if (!Number.isFinite(n) || n < 1) {
    return 10;
  }
  return Math.min(20, Math.floor(n));
}

export function searchRecipes(library: AgentLibrary, args: SearchRecipesArgs): SearchRecipeHit[] {
  return searchRecipesPage(library, args, { offset: 0, limit: args.limit }).hits;
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}

/**
 * One page of `searchRecipes`' ordering: the hits from `offset`, at most
 * `limit` (clamped like the agent's, to 1–20), and how many recipes matched in
 * all. With no query the order is alphabetical, so paging walks the whole
 * library. The agent's `searchRecipes` is the first page; the MCP
 * `search_recipes` tool pages.
 */
export function searchRecipesPage(
  library: AgentLibrary,
  args: Omit<SearchRecipesArgs, 'limit'>,
  page: { offset?: number; limit?: number },
): { hits: SearchRecipeHit[]; total: number } {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t): t is string => typeof t === 'string')
    : undefined;
  const collectionId =
    typeof args.collectionId === 'string' && args.collectionId !== ''
      ? args.collectionId
      : undefined;
  const maxTotalMinutes =
    typeof args.maxTotalMinutes === 'number' && Number.isFinite(args.maxTotalMinutes)
      ? args.maxTotalMinutes
      : undefined;
  const includeIngredients = Array.isArray(args.includeIngredients)
    ? args.includeIngredients.filter((t): t is string => typeof t === 'string')
    : undefined;
  const excludeIngredients = Array.isArray(args.excludeIngredients)
    ? args.excludeIngredients.filter((t): t is string => typeof t === 'string')
    : undefined;
  const limit = clampLimit(page.limit);
  const offset = clampOffset(page.offset);

  const membership = winningMembership(library.collections);

  type Candidate = { recipe: AgentRecipe; score: number };
  const candidates: Candidate[] = [];

  for (const recipe of library.recipes) {
    if (!passesTags(recipe, tags)) {
      continue;
    }
    if (!passesCollection(recipe, collectionId, membership)) {
      continue;
    }
    if (!passesMaxTotalMinutes(recipe, maxTotalMinutes)) {
      continue;
    }
    if (!passesIncludeIngredients(recipe, includeIngredients)) {
      continue;
    }
    if (!passesExcludeIngredients(recipe, excludeIngredients)) {
      continue;
    }
    const score = scoreRecipe(recipe, query);
    if (query !== '' && score === 0) {
      continue;
    }
    candidates.push({ recipe, score });
  }

  const compareStable = (a: Candidate, b: Candidate) => {
    const titleCmp = a.recipe.title.localeCompare(b.recipe.title, undefined, {
      sensitivity: 'base',
    });
    if (titleCmp !== 0) {
      return titleCmp;
    }
    return a.recipe.id < b.recipe.id ? -1 : a.recipe.id > b.recipe.id ? 1 : 0;
  };

  if (query === '') {
    candidates.sort(compareStable);
  } else {
    candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return compareStable(a, b);
    });
  }

  const hits: SearchRecipeHit[] = [];
  for (const { recipe } of candidates.slice(offset, offset + limit)) {
    const { totalMinutes, timeUnknown } = recipeTotalMinutes(recipe);
    const hit: SearchRecipeHit = {
      id: recipe.id,
      title: recipe.title,
      tags: [...recipe.tags],
      servings: recipe.servings,
      timeUnknown,
      collectionName: library.collectionNameFor(recipe.id),
      snippet: buildSnippet(recipe),
    };
    if (recipe.prepMinutes !== undefined) {
      hit.prepMinutes = recipe.prepMinutes;
    }
    if (recipe.cookMinutes !== undefined) {
      hit.cookMinutes = recipe.cookMinutes;
    }
    if (totalMinutes !== undefined) {
      hit.totalMinutes = totalMinutes;
    }
    hits.push(hit);
  }
  return { hits, total: candidates.length };
}
