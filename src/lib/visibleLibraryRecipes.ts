import type { Recipe } from './types';

/**
 * Case-insensitive substring match on the title, a tag, or an ingredient's
 * item or note. Section names ("Sauce", "For the dough") are not searched:
 * they label a part of the recipe rather than name something in it, and the
 * list shows no ingredients that would explain such a match.
 */
function recipeMatches(recipe: Recipe, q: string): boolean {
  const has = (text: string | undefined) =>
    typeof text === 'string' && text.toLowerCase().includes(q);
  return (
    has(recipe.title) ||
    recipe.tags.some((tag) => has(tag)) ||
    (recipe.ingredientSections ?? []).some((section) =>
      (section.items ?? []).some(
        (ingredient) => has(ingredient.item) || has(ingredient.note),
      ),
    )
  );
}

export function visibleLibraryRecipes({
  all,
  scoped,
  query,
  browseAll,
}: {
  all: readonly Recipe[] | undefined;
  scoped: readonly Recipe[] | undefined;
  query: string;
  browseAll: boolean;
}): Recipe[] | undefined {
  if (all === undefined || scoped === undefined) {
    return undefined;
  }
  const source = browseAll ? all : scoped;
  const q = query.trim().toLowerCase();
  if (q === '') {
    return [...source];
  }
  return source.filter((recipe) => recipeMatches(recipe, q));
}
