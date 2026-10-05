import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleIntroGet, handleIntroSeenPost, type IntroDependencies } from './intro.ts';
import type { RequireMemberResult } from './membership.ts';

const member: RequireMemberResult = { kind: 'ok', sub: 'sub-1', email: 'a@example.com', isOwner: false };

function dependencies(
  access: RequireMemberResult,
  overrides: Partial<IntroDependencies> = {},
): { deps: IntroDependencies; calls: string[] } {
  const calls: string[] = [];
  const deps: IntroDependencies = {
    requireMember: async () => access,
    readSeen: async (sub) => {
      calls.push(`read:${sub}`);
      return false;
    },
    markSeen: async (sub, profile, now) => {
      calls.push(`mark:${sub}:${profile.email}:${now}`);
    },
    now: () => 1234,
    ...overrides,
  };
  return { deps, calls };
}

const get = () => new Request('http://localhost/api/intro');
const post = () => new Request('http://localhost/api/intro/seen', { method: 'POST' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleIntroGet', () => {
  it('answers seen for the session sub, uncached', async () => {
    const { deps, calls } = dependencies(member, { readSeen: async () => true });
    const response = await handleIntroGet(get(), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ seen: true });
    expect(calls).toEqual([]);

    const unseen = dependencies(member);
    const second = await handleIntroGet(get(), unseen.deps);
    expect(await second.json()).toEqual({ seen: false });
    expect(unseen.calls).toEqual(['read:sub-1']);
  });

  it('is 401 when denied and 503 when membership is unknown, without reading', async () => {
    const denied = dependencies({ kind: 'denied' });
    expect((await handleIntroGet(get(), denied.deps)).status).toBe(401);
    const unknown = dependencies({ kind: 'unknown' });
    expect((await handleIntroGet(get(), unknown.deps)).status).toBe(503);
    expect([...denied.calls, ...unknown.calls]).toEqual([]);
  });

  it('is 503 when the store fails, and logs no message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = Object.assign(new Error('secret detail'), { code: 14 });
    const { deps } = dependencies(member, {
      readSeen: async () => {
        throw failure;
      },
    });
    expect((await handleIntroGet(get(), deps)).status).toBe(503);
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret detail');
  });
});

describe('handleIntroSeenPost', () => {
  it('marks the session sub as seen, passing the session email for a missing profile, and answers 204', async () => {
    const { deps, calls } = dependencies(member);
    const response = await handleIntroSeenPost(post(), deps);
    expect(response.status).toBe(204);
    expect(calls).toEqual(['mark:sub-1:a@example.com:1234']);
  });

  it('is 401 when denied and 503 when membership is unknown, without writing', async () => {
    const denied = dependencies({ kind: 'denied' });
    expect((await handleIntroSeenPost(post(), denied.deps)).status).toBe(401);
    const unknown = dependencies({ kind: 'unknown' });
    expect((await handleIntroSeenPost(post(), unknown.deps)).status).toBe(503);
    expect([...denied.calls, ...unknown.calls]).toEqual([]);
  });

  it('is 503 when the store fails, and logs no message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = dependencies(member, {
      markSeen: async () => {
        throw new Error('secret detail');
      },
    });
    expect((await handleIntroSeenPost(post(), deps)).status).toBe(503);
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret detail');
  });
});
