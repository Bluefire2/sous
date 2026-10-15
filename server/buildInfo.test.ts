import { describe, expect, it } from 'vitest';
import { parseBuildInfo } from './buildInfo.ts';

const SHA = '24b1ce7a0d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70';
const unknown = { commit: null, builtAt: null };

describe('parseBuildInfo', () => {
  it('reads what write-build-info.sh writes', () => {
    expect(parseBuildInfo(`{"commit":"${SHA}","builtAt":"2026-10-15T04:09:12Z"}\n`)).toEqual({
      commit: SHA,
      builtAt: '2026-10-15T04:09:12Z',
    });
  });

  it('keeps the dirty marker', () => {
    expect(parseBuildInfo(`{"commit":"${SHA}-dirty","builtAt":"2026-10-15T04:09:12Z"}`).commit).toBe(`${SHA}-dirty`);
  });

  it('is unknown when the file is missing or malformed', () => {
    expect(parseBuildInfo(null)).toEqual(unknown);
    expect(parseBuildInfo('not json')).toEqual(unknown);
    expect(parseBuildInfo('null')).toEqual(unknown);
    expect(parseBuildInfo(`{"commit":"${SHA}"}`)).toEqual(unknown);
    expect(parseBuildInfo('{"commit":"abc","builtAt":"2026-10-15T04:09:12Z"}')).toEqual(unknown);
    expect(parseBuildInfo(`{"commit":"${SHA}","builtAt":"yesterday"}`)).toEqual(unknown);
  });
});
