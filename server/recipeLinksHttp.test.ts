import { describe, expect, it, vi } from 'vitest';
import type { RequireMemberResult } from './membership.ts';
import type { RecipeLinkRecord } from './recipeLinks.ts';
import {
  handleRecipeLinkGet,
  handleRecipeLinkPost,
  handleRecipeLinkRevokePost,
  recipeIdFromPublicPath,
  type RecipeLinkOwnerDependencies,
} from './recipeLinksHttp.ts';

const ORIGIN = 'https://sous.example';
const recipeId = '22222222-2222-4222-8222-222222222222';
const token = 'O'.repeat(43);
const now = 1_700_000_000_000;

const member: RequireMemberResult = {
  kind: 'ok',
  sub: 'owner',
  email: 'owner@example.com',
  isOwner: false,
};

function link(): RecipeLinkRecord {
  return {
    ownerSub: 'owner',
    ownerEmail: 'owner@example.com',
    recipeId,
    token,
    status: 'live',
    createdAt: 1,
  };
}

function deps(overrides: Partial<RecipeLinkOwnerDependencies> = {}) {
  const ensure = vi.fn<RecipeLinkOwnerDependencies['ensure']>(async () => ({
    kind: 'ok',
    link: link(),
  }));
  const revoke = vi.fn(async (_sub: string, _id: string, _now: number) => {});
  const all: RecipeLinkOwnerDependencies = {
    requireMember: async () => member,
    readRecipe: async () => ({ id: recipeId, title: 'Soup' }),
    readOwnerName: async () => 'Ada',
    read: async () => null,
    ensure,
    revoke,
    origin: () => ORIGIN,
    now: () => now,
    ...overrides,
  };
  return { deps: all, ensure, revoke };
}

function req(path: string, method = 'GET'): Request {
  return new Request(`${ORIGIN}${path}`, { method });
}

const path = `/api/recipes/${recipeId}/public`;

describe('recipeIdFromPublicPath', () => {
  it('reads the recipe id from either route and nothing else', () => {
    expect(recipeIdFromPublicPath(path)).toBe(recipeId);
    expect(recipeIdFromPublicPath(`${path}/revoke`)).toBe(recipeId);
    expect(recipeIdFromPublicPath('/api/recipes/r1/public')).toBeNull();
    expect(recipeIdFromPublicPath(`${path}/other`)).toBeNull();
  });
});

describe('recipe link owner routes', () => {
  it('reads the link url, or null when off', async () => {
    const off = await handleRecipeLinkGet(req(path), deps().deps);
    expect(await off.json()).toEqual({ url: null });
    const on = await handleRecipeLinkGet(req(path), deps({ read: async () => link() }).deps);
    expect(await on.json()).toEqual({ url: `${ORIGIN}/p/${token}` });
  });

  it("turns the link on with the owner's display name", async () => {
    const { deps: d, ensure } = deps();
    const res = await handleRecipeLinkPost(req(path, 'POST'), d);
    expect(await res.json()).toEqual({ url: `${ORIGIN}/p/${token}` });
    expect(ensure).toHaveBeenCalledWith(
      { ownerSub: 'owner', ownerEmail: 'owner@example.com', ownerName: 'Ada', recipeId },
      now,
    );
  });

  it('turns the link off', async () => {
    const { deps: d, revoke } = deps();
    const res = await handleRecipeLinkRevokePost(req(`${path}/revoke`, 'POST'), d);
    expect(await res.json()).toEqual({ url: null });
    expect(revoke).toHaveBeenCalledWith('owner', recipeId, now);
  });

  it('answers 404 for a recipe the session does not own, or a deleted one', async () => {
    for (const readRecipe of [async () => undefined, async () => ({ id: recipeId, deletedAt: 3 })]) {
      const { deps: d, ensure } = deps({ readRecipe });
      const res = await handleRecipeLinkPost(req(path, 'POST'), d);
      expect(res.status).toBe(404);
      expect(ensure).not.toHaveBeenCalled();
    }
    const missing = await handleRecipeLinkPost(
      req(path, 'POST'),
      deps({ ensure: async () => ({ kind: 'recipeMissing' }) }).deps,
    );
    expect(missing.status).toBe(404);
  });

  it('maps session and store failures', async () => {
    expect(
      (await handleRecipeLinkGet(req(path), deps({ requireMember: async () => ({ kind: 'denied' }) }).deps))
        .status,
    ).toBe(401);
    expect(
      (await handleRecipeLinkGet(req(path), deps({ requireMember: async () => ({ kind: 'unknown' }) }).deps))
        .status,
    ).toBe(503);
    expect((await handleRecipeLinkGet(req('/api/recipes/r1/public'), deps().deps)).status).toBe(400);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = async () => {
      throw new Error('down');
    };
    expect(
      (await handleRecipeLinkGet(req(path), deps({ readRecipe: failing }).deps)).status,
    ).toBe(503);
    expect((await handleRecipeLinkGet(req(path), deps({ read: failing }).deps)).status).toBe(503);
    expect(
      (await handleRecipeLinkPost(req(path, 'POST'), deps({ ensure: failing }).deps)).status,
    ).toBe(503);
    expect(
      (await handleRecipeLinkRevokePost(req(`${path}/revoke`, 'POST'), deps({ revoke: failing }).deps))
        .status,
    ).toBe(503);
    spy.mockRestore();
  });
});
