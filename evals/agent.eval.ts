import { beforeAll, describe, expect, it } from 'vitest';
import { defaultAgentLimits } from '../server/agent/harness/limits.ts';
import { googleModel } from '../server/agent/harness/google.ts';
import { startAgent } from '../server/agent/harness/run.ts';
import type { AgentEvent } from '../server/agent/harness/types.ts';
import { CARD_SPECS } from '../server/agent/sous/cards/index.ts';
import type { CollectionCreateData } from '../server/agent/sous/cards/collectionCreate.ts';
import type { CollectionMoveData } from '../server/agent/sous/cards/collectionMove.ts';
import type { ShoppingListData } from '../server/agent/sous/cards/shoppingList.ts';
import { buildAgentLibrary, type AgentRecipe } from '../server/agent/sous/library.ts';
import { buildSystemPrompt } from '../server/agent/sous/prompt.ts';
import { dataTools } from '../server/agent/sous/tools.ts';

const INDEX_LIMITS = { maxIndexEntries: 500, maxIndexChars: 40_000 };

const RECIPE_SKILLET = 'eval-skillet-chicken';
const RECIPE_BRAISE = 'eval-oven-braise';
const RECIPE_SOUP = 'eval-stovetop-soup';
const RECIPE_SIDE = 'eval-green-salad';

function recipe(overrides: Partial<AgentRecipe> & { id: string; title: string }): AgentRecipe {
  return {
    servings: 4,
    ingredientSections: [{ items: [{ item: 'salt' }] }],
    steps: [{ text: 'Cook' }],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fixtureLibrary() {
  return buildAgentLibrary(
    [
      recipe({
        id: RECIPE_SKILLET,
        title: 'Skillet lemon chicken',
        prepMinutes: 10,
        cookMinutes: 10,
        tags: ['quick', 'skillet', 'weeknight'],
        ingredientSections: [
          {
            items: [
              { quantity: 4, unit: 'piece', item: 'chicken thighs' },
              { quantity: 2, unit: 'tbsp', item: 'olive oil' },
              { quantity: 1, unit: 'piece', item: 'lemon' },
            ],
          },
        ],
        steps: [
          { text: 'Season the chicken.' },
          { text: 'Sear in a hot skillet until cooked through, about 10 minutes.' },
        ],
      }),
      recipe({
        id: RECIPE_BRAISE,
        title: 'Red wine braised short ribs',
        prepMinutes: 30,
        cookMinutes: 90,
        tags: ['braise', 'slow', 'oven'],
        ingredientSections: [
          {
            items: [
              { quantity: 2, unit: 'lb', item: 'beef short ribs' },
              { quantity: 1, unit: 'cup', item: 'red wine' },
            ],
          },
        ],
        steps: [
          { text: 'Brown the ribs on the stovetop.' },
          { text: 'Transfer to a 325°F oven and braise until tender, about 2 hours.' },
        ],
      }),
      recipe({
        id: RECIPE_SOUP,
        title: 'Tomato basil soup',
        prepMinutes: 15,
        cookMinutes: 30,
        tags: ['soup', 'stovetop', 'vegetarian'],
        ingredientSections: [
          {
            items: [
              { quantity: 2, unit: 'can', item: 'crushed tomatoes' },
              { quantity: 1, unit: 'cup', item: 'vegetable broth' },
              { quantity: 0.25, unit: 'cup', item: 'fresh basil' },
            ],
          },
        ],
        steps: [
          { text: 'Simmer tomatoes and broth in a pot for 25 minutes.' },
          { text: 'Blend smooth and stir in basil. No oven needed.' },
        ],
      }),
      recipe({
        id: RECIPE_SIDE,
        title: 'Simple green salad',
        prepMinutes: 10,
        cookMinutes: 0,
        tags: ['side', 'salad', 'quick'],
        ingredientSections: [
          {
            items: [
              { quantity: 6, unit: 'cup', item: 'mixed greens' },
              { quantity: 2, unit: 'tbsp', item: 'vinaigrette' },
            ],
          },
        ],
        steps: [{ text: 'Toss greens with vinaigrette and serve.' }],
      }),
    ],
    [{ id: 'eval-weeknight', name: 'Weeknight', recipeIds: [RECIPE_SIDE] }],
    { truncated: false, ...INDEX_LIMITS },
  );
}

function toolStarts(events: AgentEvent[]): string[] {
  return events
    .filter((e): e is Extract<AgentEvent, { t: 'tool' }> => e.t === 'tool' && e.phase === 'start')
    .map((e) => e.name);
}

function assistantText(events: AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { t: 'text' }> => e.t === 'text')
    .map((e) => e.d)
    .join('');
}

async function runLibraryAssistant(userText: string): Promise<AgentEvent[]> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY missing in runLibraryAssistant');
  }
  const library = fixtureLibrary();
  const modelName = process.env.CHAT_MODEL || 'gemini-3.8-flash';
  const signal = AbortSignal.timeout(90_000);

  const agentRun = await startAgent({
    model: googleModel({ apiKey, model: modelName }),
    systemInstruction: buildSystemPrompt({
      library,
      clientNow: new Date().toISOString(),
      timeZone: 'UTC',
      cards: CARD_SPECS,
    }),
    messages: [{ role: 'user', text: userText }],
    tools: dataTools(library),
    cards: CARD_SPECS,
    ctx: library,
    limits: defaultAgentLimits(),
    signal,
  });

  const events: AgentEvent[] = [];
  await agentRun.run((event) => {
    events.push(event);
  });
  return events;
}

