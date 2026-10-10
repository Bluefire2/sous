import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAgentLibrary, type AgentRecipe } from '../server/agent/sous/library.ts';
import {
  MAX_COLLECTION_RECIPE_IDS as SERVER_MAX_IDS,
  MAX_NAMED_COLLECTIONS as SERVER_MAX_NAMED_COLLECTIONS,
} from '../server/store.ts';
import {
  COLLECTION_CREATE_MAX_EXPLICIT_IDS as SERVER_CREATE_MAX_IDS,
  COLLECTION_CREATE_NAME_MAX as SERVER_CREATE_NAME_MAX,
  COLLECTION_CREATE_PREVIEW_LIMIT as SERVER_CREATE_PREVIEW_LIMIT,
  COLLECTION_CREATE_TITLE_MAX as SERVER_CREATE_TITLE_MAX,
  normalizeCollectionCreate,
} from '../server/agent/sous/cards/collectionCreate.ts';
import {
  COLLECTION_MOVE_PREVIEW_LIMIT as SERVER_PREVIEW_LIMIT,
  COLLECTION_MOVE_TITLE_MAX as SERVER_TITLE_MAX,
  normalizeCollectionMove,
} from '../server/agent/sous/cards/collectionMove.ts';
import { normalizeShoppingList } from '../server/agent/sous/cards/shoppingList.ts';
import {
  MAX_COLLECTION_NAME_LENGTH,
  MAX_COLLECTION_RECIPE_IDS as CLIENT_MAX_IDS,
  MAX_NAMED_COLLECTIONS,
} from '../src/lib/compactCollection.ts';
import {
  COLLECTION_CREATE_MAX_EXPLICIT_IDS,
  COLLECTION_CREATE_NAME_MAX,
  COLLECTION_CREATE_PREVIEW_LIMIT,
  COLLECTION_CREATE_TITLE_MAX,
  COLLECTION_MOVE_MAX_IDS,
  COLLECTION_MOVE_PREVIEW_LIMIT,
  COLLECTION_MOVE_TITLE_MAX,
  parseCollectionCreate,
  parseCollectionMove,
  parseShoppingList,
} from '../src/agent/cards/parse.ts';

type FixtureCase =
  | { ok: true; args: unknown; expect: unknown }
  | { ok: false; args: unknown };

type Fixture = { cases: FixtureCase[] };

const shoppingFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/agent-cards/shopping_list.v1.json',
);

const collectionMoveFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/agent-cards/collection_move.v1.json',
);

const collectionCreateFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/agent-cards/collection_create.v1.json',
);

function testLibrary(): ReturnType<typeof buildAgentLibrary> {
  const recipes: AgentRecipe[] = [
    {
      id: 'r1',
      title: 'Library title',
      servings: 4,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'r2',
      title: 'Second recipe',
      servings: 2,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  return buildAgentLibrary(recipes, [{ id: 'c-weeknight', name: 'Weeknight', recipeIds: ['r2'] }], {
    truncated: false,
    maxIndexEntries: 500,
    maxIndexChars: 40_000,
  });
}

describe('shopping_list card contract', () => {
  it('matches server normalize and client parse on fixtures', () => {
    const fixture = JSON.parse(readFileSync(shoppingFixturePath, 'utf8')) as Fixture;
    const ctx = testLibrary();
    for (const c of fixture.cases) {
      if (c.ok) {
        const result = normalizeShoppingList(c.args, ctx);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          continue;
        }
        expect(result.data).toEqual(c.expect);
        const parsed = parseShoppingList(1, result.data);
        expect(parsed).toEqual(result.data);
      } else {
        const normalized = normalizeShoppingList(c.args, ctx);
        const parsedRaw = parseShoppingList(1, c.args);
        expect(normalized.ok === false || parsedRaw === undefined).toBe(true);
      }
    }
  });
});

describe('collection_move card contract', () => {
  it('matches server normalize and client parse on fixtures', () => {
    const fixture = JSON.parse(readFileSync(collectionMoveFixturePath, 'utf8')) as Fixture;
    const ctx = testLibrary();
    for (const c of fixture.cases) {
      if (c.ok) {
        const result = normalizeCollectionMove(c.args, ctx);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          continue;
        }
        expect(result.data).toEqual(c.expect);
        const parsed = parseCollectionMove(1, result.data);
        expect(parsed).toEqual(result.data);
      } else {
        const normalized = normalizeCollectionMove(c.args, ctx);
        const parsedRaw = parseCollectionMove(1, c.args);
        expect(normalized.ok === false || parsedRaw === undefined).toBe(true);
      }
    }
  });

  it('rejects duplicate recipe ids', () => {
    const parsed = parseCollectionMove(1, {
      destination: { kind: 'unfiled' },
      recipeIds: ['r1', 'r1'],
      sources: [
        { id: 'r1', from: { kind: 'unfiled' } },
        { id: 'r1', from: { kind: 'unfiled' } },
      ],
      preview: [],
      total: 2,
    });
    expect(parsed).toBeUndefined();
  });

  it('shares the move caps with the server card and the collection limit', () => {
    expect(COLLECTION_MOVE_PREVIEW_LIMIT).toBe(SERVER_PREVIEW_LIMIT);
    expect(COLLECTION_MOVE_TITLE_MAX).toBe(SERVER_TITLE_MAX);
    expect(COLLECTION_MOVE_MAX_IDS).toBe(CLIENT_MAX_IDS);
    expect(COLLECTION_MOVE_MAX_IDS).toBe(SERVER_MAX_IDS);
  });
});

describe('collection_create card contract', () => {
  it('matches server normalize and client parse on fixtures', () => {
    const fixture = JSON.parse(readFileSync(collectionCreateFixturePath, 'utf8')) as Fixture;
    const ctx = testLibrary();
    for (const c of fixture.cases) {
      if (c.ok) {
        const result = normalizeCollectionCreate(c.args, ctx);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          continue;
        }
        expect(result.data).toEqual(c.expect);
        const parsed = parseCollectionCreate(1, result.data);
        expect(parsed).toEqual(result.data);
      } else {
        const normalized = normalizeCollectionCreate(c.args, ctx);
        const parsedRaw = parseCollectionCreate(1, c.args);
        expect(normalized.ok === false || parsedRaw === undefined).toBe(true);
      }
    }
  });

  it('rejects duplicate recipe ids on the client card', () => {
    const parsed = parseCollectionCreate(1, {
      name: 'Soups',
      recipeIds: ['r1', 'r1'],
      sources: [
        { id: 'r1', from: { kind: 'unfiled' } },
        { id: 'r1', from: { kind: 'unfiled' } },
      ],
      preview: [],
      total: 2,
    });
    expect(parsed).toBeUndefined();
  });

  it('shares the create caps with the server card and the collection limits', () => {
    expect(COLLECTION_CREATE_PREVIEW_LIMIT).toBe(SERVER_CREATE_PREVIEW_LIMIT);
    expect(COLLECTION_CREATE_TITLE_MAX).toBe(SERVER_CREATE_TITLE_MAX);
    expect(COLLECTION_CREATE_NAME_MAX).toBe(SERVER_CREATE_NAME_MAX);
    expect(COLLECTION_CREATE_NAME_MAX).toBe(MAX_COLLECTION_NAME_LENGTH);
    expect(COLLECTION_CREATE_MAX_EXPLICIT_IDS).toBe(SERVER_CREATE_MAX_IDS);
    expect(SERVER_MAX_NAMED_COLLECTIONS).toBe(MAX_NAMED_COLLECTIONS);
    expect(CLIENT_MAX_IDS).toBe(SERVER_MAX_IDS);
  });
});
