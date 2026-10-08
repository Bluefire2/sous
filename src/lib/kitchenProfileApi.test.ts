import { afterEach, describe, expect, it, vi } from 'vitest';
import * as server from '../../server/kitchenProfile.ts';
import { t } from '../i18n';
import {
  ALLERGENS,
  DIETS,
  EMPTY_KITCHEN_PROFILE,
  MAX_KITCHEN_TEXT_CHARS,
  fetchKitchenProfile,
  parseKitchenProfile,
  saveKitchenProfile,
  type KitchenProfile,
} from './kitchenProfileApi';
import * as session from './session';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const PROFILE: KitchenProfile = {
  allergens: ['peanuts'],
  diets: ['vegan'],
  avoid: 'cilantro',
  dislikes: 'olives',
  equipment: 'No oven',
  notes: 'For two',
};

describe('kitchen profile lists', () => {
  it('match the server’s, in order', () => {
    expect([...ALLERGENS]).toEqual([...server.ALLERGENS]);
    expect([...DIETS]).toEqual([...server.DIETS]);
    expect(MAX_KITCHEN_TEXT_CHARS).toBe(server.MAX_KITCHEN_TEXT_CHARS);
  });
});

describe('parseKitchenProfile', () => {
  it('reads a stored profile and drops what it does not know', () => {
    expect(
      parseKitchenProfile({ profile: { ...PROFILE, allergens: ['peanuts', 'retired'], updatedAt: 5, extra: 1 } }),
    ).toEqual(PROFILE);
  });

  it('is the empty profile when none is saved', () => {
    expect(parseKitchenProfile({ profile: null })).toEqual(EMPTY_KITCHEN_PROFILE);
  });

  it('refuses a body that is not a profile', () => {
    expect(parseKitchenProfile(null)).toBeNull();
    expect(parseKitchenProfile({})).toBeNull();
    expect(parseKitchenProfile({ profile: [] })).toBeNull();
    expect(parseKitchenProfile({ profile: 'x' })).toBeNull();
  });
});

describe('fetchKitchenProfile', () => {
  it('reads the profile', async () => {
    const fetchMock = respond(200, { profile: { ...PROFILE, updatedAt: 1 } });
    expect(await fetchKitchenProfile()).toEqual(PROFILE);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/settings/kitchen');
  });

  it('signs out on 401', async () => {
    const invalidate = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, { error: 'Unauthorized' });
    await expect(fetchKitchenProfile()).rejects.toThrow(t('error.sessionExpired'));
    expect(invalidate).toHaveBeenCalled();
  });

  it('fails on 503 or a body that is not a profile, without signing out', async () => {
    const invalidate = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(503, { error: 'Store unavailable' });
    await expect(fetchKitchenProfile()).rejects.toThrow();
    respond(200, { nope: true });
    await expect(fetchKitchenProfile()).rejects.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('saveKitchenProfile', () => {
  it('posts the whole profile and returns what was stored', async () => {
    const fetchMock = respond(200, { profile: { ...PROFILE, updatedAt: 1 } });
    expect(await saveKitchenProfile(PROFILE)).toEqual(PROFILE);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/settings/kitchen');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(PROFILE);
  });

  it('fails on 400 and signs out on 401', async () => {
    const invalidate = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(400, { error: 'Bad request', code: 'kitchen-profile-bad-request' });
    await expect(saveKitchenProfile(PROFILE)).rejects.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
    respond(401, {});
    await expect(saveKitchenProfile(PROFILE)).rejects.toThrow(t('error.sessionExpired'));
    expect(invalidate).toHaveBeenCalled();
  });
});
