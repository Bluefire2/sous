import { describe, expect, it } from 'vitest';
import type { AgentRecipe } from '../agent/index.ts';
import { toMcpRecipe } from './recipeView.ts';

// A schema lock, like the one on Recipe in src/lib/recipeStore.test.ts: what an
// MCP client sees is exactly these keys. Do not fix a failure by widening the
// list; a new field reaches a connected AI app only by a deliberate change.
const ALL_KEYS = [
  'collectionName',
  'cookMinutes',
  'description',
  'id',
  'ingredientSections',
  'notes',
  'prepMinutes',
  'servings',
  'sourceUrl',
  'steps',
  'tags',
  'title',
  'version',
];

const full: AgentRecipe = {
  id: 'r1',
  title: 'Soup',
  description: 'Warm',
  sourceUrl: 'https://example.com/soup',
  servings: 4,
  prepMinutes: 10,
  cookMinutes: 30,
  ingredientSections: [{ items: [{ item: 'salt' }] }],
  steps: [{ text: 'Cook.' }],
  tags: ['dinner'],
  notes: 'Good.',
  photoId: '11111111-1111-4111-8111-111111111111',
  galleryPhotoIds: ['22222222-2222-4222-8222-222222222222'],
  createdAt: 100,
  updatedAt: 200,
};

describe('toMcpRecipe', () => {
  it('returns exactly the client keys, with updatedAt as the version', () => {
    const view = toMcpRecipe(full, 'Weeknights');
    expect(Object.keys(view).sort()).toEqual(ALL_KEYS);
    expect(view.version).toBe(200);
    expect(view.collectionName).toBe('Weeknights');
  });

  it('never carries photo ids, createdAt, or fields a loaded row may still hold', () => {
    // A stored row can carry lang, variantOf, and importCheck beside the agent fields.
    const stored = { ...full, lang: 'uk', variantOf: 'r0', importCheck: { warnings: [] }, deletedAt: 1 } as AgentRecipe;
    const view = toMcpRecipe(stored) as Record<string, unknown>;
    for (const key of ['photoId', 'galleryPhotoIds', 'createdAt', 'updatedAt', 'lang', 'variantOf', 'importCheck', 'deletedAt']) {
      expect(view, key).not.toHaveProperty(key);
    }
  });

  it('omits optional fields that are absent instead of sending undefined', () => {
    const minimal: AgentRecipe = {
      id: 'r2',
      title: 'Toast',
      servings: 1,
      ingredientSections: [],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 2,
    };
    expect(Object.keys(toMcpRecipe(minimal)).sort()).toEqual([
      'id',
      'ingredientSections',
      'servings',
      'steps',
      'tags',
      'title',
      'version',
    ]);
  });
});
