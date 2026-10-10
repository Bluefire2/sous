import type { CardSpec } from '../../harness/types.ts';
import type { AgentLibrary } from '../library.ts';

export type ShoppingListData = {
  title: string;
  recipes: { id: string; title: string; servings: number }[];
  sections: {
    name: string;
    items: {
      key: string;
      item: string;
      quantity?: number;
      unit?: string;
      note?: string;
      optional?: true;
      recipeIds: string[];
    }[];
  }[];
};

const KEY_PATTERN = /^[a-z0-9_-]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeShoppingList(
  args: unknown,
  ctx: AgentLibrary,
): { ok: true; data: ShoppingListData } | { ok: false; error: string } {
  if (!isPlainObject(args)) {
    return { ok: false, error: 'invalid payload' };
  }
  const titleRaw = args.title;
  if (typeof titleRaw !== 'string' || titleRaw.trim() === '') {
    return { ok: false, error: 'title required' };
  }
  const title = titleRaw.trim();
  if (title.length > 120) {
    return { ok: false, error: 'title too long' };
  }

  const recipesRaw = args.recipes;
  if (!Array.isArray(recipesRaw) || recipesRaw.length < 1 || recipesRaw.length > 12) {
    return { ok: false, error: 'recipes must be 1–12' };
  }
  const recipes: ShoppingListData['recipes'] = [];
  const allowedRecipeIds = new Set<string>();
  for (const entry of recipesRaw) {
    if (!isPlainObject(entry)) {
      return { ok: false, error: 'invalid recipe' };
    }
    const id = entry.id;
    if (typeof id !== 'string' || id === '') {
      return { ok: false, error: 'recipe id required' };
    }
    const libRecipe = ctx.recipeById(id);
    if (!libRecipe) {
      return { ok: false, error: 'unknown recipe id' };
    }
    let servings = libRecipe.servings;
    if (entry.servings !== undefined) {
      if (typeof entry.servings !== 'number' || !Number.isFinite(entry.servings) || entry.servings <= 0) {
        return { ok: false, error: 'invalid servings' };
      }
      servings = entry.servings;
    }
    recipes.push({ id, title: libRecipe.title, servings });
    allowedRecipeIds.add(id);
  }

  const sectionsRaw = args.sections;
  if (!Array.isArray(sectionsRaw) || sectionsRaw.length < 1 || sectionsRaw.length > 12) {
    return { ok: false, error: 'sections must be 1–12' };
  }
  const sections: ShoppingListData['sections'] = [];
  const seenKeys = new Set<string>();
  let itemCount = 0;
  for (const sectionEntry of sectionsRaw) {
    if (!isPlainObject(sectionEntry)) {
      return { ok: false, error: 'invalid section' };
    }
    const name =
      typeof sectionEntry.name === 'string' && sectionEntry.name.trim() !== ''
        ? sectionEntry.name.trim()
        : '';
    if (name === '') {
      return { ok: false, error: 'section name required' };
    }
    const itemsRaw = sectionEntry.items;
    if (!Array.isArray(itemsRaw)) {
      return { ok: false, error: 'section items required' };
    }
    const items: ShoppingListData['sections'][number]['items'] = [];
    for (const itemEntry of itemsRaw) {
      if (!isPlainObject(itemEntry)) {
        return { ok: false, error: 'invalid item' };
      }
      itemCount += 1;
      if (itemCount > 150) {
        return { ok: false, error: 'too many items' };
      }
      const key = itemEntry.key;
      if (typeof key !== 'string' || key === '' || key.length > 80 || !KEY_PATTERN.test(key)) {
        return { ok: false, error: 'invalid item key' };
      }
      if (seenKeys.has(key)) {
        return { ok: false, error: 'duplicate item key' };
      }
      seenKeys.add(key);
      const itemText = itemEntry.item;
      if (typeof itemText !== 'string' || itemText.trim() === '') {
        return { ok: false, error: 'item text required' };
      }
      const item = itemText.trim();
      if (item.length > 200) {
        return { ok: false, error: 'item too long' };
      }
      const normalized: ShoppingListData['sections'][number]['items'][number] = {
        key,
        item,
        recipeIds: [],
      };
      if (itemEntry.quantity !== undefined) {
        if (typeof itemEntry.quantity !== 'number' || !Number.isFinite(itemEntry.quantity) || itemEntry.quantity < 0) {
          return { ok: false, error: 'invalid quantity' };
        }
        normalized.quantity = itemEntry.quantity;
      }
      if (itemEntry.unit !== undefined) {
        if (typeof itemEntry.unit !== 'string' || itemEntry.unit.length > 40) {
          return { ok: false, error: 'invalid unit' };
        }
        normalized.unit = itemEntry.unit;
      }
      if (itemEntry.note !== undefined) {
        if (typeof itemEntry.note !== 'string' || itemEntry.note.length > 200) {
          return { ok: false, error: 'invalid note' };
        }
        normalized.note = itemEntry.note;
      }
      if (itemEntry.optional !== undefined) {
        if (typeof itemEntry.optional !== 'boolean') {
          return { ok: false, error: 'invalid optional' };
        }
        if (itemEntry.optional) {
          normalized.optional = true;
        }
      }
      const recipeIdsRaw = itemEntry.recipeIds;
      if (!Array.isArray(recipeIdsRaw)) {
        return { ok: false, error: 'recipeIds required' };
      }
      for (const rid of recipeIdsRaw) {
        if (typeof rid !== 'string' || !allowedRecipeIds.has(rid)) {
          return { ok: false, error: 'invalid recipeIds on item' };
        }
        normalized.recipeIds.push(rid);
      }
      items.push(normalized);
    }
    sections.push({ name, items });
  }

  return { ok: true, data: { title, recipes, sections } };
}

export function shoppingListHistoryText(data: ShoppingListData): string {
  const lines: string[] = [`Shopping list: ${data.title}`];
  for (const section of data.sections) {
    for (const item of section.items) {
      const qty =
        item.quantity !== undefined
          ? `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`
          : 'as needed';
      const recipes = item.recipeIds.join(', ');
      const optional = item.optional ? ', optional' : '';
      lines.push(`${section.name}: ${item.item} — ${qty}${optional} (${recipes})`);
    }
  }
  return lines.join('\n');
}

export const shoppingListCard: CardSpec<AgentLibrary, ShoppingListData> = {
  type: 'shopping_list',
  version: 1,
  toolName: 'show_shopping_list',
  description: 'Display a grouped shopping list card for selected recipes.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      recipes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            servings: { type: 'number' },
          },
          required: ['id'],
        },
      },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  item: { type: 'string' },
                  quantity: { type: 'number' },
                  unit: { type: 'string' },
                  note: { type: 'string' },
                  optional: { type: 'boolean' },
                  recipeIds: { type: 'array', items: { type: 'string' } },
                },
                required: ['key', 'item', 'recipeIds'],
              },
            },
          },
          required: ['name', 'items'],
        },
      },
    },
    required: ['title', 'recipes', 'sections'],
  },
  rule:
    'Call show_shopping_list whenever the user asks for a shopping or grocery list, after you have called combine_ingredients. ' +
    'Set optional: true on an item whose combined line is optional, and keep it a separate item from a required line of the same ingredient.',
  normalize: normalizeShoppingList,
  historyText: shoppingListHistoryText,
};
