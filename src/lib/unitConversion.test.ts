import { describe, expect, it } from 'vitest';
import * as server from '../../server/accountPreferences.ts';
import { UNIT_SYSTEMS, convertTemperaturesInText, fahrenheitToCelsius, niceWeight, toGrams } from './unitConversion';

describe('UNIT_SYSTEMS', () => {
  it('matches the server’s', () => {
    expect([...UNIT_SYSTEMS]).toEqual([...server.UNIT_SYSTEMS]);
  });
});

describe('toGrams', () => {
  it('knows pounds and ounces in their usual spellings', () => {
    expect(toGrams(1, 'lb')).toBeCloseTo(453.592, 3);
    expect(toGrams(2, 'LBS')).toBeCloseTo(907.185, 3);
    expect(toGrams(1, 'pound')).toBeCloseTo(453.592, 3);
    expect(toGrams(1, ' Pounds ')).toBeCloseTo(453.592, 3);
    expect(toGrams(1, 'oz')).toBeCloseTo(28.3495, 4);
    expect(toGrams(1, 'oz.')).toBeCloseTo(28.3495, 4);
    expect(toGrams(3, 'ounces')).toBeCloseTo(85.0486, 4);
  });

  it('leaves volumes, other units, and nonsense quantities alone', () => {
    for (const unit of ['fl oz', 'cup', 'tbsp', 'g', 'kg', 'piece', 'pinch', undefined]) {
      expect(toGrams(1, unit)).toBeNull();
    }
    expect(toGrams(0, 'lb')).toBeNull();
    expect(toGrams(-1, 'lb')).toBeNull();
    expect(toGrams(Number.NaN, 'lb')).toBeNull();
  });
});

describe('niceWeight', () => {
  const show = (quantity: number, unit: string) => {
    const weight = niceWeight(toGrams(quantity, unit) ?? Number.NaN);
    return `${weight.value} ${weight.unit}`;
  };

  it('picks the roundest amount within 5%', () => {
    expect(show(1, 'oz')).toBe('28 g'); // 30 g would be 5.8% off
    expect(show(4, 'oz')).toBe('110 g');
    expect(show(8, 'oz')).toBe('225 g');
    expect(show(12, 'oz')).toBe('350 g');
    expect(show(14, 'oz')).toBe('400 g');
    expect(show(1, 'lb')).toBe('450 g');
    expect(show(1.5, 'lb')).toBe('700 g');
    expect(show(2, 'lb')).toBe('900 g');
    expect(show(3, 'lb')).toBe('1.4 kg');
    expect(show(5, 'lb')).toBe('2.25 kg');
  });

  it('keeps small amounts honest with tenths', () => {
    expect(show(1 / 8, 'oz')).toBe('3.5 g');
    expect(show(0.25, 'oz')).toBe('7 g');
    expect(niceWeight(0.01)).toEqual({ value: 0.1, unit: 'g' });
  });

  it('switches to kg on the rounded value', () => {
    expect(niceWeight(998)).toEqual({ value: 1, unit: 'kg' });
    expect(niceWeight(960)).toEqual({ value: 1, unit: 'kg' });
    expect(niceWeight(920)).toEqual({ value: 900, unit: 'g' });
  });

  it('converts a scaled quantity, not a doubled conversion', () => {
    expect(show(1 * 2, 'lb')).toBe('900 g');
    expect(show((1 / 3) * 2, 'lb')).toBe('300 g');
  });
});

describe('fahrenheitToCelsius', () => {
  it('rounds oven settings to the nearest 10', () => {
    expect([250, 300, 325, 350, 375, 400, 425, 450, 475, 500].map((f) => fahrenheitToCelsius(f, true))).toEqual([
      120, 150, 160, 180, 190, 200, 220, 230, 250, 260,
    ]);
  });

  it('rounds everything else to the degree, including oil and sugar at oven-like numbers', () => {
    expect(fahrenheitToCelsius(165)).toBe(74);
    expect(fahrenheitToCelsius(235)).toBe(113);
    expect(fahrenheitToCelsius(250)).toBe(121);
    expect(fahrenheitToCelsius(275)).toBe(135);
    expect(fahrenheitToCelsius(350)).toBe(177);
    expect(fahrenheitToCelsius(360, true)).toBe(182);
    expect(fahrenheitToCelsius(98.6)).toBe(37);
    expect(fahrenheitToCelsius(-10)).toBe(-23);
    expect(Object.is(fahrenheitToCelsius(32.5), 0)).toBe(true);
  });
});

