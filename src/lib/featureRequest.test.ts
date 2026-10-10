import { describe, expect, it } from 'vitest';
import { buildFeatureRequest, canSendFeatureRequest } from './featureRequest';

const ID = '00000000-0000-4000-8000-000000000000';

describe('canSendFeatureRequest', () => {
  it('needs text after trimming', () => {
    expect(canSendFeatureRequest('')).toBe(false);
    expect(canSendFeatureRequest('  \n ')).toBe(false);
    expect(canSendFeatureRequest(' x ')).toBe(true);
  });
});

describe('buildFeatureRequest', () => {
  it('trims the text and keeps the context', () => {
    expect(
      buildFeatureRequest({
        id: ID,
        text: '  Meal plans\n',
        contactOk: true,
        from: 'library',
        locale: 'uk',
        standalone: false,
      }),
    ).toStrictEqual({
      id: ID,
      text: 'Meal plans',
      contactOk: true,
      from: 'library',
      locale: 'uk',
      standalone: false,
    });
  });

  it('caps the text at 4000', () => {
    const body = buildFeatureRequest({
      id: ID,
      text: 'a'.repeat(4500),
      contactOk: false,
      locale: 'en',
      standalone: true,
    });
    expect(body.text.length).toBe(4000);
  });

  it('drops an unknown or missing from', () => {
    for (const from of ['header', undefined, null, 3]) {
      const body = buildFeatureRequest({ id: ID, text: 'x', contactOk: false, from, locale: 'en', standalone: false });
      expect('from' in body).toBe(false);
    }
  });
});
