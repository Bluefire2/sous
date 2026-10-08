import { describe, expect, it } from 'vitest';
import { hashPublicToken } from './publicLinks.ts';
import {
  mintRecipeLinkRecord,
  newestLiveRecipeLink,
  parseRecipeLinkDoc,
  recipeLinkBody,
  resolveRecipeLink,
  resolveRecipeLinkPhoto,
  type RecipeLinkReadDependencies,
  type RecipeLinkRecord,
} from './recipeLinks.ts';

const token = 'T'.repeat(43);
const recipeId = '22222222-2222-4222-8222-222222222222';
const photoId = '55555555-5555-4555-8555-555555555555';

function link(overrides: Partial<RecipeLinkRecord> = {}): RecipeLinkRecord {
  return {
    ownerSub: 'owner',
    ownerEmail: 'owner@example.com',
    ownerName: 'Ada',
    recipeId,
    token,
    status: 'live',
    createdAt: 10,
    ...overrides,
  };
}

const recipe = {
  id: recipeId,
  title: 'Soup',
  servings: 2,
  ingredientSections: [],
  steps: [],
  tags: [],
  photoId,
  createdAt: 1,
  updatedAt: 2,
};

function deps(overrides: Partial<RecipeLinkReadDependencies> = {}): RecipeLinkReadDependencies {
  return {
    readRecipeLink: async (id) => (id === hashPublicToken(token) ? link() : null),
    ownerAdmitted: async () => true,
    readRecipe: async () => recipe,
    ...overrides,
  };
}

describe('parseRecipeLinkDoc', () => {
  it('round-trips a minted record', () => {
    const { id, record } = mintRecipeLinkRecord(
      { ownerSub: 'owner', ownerEmail: 'o@example.com', ownerName: '  Ada  ', recipeId },
      5,
    );
    expect(id).toBe(hashPublicToken(record.token));
    expect(record.ownerName).toBe('Ada');
    expect(parseRecipeLinkDoc(record)).toEqual(record);
  });

  it('omits a blank display name', () => {
    const { record } = mintRecipeLinkRecord(
      { ownerSub: 'owner', ownerEmail: 'o@example.com', ownerName: ' ', recipeId },
      5,
    );
    expect(record).not.toHaveProperty('ownerName');
  });

  it('rejects malformed docs', () => {
    for (const raw of [
      null,
      [],
      { ...link(), ownerSub: '' },
      { ...link(), ownerEmail: 4 },
      { ...link(), recipeId: 'r1' },
      { ...link(), token: 'short' },
      { ...link(), status: 'paused' },
      { ...link(), createdAt: 0 },
    ]) {
      expect(parseRecipeLinkDoc(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('keeps revokedAt on a revoked link', () => {
    expect(parseRecipeLinkDoc({ ...link(), status: 'revoked', revokedAt: 11 })).toMatchObject({
      status: 'revoked',
      revokedAt: 11,
    });
  });
});

describe('newestLiveRecipeLink', () => {
  it('picks the newest live row', () => {
    const older = link({ createdAt: 1 });
    const newer = link({ createdAt: 2 });
    const revoked = link({ createdAt: 3, status: 'revoked' });
    expect(newestLiveRecipeLink([older, null, revoked, newer])).toBe(newer);
    expect(newestLiveRecipeLink([revoked])).toBeNull();
  });
});

describe('recipeLinkBody', () => {
  it('sends the name, never the email, and strips owner-only fields', () => {
    const body = recipeLinkBody(link(), {
      ...recipe,
      variantOf: '99999999-9999-4999-8999-999999999999',
      savedFrom: { name: 'Eve', savedAt: 1 },
      serverUpdatedAt: 3,
    });
    expect(body.kind).toBe('recipe');
    expect(body.sharedBy).toBe('Ada');
    expect(body.recipe).not.toHaveProperty('variantOf');
    expect(body.recipe).not.toHaveProperty('savedFrom');
    expect(body.recipe).not.toHaveProperty('serverUpdatedAt');
    expect(JSON.stringify(body)).not.toContain('owner@example.com');
    const { ownerName: _ignored, ...nameless } = link();
    expect(recipeLinkBody(nameless, recipe)).not.toHaveProperty('sharedBy');
  });
});

describe('resolveRecipeLink', () => {
  it('resolves a live chain', async () => {
    expect(await resolveRecipeLink(token, deps())).toEqual({ link: link(), recipe });
  });

  it('is null for every broken link in the chain', async () => {
    const cases: Array<[string, Partial<RecipeLinkReadDependencies>]> = [
      ['unknown', { readRecipeLink: async () => null }],
      ['revoked', { readRecipeLink: async () => link({ status: 'revoked' }) }],
      ['token mismatch', { readRecipeLink: async () => link({ token: 'U'.repeat(43) }) }],
      ['owner not admitted', { ownerAdmitted: async () => false }],
      ['recipe missing', { readRecipe: async () => undefined }],
      ['recipe deleted', { readRecipe: async () => ({ ...recipe, deletedAt: 3 }) }],
      ['recipe id mismatch', { readRecipe: async () => ({ ...recipe, id: photoId }) }],
    ];
    for (const [label, overrides] of cases) {
      expect(await resolveRecipeLink(token, deps(overrides)), label).toBeNull();
    }
    expect(await resolveRecipeLink('bad', deps())).toBeNull();
  });

  it('throws when membership is unknown', async () => {
    await expect(
      resolveRecipeLink(
        token,
        deps({
          ownerAdmitted: async () => {
            throw new Error('unavailable');
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('resolveRecipeLinkPhoto', () => {
  it("allows only the link recipe's listed photos", async () => {
    expect(await resolveRecipeLinkPhoto({ token, recipeId, photoId }, deps())).toEqual({
      ownerSub: 'owner',
    });
    expect(
      await resolveRecipeLinkPhoto(
        { token, recipeId: '77777777-7777-4777-8777-777777777777', photoId },
        deps(),
      ),
    ).toBeNull();
    expect(
      await resolveRecipeLinkPhoto(
        { token, recipeId, photoId: '66666666-6666-4666-8666-666666666666' },
        deps(),
      ),
    ).toBeNull();
    expect(
      await resolveRecipeLinkPhoto(
        { token, recipeId, photoId },
        deps({ readRecipeLink: async () => null }),
      ),
    ).toBeNull();
  });
});
