import { describe, expect, it } from 'vitest';
import { COMMON_UNITS } from '../lib/units';
import { CATALOGS, translate, type MessageKey } from './index';
import { unitLabel } from './unitLabel';

describe('unitLabel', () => {
  it('labels every common unit from its catalog key, in every language', () => {
    for (const locale of Object.keys(CATALOGS) as (keyof typeof CATALOGS)[]) {
      const tr = (key: MessageKey) => translate(locale, key);
      for (const unit of COMMON_UNITS) {
        expect(unitLabel(unit, tr), `${locale} ${unit}`).toBe(translate(locale, `unit.${unit}` as MessageKey));
      }
    }
  });

  it('asks for exactly the unit.<token> key', () => {
    const asked: string[] = [];
    unitLabel('tbsp', (key) => {
      asked.push(key);
      return 'x';
    });
    expect(asked).toEqual(['unit.tbsp']);
  });

  it('returns a custom unit as typed, without a lookup', () => {
    const tr = () => {
      throw new Error('a custom unit is recipe text, not catalog text');
    };
    for (const custom of ['pinch', 'зубчик', '', 'Tbsp', 'cups']) {
      expect(unitLabel(custom, tr)).toBe(custom);
    }
  });
});
