import type { Locale, MessageKey, TranslateParams } from '../i18n';
import { unitLabel } from '../i18n/unitLabel';
import { formatQuantity } from './quantity';
import type { Ingredient, Recipe } from './types';

/** `t()` for one UI language, as `useT()` returns it. */
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

/**
 * The source is whatever the user pasted on import, so it is only ever linked
 * after it turns out to be an ordinary web address.
 */
export function sourceLink(url: string | undefined): URL | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One ingredient as "quantity unit item (note)", the quantity multiplied by
 * `scale`. Known unit tokens get their label in the UI language; a custom unit
 * is recipe text and stays as typed.
 */
export function ingredientLine(ing: Ingredient, scale: number, locale: Locale, t: Translate): string {
  const parts = [
    ing.quantity !== undefined ? formatQuantity(ing.quantity * scale, locale) : null,
    ing.unit ? unitLabel(ing.unit, t) : null,
    ing.item,
  ].filter(Boolean);
  const base = parts.join(' ');
  return ing.note ? `${base} (${ing.note})` : base;
}

/**
 * A recipe as plain text, for the share sheet or the clipboard: title,
 * servings, ingredients by section, numbered steps, notes and the source.
 * Quantities are at the recipe's own servings, not a cook's scaled count.
 * The headings are UI text in the UI language; everything else is the
 * stored recipe (`docs/constitutions/i18n.md` principle 1: share gets the
 * stored recipe, never a display translation).
 */
export function recipeToText(recipe: Recipe, locale: Locale, t: Translate): string {
  const blocks: string[][] = [];

  const head = [recipe.title];
  if (Number.isFinite(recipe.servings) && recipe.servings > 0) {
    head.push(t('common.servingsCount', { count: recipe.servings }));
  }
  blocks.push(head);

  const sections = recipe.ingredientSections.filter((section) => section.items.length > 0);
  if (sections.length > 0) {
    const lines = [t('common.ingredients')];
    sections.forEach((section, i) => {
      if (i > 0) lines.push('');
      if (section.name) lines.push(section.name);
      for (const ing of section.items) {
        lines.push(`- ${ingredientLine(ing, 1, locale, t)}`);
      }
    });
    blocks.push(lines);
  }

  if (recipe.steps.length > 0) {
    blocks.push([t('common.steps'), ...recipe.steps.map((step, i) => `${i + 1}. ${step.text}`)]);
  }

  const notes = recipe.notes?.trim();
  if (notes) {
    blocks.push([t('common.notes'), notes]);
  }

  const source = sourceLink(recipe.sourceUrl);
  if (source !== undefined) {
    blocks.push([t('recipe.source', { source: source.href })]);
  }

  return blocks.map((lines) => lines.join('\n')).join('\n\n');
}
