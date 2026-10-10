import { wrapTaggedJson } from '../harness/taggedJson.ts';
import type { ToolSpec } from '../harness/types.ts';
import type { AgentLibrary, AgentRecipe } from './library.ts';
import { winningMembership } from './library.ts';
import { combineIngredients } from './ingredients.ts';
import { searchRecipes, type SearchRecipesArgs } from './search.ts';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Wrap untrusted library JSON so a value cannot close the delimiter early. */
export function wrapLibraryData(value: unknown): string {
  return wrapTaggedJson('library_data', value);
}

export function stripRecipeForAgent(recipe: AgentRecipe): Record<string, unknown> {
  return {
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    servings: recipe.servings,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    ingredientSections: recipe.ingredientSections,
    steps: recipe.steps,
    notes: recipe.notes,
    tags: recipe.tags,
  };
}

/** `metric`: the member reads in metric, so combined pounds and ounces come back in grams. */
export function dataTools(_library: AgentLibrary, options: { metric?: boolean } = {}): ToolSpec<AgentLibrary>[] {
  return [
    {
      name: 'search_recipes',
      description: 'Search the user recipe library by query, tags, collection, time, and ingredients.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search query' },
          tags: { type: 'array', items: { type: 'string' }, description: 'All tags must match' },
          collectionId: {
            type: 'string',
            description: 'Collection id, or unfiled for recipes not in any collection',
          },
          maxTotalMinutes: { type: 'number', description: 'Maximum total cook time in minutes' },
          includeIngredients: {
            type: 'array',
            items: { type: 'string' },
            description: 'Each term must appear in an ingredient',
          },
          excludeIngredients: {
            type: 'array',
            items: { type: 'string' },
            description: 'None of these terms may appear in ingredients',
          },
          limit: { type: 'integer', description: 'Max hits (default 10, max 20)' },
        },
      },
      run: async (args, ctx, signal) => {
        if (signal.aborted) {
          return { error: 'aborted' };
        }
        if (args !== undefined && !isPlainObject(args)) {
          return { error: 'invalid arguments' };
        }
        const hits = searchRecipes(ctx, (args ?? {}) as SearchRecipesArgs);
        return { output: wrapLibraryData({ hits }) };
      },
    },
    {
      name: 'get_recipes',
      description: 'Fetch full recipe details for up to 8 ids.',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8,
            description: 'Recipe ids to fetch',
          },
        },
        required: ['ids'],
      },
      run: async (args, ctx, signal) => {
        if (signal.aborted) {
          return { error: 'aborted' };
        }
        if (!isPlainObject(args)) {
          return { error: 'invalid arguments' };
        }
        const idsRaw = args.ids;
        if (!Array.isArray(idsRaw)) {
          return { error: 'ids required' };
        }
        const ids: string[] = [];
        for (const id of idsRaw) {
          if (typeof id !== 'string') {
            return { error: 'invalid id' };
          }
          ids.push(id);
        }
        if (ids.length > 8) {
          return { error: 'at most 8 ids' };
        }
        const recipes: Record<string, unknown>[] = [];
        const missingIds: string[] = [];
        for (const id of ids) {
          const recipe = ctx.recipeById(id);
          if (!recipe) {
            missingIds.push(id);
            continue;
          }
          recipes.push(stripRecipeForAgent(recipe));
        }
        const output: Record<string, unknown> = { recipes };
        if (missingIds.length > 0) {
          output.missingIds = missingIds;
        }
        return { output: wrapLibraryData(output) };
      },
    },
    {
      name: 'list_collections',
      description: 'List named collections with recipe counts, plus Unfiled when applicable.',
      parameters: { type: 'object', properties: {} },
      run: async (_args, ctx, signal) => {
        if (signal.aborted) {
          return { error: 'aborted' };
        }
        const membership = winningMembership(ctx.collections);
        const counts = new Map<string, number>();
        for (const recipe of ctx.recipes) {
          const collectionId = membership.get(recipe.id);
          if (collectionId) {
            counts.set(collectionId, (counts.get(collectionId) ?? 0) + 1);
          }
        }
        const collections = ctx.collections.map((c) => ({
          id: c.id,
          name: c.name,
          recipeCount: counts.get(c.id) ?? 0,
        }));
        const unfiledCount = ctx.recipes.filter((r) => !membership.has(r.id)).length;
        if (unfiledCount > 0) {
          collections.push({ id: 'unfiled', name: 'Unfiled', recipeCount: unfiledCount });
        }
        return { output: wrapLibraryData({ collections }) };
      },
    },
    {
      name: 'combine_ingredients',
      description: 'Merge and scale ingredient lines across recipes.',
      parameters: {
        type: 'object',
        properties: {
          recipes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                servings: { type: 'number' },
              },
              required: ['id'],
            },
          },
        },
        required: ['recipes'],
      },
      run: async (args, ctx, signal) => {
        if (signal.aborted) {
          return { error: 'aborted' };
        }
        if (!isPlainObject(args)) {
          return { error: 'invalid arguments' };
        }
        const recipesRaw = args.recipes;
        if (!Array.isArray(recipesRaw)) {
          return { error: 'recipes required' };
        }
        const refs: { id: string; servings?: number }[] = [];
        for (const entry of recipesRaw) {
          if (!isPlainObject(entry)) {
            return { error: 'invalid recipe entry' };
          }
          const id = typeof entry.id === 'string' ? entry.id : undefined;
          if (!id) {
            return { error: 'recipe id required' };
          }
          const servings = readNumber(entry, 'servings');
          if (servings !== undefined) {
            refs.push({ id, servings });
          } else {
            refs.push({ id });
          }
        }
        const result = combineIngredients(ctx, refs, { metric: options.metric === true });
        return { output: wrapLibraryData(result) };
      },
    },
  ];
}