describe('convertTemperaturesInText', () => {
  const convert = (text: string) => convertTemperaturesInText(text, (celsius, original) => `${celsius} (${original})`);

  it('converts the ways recipes write Fahrenheit', () => {
    expect(convert('Preheat the oven to 350°F.')).toBe('Preheat the oven to 180°C (350°F).');
    expect(convert('Bake at 375 °F for 20 minutes')).toBe('Bake at 190°C (375 °F) for 20 minutes');
    expect(convert('Heat the oven to 400ºF')).toBe('Heat the oven to 200°C (400ºF)');
    expect(convert('Heat the oven to 400˚ F')).toBe('Heat the oven to 200°C (400˚ F)');
    expect(convert('Roast at 425℉')).toBe('Roast at 220°C (425℉)');
    expect(convert('Set the oven to 350 degrees F.')).toBe('Set the oven to 180°C (350 degrees F).');
    expect(convert('Set the oven to 300 degrees Fahrenheit')).toBe('Set the oven to 150°C (300 degrees Fahrenheit)');
    expect(convert('Bake at 350 deg. F')).toBe('Bake at 180°C (350 deg. F)');
    expect(convert('Bake at 350 °f')).toBe('Bake at 180°C (350 °f)');
    expect(convert('Bake in a 375°F oven.')).toBe('Bake in a 190°C (375°F) oven.');
    expect(convert('Fry at 350F.')).toBe('Fry at 177°C (350F).');
    expect(convert('Chill to -10°F')).toBe('Chill to -23°C (-10°F)');
    expect(convert('Cook to 165\u00a0°F inside')).toBe('Cook to 74°C (165\u00a0°F) inside');
  });

  it('keeps exact degrees for oil and sugar, rounding only oven settings', () => {
    expect(convert('Heat the oil to 350°F.')).toBe('Heat the oil to 177°C (350°F).');
    expect(convert('Boil the syrup to 275°F (soft crack).')).toBe('Boil the syrup to 135°C (275°F) (soft crack).');
  });

  it('converts a range as one temperature, however it is joined', () => {
    expect(convert('Bake at 325–350°F.')).toBe('Bake at 160–180°C (325–350°F).');
    expect(convert('Fry at 350-375 °F')).toBe('Fry at 177–191°C (350-375 °F)');
    expect(convert('Bake at 325 to 350 degrees F.')).toBe('Bake at 160–180°C (325 to 350 degrees F).');
    expect(convert('Heat the oil to between 350 and 375°F.')).toBe('Heat the oil to between 177–191°C (350 and 375°F).');
    expect(convert('Bake at 325/350°F.')).toBe('Bake at 160–180°C (325/350°F).');
  });

  it('converts every temperature in the text', () => {
    expect(convert('Roast at 450°F, then lower to 350°F.')).toBe('Roast at 230°C (450°F), then lower to 180°C (350°F).');
  });

  it('leaves a temperature that already has Celsius near it', () => {
    for (const text of [
      'Bake at 425°F / 220°C until golden.',
      'Preheat the oven to 300°F (150°C).',
      'Preheat the oven to 180°C/350°F.',
      'Preheat to 180C/350F.',
      '烤箱预热至350°F（175°C）。',
      'Heat to 350 degrees F (175 degrees C).',
      'Bake at 350°F — about 180 degrees C.',
    ]) {
      expect(convert(text)).toBe(text);
    }
  });

  it('leaves what is not clearly Fahrenheit', () => {
    for (const text of [
      'Bake at 350° for 8-10 minutes.',
      'Preheat oven to 350 degrees.',
      'Bake 20-25 minutes.',
      'Bake 10 to 15 minutes.',
      'Use a 9x13-inch pan.',
      'Use 2 cups of flour, about 8F worth.',
      'Use a 12F probe.',
      'dough heated to 80F',
      'Model X350F oven',
      'Add 1 tbsp. Fold gently.',
    ]) {
      expect(convert(text)).toBe(text);
    }
  });
});
