/**
 * What a model call costs, from the usage Gemini reports on its response.
 * Used only by the daily per-member cap in `server/llmBudget.ts`; it is an
 * estimate for a limit, not an invoice.
 *
 * Prices are the Gemini Developer API's Standard paid tier, per 1M tokens in
 * USD, read from https://ai.google.dev/gemini-api/docs/pricing on 2026-10-07.
 * `gemini-3.7-flash` and `gemini-3.8-flash` are listed at half these rates
 * until 2026-12-31; the table uses the rates from 2027-01-01 so the cap does
 * not loosen then. The models Sous does not use by default are listed so a
 * `CHAT_MODEL` or `TRANSLATE_MODEL` change is priced exactly.
 * A price per 1M tokens in USD is also the price per token in micro-USD.
 *
 * Every price errs high: cached input is charged at the full input rate, and
 * the monthly free search allowance is ignored.
 */

export interface ModelPrice {
  /** USD per 1M input tokens (prompt and tool-use prompt). */
  input: number;
  /** USD per 1M output tokens, thinking included. */
  output: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gemini-3.8-flash': { input: 1.5, output: 7.5 },
  'gemini-3.7-flash': { input: 1.5, output: 7.5 },
  'gemini-3.5-flash': { input: 1.5, output: 9 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
};

/** Grounding with Google Search on Gemini 3 models: $14 per 1,000 queries. */
export const SEARCH_QUERY_MICRO_USD = 14_000;

const MOST_EXPENSIVE: ModelPrice = {
  input: Math.max(...Object.values(MODEL_PRICES).map((p) => p.input)),
  output: Math.max(...Object.values(MODEL_PRICES).map((p) => p.output)),
};

/**
 * The listed price, or for a model not in the table (a new `CHAT_MODEL` or
 * `TRANSLATE_MODEL`) the highest rates in it, so changing the model can only
 * make the cap stricter until the table is updated.
 */
export function priceFor(model: string): ModelPrice {
  return Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : MOST_EXPENSIVE;
}

/** The token counts of `GenerateContentResponseUsageMetadata` that are billed. */
export interface UsageCounts {
  promptTokenCount?: number;
  toolUsePromptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function inputTokens(usage: UsageCounts | undefined): number {
  return count(usage?.promptTokenCount) + count(usage?.toolUsePromptTokenCount);
}

export function outputTokens(usage: UsageCounts | undefined): number {
  return count(usage?.candidatesTokenCount) + count(usage?.thoughtsTokenCount);
}

/** Whole micro-USD, rounded up. A missing usage costs only its searches. */
export function costMicroUsd(
  model: string,
  usage: UsageCounts | undefined,
  searchQueries = 0,
): number {
  const price = priceFor(model);
  const tokens = inputTokens(usage) * price.input + outputTokens(usage) * price.output;
  return Math.ceil(tokens + count(searchQueries) * SEARCH_QUERY_MICRO_USD);
}
