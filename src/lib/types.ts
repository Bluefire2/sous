import type { ImportCheck } from './importCheck';

export interface Ingredient {
  quantity?: number;
  unit?: string;
  item: string;
  note?: string;
}

export interface IngredientSection {
  /** Optional section name like "Sauce" or "Dough"; omitted for single-section recipes. */
  name?: string;
  items: Ingredient[];
}

export interface RecipeStep {
  text: string;
  /**
   * Who does this step when two people cook, such as "Sauce". Consecutive
   * steps with a lane run at the same time; a step without one is done by
   * everyone, in order. Missing is normal (`docs/plans/parallel-steps.md`).
   */
  lane?: string;
}

export interface Recipe {
  id: string;
  title: string;
  description?: string;
  sourceUrl?: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  ingredientSections: IngredientSection[];
  steps: RecipeStep[];
  tags: string[];
  notes?: string;
  /** Cover photo FK into the photos table. Library cards and the recipe header use this. */
  photoId?: string;
  /** Secondary photo FKs, shown as a gallery at the end of the recipe. */
  galleryPhotoIds?: string[];
  /**
   * BCP 47 language of the recipe text, when known. Missing is normal;
   * code must keep working without it (`docs/constitutions/i18n.md`).
   */
  lang?: string;
  /**
   * What the import check found, when an import raised warnings. Missing is
   * normal (a clean import, a hand-written recipe, an older client); code
   * must keep working without it (`docs/plans/import-reliability.md`).
   */
  importCheck?: ImportCheck;
  /**
   * Id of the original this recipe is a variant of, shared by every variant
   * of it, so they group as equals. Set only when the variant is created and
   * never edited. Missing is normal, and the original may be gone or someone
   * else's (`docs/plans/recipe-variants.md`).
   */
  variantOf?: string;
  createdAt: number;
  updatedAt: number;
}

/** A named folder of recipes. Unfiled recipes live in the implicit default collection. */
export interface Collection {
  id: string;
  name: string;
  recipeIds: string[];
  createdAt: number;
  updatedAt: number;
}

/** A recipe as produced by extraction/modification, before it gets identity. */
export type RecipeDraft = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;

export interface ChatMessage {
  id: string;
  recipeId: string;
  role: 'user' | 'assistant';
  content: string;
  /** FKs into the photos table for attached images. */
  photoIds?: string[];
  /** Set when the assistant proposed a recipe modification via update_recipe. */
  proposedRecipe?: RecipeDraft;
  createdAt: number;
}

/** One row per recipe. `Set` is not JSON, hence `string[]`. */
export interface CookStateRow {
  recipeId: string;
  servings: number;
  /** Every step before this index is done. */
  currentStep: number;
  /**
   * Steps at or after `currentStep` that are done anyway, because two lanes
   * of a block run at the same time. Sorted, never containing `currentStep`.
   * Absent on old rows and when empty (`docs/plans/parallel-steps.md`).
   */
  doneSteps?: number[];
  checkedKeys: string[];
  /** Recipe revision this progress was recorded against. Not the progress-write clock. */
  recipeUpdatedAt: number;
  /**
   * Client time of this progress write. Absent on old rows. Not the recipe
   * revision.
   */
  updatedAt?: number;
}

/** One time a recipe was cooked. Its own store kind; never fields on `Recipe`. */
export interface CookLog {
  id: string;
  recipeId: string;
  /** `YYYY-MM-DD`, the local calendar date the user entered. Not a timestamp. */
  cookedOn: string;
  /** Integer 1-5. */
  rating?: number;
  servings?: number;
  /** How it went, substitutions. */
  notes?: string;
  /** What to do next time; the only field that can be promoted into recipe notes. */
  lessons?: string;
  /** FKs into the photos table, owned by `recipeId`. */
  photoIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Photo {
  id: string;
  blob: Blob;
  createdAt: number;
}
