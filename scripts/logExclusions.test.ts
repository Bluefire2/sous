import { describe, expect, it } from 'vitest';
import {
  LINK_TOKEN_EXCLUSION,
  LINK_TOKEN_URL,
  exclusionsApplied,
  planExclusions,
  type LogExclusion,
} from './logExclusions.ts';
import { isInviteTokenShape } from '../server/invites.ts';

const token = 'aB3_dE6-gH9iJ2kL5mN8pQ1rS4tU7vW0xY3zA6bC9d';

describe('LINK_TOKEN_URL', () => {
  const pattern = new RegExp(LINK_TOKEN_URL);

  it('matches URLs that carry an invite, collection, or public link token', () => {
    expect(isInviteTokenShape(token)).toBe(true);
    for (const url of [
      `https://sous.kyrylo.lol/invite/${token}`,
      `https://sous.kyrylo.lol/c/${token}`,
      `https://sous.kyrylo.lol/c/${token}?x=1`,
      `http://localhost:5173/invite/${token.slice(0, 20)}`,
      `https://sous.kyrylo.lol/p/${token}`,
      `https://sous.kyrylo.lol/p/${token}/r/0b6f3f5e-2a7c-4f1e-9a51-3c8d2b7e4f10`,
      `https://sous.kyrylo.lol/api/public/${token}`,
      `https://sous.kyrylo.lol/api/public/${token}/recipes/x/photos/y`,
    ]) {
      expect(pattern.test(url), url).toBe(true);
    }
  });

  it('leaves token-free pages logged', () => {
    for (const url of [
      'https://sous.kyrylo.lol/c/join',
      'https://sous.kyrylo.lol/invite',
      'https://sous.kyrylo.lol/invite/',
      `https://sous.kyrylo.lol/invite/${token.slice(0, 19)}`,
      `https://sous.kyrylo.lol/collections/${token}`,
      `https://sous.kyrylo.lol/recipe/${token}`,
      `https://sous.kyrylo.lol/api/import?next=/c/${token}`,
      'https://sous.kyrylo.lol/api/public/join',
      'https://sous.kyrylo.lol/p',
      `https://sous.kyrylo.lol/pantry/${token}`,
      `https://sous.kyrylo.lol/api/publicity/${token}`,
    ]) {
      expect(pattern.test(url), url).toBe(false);
    }
  });

  it('checks both the request URL and the Referer, on request lines only', () => {
    expect(LINK_TOKEN_EXCLUSION.filter).toContain('log_id("run.googleapis.com/requests")');
    expect(LINK_TOKEN_EXCLUSION.filter).toContain(`httpRequest.requestUrl=~"${LINK_TOKEN_URL}"`);
    expect(LINK_TOKEN_EXCLUSION.filter).toContain(`httpRequest.referer=~"${LINK_TOKEN_URL}"`);
  });
});

describe('planExclusions', () => {
  const other: LogExclusion = { name: 'other', filter: 'severity<INFO' };

  it('adds the exclusion and keeps the others', () => {
    expect(planExclusions([other])).toEqual({ kind: 'add', next: [other, LINK_TOKEN_EXCLUSION] });
  });

  it('does nothing when it is already in place', () => {
    expect(planExclusions([other, LINK_TOKEN_EXCLUSION])).toEqual({ kind: 'in_place' });
  });

  it('replaces a stale or disabled copy', () => {
    for (const stale of [
      { ...LINK_TOKEN_EXCLUSION, filter: 'old' },
      { ...LINK_TOKEN_EXCLUSION, disabled: true },
    ]) {
      expect(planExclusions([stale, other])).toEqual({
        kind: 'replace',
        next: [other, LINK_TOKEN_EXCLUSION],
      });
    }
  });
});

describe('exclusionsApplied', () => {
  const other: LogExclusion = { name: 'other', filter: 'severity<INFO' };

  it('accepts the exclusion added with the others unchanged', () => {
    expect(exclusionsApplied([other], [other, LINK_TOKEN_EXCLUSION])).toBe(true);
  });

  it('rejects a missing, duplicated, or disabled exclusion, or a lost neighbour', () => {
    expect(exclusionsApplied([other], [other])).toBe(false);
    expect(exclusionsApplied([other], [other, LINK_TOKEN_EXCLUSION, LINK_TOKEN_EXCLUSION])).toBe(
      false,
    );
    expect(exclusionsApplied([other], [other, { ...LINK_TOKEN_EXCLUSION, disabled: true }])).toBe(
      false,
    );
    expect(exclusionsApplied([other], [LINK_TOKEN_EXCLUSION])).toBe(false);
  });
});
