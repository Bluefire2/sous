import { describe, expect, it } from 'vitest';
import {
  buildImportFeedback,
  importFailureDetails,
  includedSummary,
  ratingUp,
  type BuildImportFeedbackInput,
} from './importFeedback';
import type { RecipeDraft } from './types';

const R: RecipeDraft = { title: 'Soup', servings: 2, ingredientSections: [], steps: [], tags: [] };
const ID = '00000000-0000-4000-8000-000000000000';

function build(overrides: Partial<BuildImportFeedbackInput>) {
  return buildImportFeedback({
    id: ID,
    trigger: 'failed',
    source: { via: 'url', url: 'https://example.com/r' },
    locale: 'en',
    ...overrides,
  });
}

describe('importFailureDetails', () => {
  it('returns null for a plain Error', () => {
    expect(importFailureDetails(new Error('x'))).toBeNull();
  });

  it('returns null for 401', () => {
    expect(importFailureDetails(Object.assign(new Error('m'), { status: 401 }))).toBeNull();
  });

  it('returns null for a non-Error', () => {
    expect(importFailureDetails({ status: 500, message: 'm' })).toBeNull();
  });

  it('keeps code, status, siteStatus and message', () => {
    const err = Object.assign(new Error('refused'), {
      code: 'import-refused',
      status: 422,
      siteStatus: 403,
    });
    expect(importFailureDetails(err)).toStrictEqual({
      code: 'import-refused',
      status: 422,
      siteStatus: 403,
      message: 'refused',
    });
  });

  it('drops a bad code and siteStatus', () => {
    const err = Object.assign(new Error('m'), { code: 5, status: 502, siteStatus: 'x' });
    expect(importFailureDetails(err)).toStrictEqual({ status: 502, message: 'm' });
  });

  it('caps the message at 500', () => {
    const err = Object.assign(new Error('a'.repeat(600)), { status: 500 });
    expect(importFailureDetails(err)?.message.length).toBe(500);
  });
});

describe('buildImportFeedback', () => {
  it('builds a url failure', () => {
    expect(
      build({ failure: { code: 'import-no-recipe', status: 422, message: 'm' } }),
    ).toStrictEqual({
      id: ID,
      trigger: 'failed',
      via: 'url',
      url: 'https://example.com/r',
      error: { code: 'import-no-recipe', status: 422, message: 'm' },
      locale: 'en',
    });
  });

  it('builds a paste with warnings', () => {
    const report = build({
      trigger: 'warnings',
      source: { via: 'paste', pastedText: 'Soup\n2 eggs' },
      result: { recipe: R, warnings: [{ code: 'MISSING_INSTRUCTIONS' }], translationFailed: false },
    });
    expect(report.pastedText).toBe('Soup\n2 eggs');
    expect(report.result).toStrictEqual({
      recipeJson: JSON.stringify(R),
      warnings: [{ code: 'MISSING_INSTRUCTIONS' }],
    });
    expect('url' in report).toBe(false);
  });

  it('truncates a long paste', () => {
    const report = build({ source: { via: 'paste', pastedText: 'x'.repeat(150_001) } });
    expect(report.pastedText?.length).toBe(150_000);
    expect(report.pastedTruncated).toBe(true);
  });

  it('sends the brief of a generated recipe as pastedText', () => {
    const report = build({ source: { via: 'generate', pastedText: 'gumbo in a pressure cooker' } });
    expect(report.via).toBe('generate');
    expect(report.pastedText).toBe('gumbo in a pressure cooker');
    expect('photos' in report).toBe(false);
  });

  it('keeps photo notes out', () => {
    const report = build({ source: { via: 'photos', photos: 2, pastedText: 'private notes' } });
    expect(report.photos).toBe(2);
    expect('pastedText' in report).toBe(false);
  });

  it('drops pastedText for a url source', () => {
    const report = build({ source: { via: 'url', url: 'https://example.com/r', pastedText: 'x' } });
    expect('pastedText' in report).toBe(false);
  });

  it('truncates a huge recipe', () => {
    const report = build({ result: { recipe: { ...R, title: 'x'.repeat(250_000) } } });
    expect(new TextEncoder().encode(report.result?.recipeJson).length).toBeLessThanOrEqual(200_000);
    expect(report.result?.recipeTruncated).toBe(true);
  });

  it('trims, drops, and caps the comment', () => {
    expect(build({ comment: '  hi  ' }).comment).toBe('hi');
    expect('comment' in build({ comment: '   ' })).toBe(false);
    expect(build({ comment: 'a'.repeat(2500) }).comment?.length).toBe(2000);
  });

  it('keeps a password in the link out of recipeJson', () => {
    const report = build({
      trigger: 'down',
      source: { via: 'url', url: 'https://user:s3cret@recipes.example/cake?x=1' },
      result: {
        recipe: {
          ...R,
          sourceUrl: 'https://user:s3cret@recipes.example/cake?x=1',
          notes: 'From http://bob:pw@other.example/page',
        },
      },
    });
    expect(report.url).toBe('https://recipes.example/cake?x=1');
    const json = report.result?.recipeJson ?? '';
    expect(json).not.toContain('s3cret');
    expect(json).not.toContain('bob:pw');
    const recipe = JSON.parse(json) as RecipeDraft;
    expect(recipe.sourceUrl).toBe('https://recipes.example/cake?x=1');
    expect(recipe.notes).toBe('From http://other.example/page');
  });

  it('drops a sourceUrl that is not an http(s) link', () => {
    const report = build({ result: { recipe: { ...R, sourceUrl: 'javascript:alert(1)' } } });
    expect('sourceUrl' in (JSON.parse(report.result?.recipeJson ?? '{}') as object)).toBe(false);
  });

  it('drops a bad url', () => {
    expect('url' in build({ source: { via: 'url', url: 'javascript:alert(1)' } })).toBe(false);
  });
});

describe('ratingUp', () => {
  it('sends only trigger, via and a clean url', () => {
    expect(ratingUp({ via: 'url', url: 'https://u:p@example.com/r' })).toStrictEqual({
      trigger: 'up',
      via: 'url',
      url: 'https://example.com/r',
    });
    expect(ratingUp({ via: 'paste', pastedText: 'x' })).toStrictEqual({ trigger: 'up', via: 'paste' });
  });
});

describe('includedSummary', () => {
  it('names the source', () => {
    expect(includedSummary({ via: 'url', url: 'https://example.com/r' })).toStrictEqual({
      kind: 'url',
      url: 'https://example.com/r',
    });
    expect(includedSummary({ via: 'paste', pastedText: 'abc' })).toStrictEqual({
      kind: 'paste',
      preview: 'abc',
      chars: 3,
    });
    expect(includedSummary({ via: 'paste', pastedText: 'y'.repeat(300) })).toStrictEqual({
      kind: 'paste',
      preview: `${'y'.repeat(200)}…`,
      chars: 300,
    });
    expect(includedSummary({ via: 'photos', photos: 1 })).toStrictEqual({ kind: 'photos' });
    expect(includedSummary({ via: 'generate', pastedText: 'gumbo' })).toStrictEqual({
      kind: 'brief',
      preview: 'gumbo',
      chars: 5,
    });
    expect(includedSummary({ via: 'generate' })).toStrictEqual({ kind: 'none' });
    expect(includedSummary({ via: 'url', url: 'nope' })).toStrictEqual({ kind: 'none' });
  });
});