describe('library assistant (live Gemini)', () => {
  beforeAll(() => {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new Error(
        'GEMINI_API_KEY is required for npm run test:import. Put it in .env.local (same as dev:api).',
      );
    }
  });

  it(
    'compares recipes for a short stovetop dinner using library read tools',
    async () => {
      const events = await runLibraryAssistant(
        'I have about 30 minutes tonight and no oven. Compare the recipes and tell me which to cook.',
      );

      const started = toolStarts(events);
      expect(
        started.some((name) => name === 'search_recipes' || name === 'get_recipes'),
        `expected search_recipes or get_recipes, got: ${started.join(', ')}`,
      ).toBe(true);

      expect(assistantText(events).trim().length).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    'emits a shopping_list card for two named recipe ids',
    async () => {
      const events = await runLibraryAssistant(
        `Make me a shopping list for ${RECIPE_SKILLET} and ${RECIPE_SOUP}.`,
      );

      const shoppingCards = events.filter(
        (e): e is Extract<AgentEvent, { t: 'card' }> =>
          e.t === 'card' && e.card.type === 'shopping_list',
      );
      expect(shoppingCards.length).toBeGreaterThan(0);

      const data = shoppingCards[0]!.card.data as ShoppingListData;
      const ids = data.recipes.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([RECIPE_SKILLET, RECIPE_SOUP]));
      expect(ids.length).toBeGreaterThanOrEqual(2);
    },
    60_000,
  );

  it(
    'proposes moving every recipe into the Weeknight collection',
    async () => {
      const events = await runLibraryAssistant(
        'Move all my recipes into the Weeknight collection.',
      );

      const moveCards = events.filter(
        (e): e is Extract<AgentEvent, { t: 'card' }> =>
          e.t === 'card' && e.card.type === 'collection_move',
      );
      expect(moveCards.length).toBeGreaterThan(0);

      const data = moveCards[0]!.card.data as CollectionMoveData;
      expect(data.destination).toEqual({
        kind: 'collection',
        id: 'eval-weeknight',
        name: 'Weeknight',
      });
    },
    60_000,
  );

  it(
    'proposes a new Soups collection that already contains the soup recipe',
    async () => {
      const events = await runLibraryAssistant(
        `Create a collection named Soups and put ${RECIPE_SOUP} in it.`,
      );

      const createCards = events.filter(
        (e): e is Extract<AgentEvent, { t: 'card' }> =>
          e.t === 'card' && e.card.type === 'collection_create',
      );
      expect(createCards.length).toBeGreaterThan(0);

      const data = createCards[0]!.card.data as CollectionCreateData;
      expect(data.name).toBe('Soups');
      expect(data.recipeIds).toContain(RECIPE_SOUP);
    },
    60_000,
  );
});
