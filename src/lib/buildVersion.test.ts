import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBuildVersion, parseBuildVersion, shortCommit } from './buildVersion';

const SHA = '24b1ce74f9ab83ae45ac80d1070dee31417555b3';

describe('parseBuildVersion', () => {
  it('reads a known build', () => {
    expect(parseBuildVersion({ commit: SHA, builtAt: '2026-10-15T04:19:41Z' })).toEqual({
      commit: SHA,
      builtAt: Date.UTC(2026, 9, 15, 4, 19, 41),
    });
  });

  it('is null for an unknown build or a body that is not one', () => {
    expect(parseBuildVersion({ commit: null, builtAt: null })).toBeNull();
    expect(parseBuildVersion({ commit: SHA, builtAt: 'later' })).toBeNull();
    expect(parseBuildVersion({ commit: '', builtAt: '2026-10-15T04:19:41Z' })).toBeNull();
    expect(parseBuildVersion(null)).toBeNull();
    expect(parseBuildVersion('build')).toBeNull();
  });
});

describe('shortCommit', () => {
  it('keeps seven characters and the dirty marker', () => {
    expect(shortCommit(SHA)).toBe('24b1ce7');
    expect(shortCommit(`${SHA}-dirty`)).toBe('24b1ce7-dirty');
  });
});

describe('fetchBuildVersion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the version route', async () => {
    const fetchMock = vi.fn(async () => Response.json({ commit: SHA, builtAt: '2026-10-15T04:19:41Z' }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchBuildVersion())?.commit).toBe(SHA);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/version', { cache: 'no-store' }]);
  });

  it('is null on an error status or a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    expect(await fetchBuildVersion()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect(await fetchBuildVersion()).toBeNull();
  });
});
