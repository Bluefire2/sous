/**
 * What an MCP client sees of a recipe. `version` is the stored `updatedAt`;
 * `update_recipe` must send it back. Photo ids, `importCheck`, `lang`,
 * `variantOf`, and `createdAt` are never included. Pure.
 */
import type { AgentRecipe } from '../agent/index.ts';

export type McpRecipe = {
  id: string;
  version: number;
  title: string;
  description?: string;
  sourceUrl?: string;
  servings: number;
  prepMinutes?: number;
  cookMinutes?: number;
  ingredientSections: AgentRecipe['ingredientSections'];
  steps: AgentRecipe['steps'];
  tags: string[];
  notes?: string;
  /** The collection the app files it under, or "Unfiled". Left out where it was not looked up. */
  collectionName?: string;
};

export function toMcpRecipe(recipe: AgentRecipe, collectionName?: string): McpRecipe {
  // Copied field by field: an AgentRecipe also carries photo ids and createdAt.
  const out: McpRecipe = {
    id: recipe.id,
    version: recipe.updatedAt,
    title: recipe.title,
    servings: recipe.servings,
    ingredientSections: recipe.ingredientSections,
    steps: recipe.steps,
    tags: recipe.tags,
  };
  if (recipe.description !== undefined) out.description = recipe.description;
  if (recipe.sourceUrl !== undefined) out.sourceUrl = recipe.sourceUrl;
  if (recipe.prepMinutes !== undefined) out.prepMinutes = recipe.prepMinutes;
  if (recipe.cookMinutes !== undefined) out.cookMinutes = recipe.cookMinutes;
  if (recipe.notes !== undefined) out.notes = recipe.notes;
  if (collectionName !== undefined) out.collectionName = collectionName;
  return out;
}
