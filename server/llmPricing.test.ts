import { describe, expect, it } from 'vitest';
import { MODEL_PRICES, SEARCH_QUERY_MICRO_USD, costMicroUsd, priceFor } from './llmPricing.ts';

describe('priceFor', () => {
  it('uses the listed price for a known model', () => {
    expect(priceFor('gemini-3.5-flash-lite')).toEqual(MODEL_PRICES['gemini-3.5-flash-lite']);
  });

  it('lists every Flash model a CHAT_MODEL change could pick, at its 2027 rates', () => {
    expect(priceFor('gemini-3.8-flash')).toEqual({ input: 1.5, output: 7.5 });
    expect(priceFor('gemini-3.7-flash')).toEqual({ input: 1.5, output: 7.5 });
    expect(priceFor('gemini-3.5-flash')).toEqual({ input: 1.5, output: 9 });
  });

  it('prices an unknown model at the highest listed rates', () => {
    const inputs = Object.values(MODEL_PRICES).map((p) => p.input);
    const outputs = Object.values(MODEL_PRICES).map((p) => p.output);
    expect(priceFor('gemini-9-ultra')).toEqual({ input: Math.max(...inputs), output: Math.max(...outputs) });
  });

  it('does not treat an inherited property name as a model', () => {
    expect(priceFor('toString')).toEqual(priceFor('gemini-9-ultra'));
  });
});

describe('costMicroUsd', () => {
  it('prices input and output tokens, thinking and tool prompts included', () => {
    // gemini-3.7-flash: $1.50 in, $7.50 out per 1M tokens = micro-USD per token.
    const cost = costMicroUsd('gemini-3.7-flash', {
      promptTokenCount: 1000,
      toolUsePromptTokenCount: 200,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 300,
    });
    expect(cost).toBe(1200 * 1.5 + 400 * 7.5);
  });

  it('adds each search query', () => {
    expect(costMicroUsd('gemini-3.7-flash', undefined, 3)).toBe(3 * SEARCH_QUERY_MICRO_USD);
  });

  it('rounds up to a whole micro-USD', () => {
    expect(costMicroUsd('gemini-3.5-flash-lite', { promptTokenCount: 1 })).toBe(1);
  });

  it('ignores missing, negative, and non-numeric counts', () => {
    expect(
      costMicroUsd('gemini-3.7-flash', {
        promptTokenCount: -5,
        candidatesTokenCount: Number.NaN,
      }),
    ).toBe(0);
    expect(costMicroUsd('gemini-3.7-flash', undefined)).toBe(0);
  });
});
