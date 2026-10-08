import { GenerateContentResponse, type GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LLM_BUDGET_EXCEEDED,
  LLM_BUSY,
  LLM_DAILY_BUDGET_MICRO_USD,
  LLM_MAX_IN_FLIGHT_PER_MEMBER,
  LLM_USAGE_RETENTION_MS,
  admitLlm,
  inFlightForTest,
  llmRefusal,
  memoryLlmUsageStore,
  meteredAi,
  onResponseEnd,
  secondsToUtcMidnight,
  setLlmBudgetForTest,
  utcDayKey,
  withChatBudget,
  type LlmMeter,
  type LlmUsageStore,
} from './llmBudget.ts';
import { SEARCH_QUERY_MICRO_USD, costMicroUsd } from './llmPricing.ts';

const NOON = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = '2026-10-07';

let store: ReturnType<typeof memoryLlmUsageStore>;

beforeEach(() => {
  store = memoryLlmUsageStore();
  setLlmBudgetForTest({ store, now: () => NOON });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setLlmBudgetForTest(null);
  vi.restoreAllMocks();
});

async function admitted(sub = 'sub-1'): Promise<LlmMeter> {
  const admission = await admitLlm(sub, 'import');
  if (admission.kind !== 'ok') throw new Error(`not admitted: ${admission.kind}`);
  return admission.meter;
}

describe('day arithmetic', () => {
  it('keys spend by UTC calendar day', () => {
    expect(utcDayKey(NOON)).toBe(DAY);
    expect(utcDayKey(Date.UTC(2026, 9, 7, 23, 59, 59))).toBe(DAY);
    expect(utcDayKey(Date.UTC(2026, 9, 8, 0, 0, 0))).toBe('2026-10-08');
  });

  it('counts seconds to the next UTC midnight, never 0', () => {
    expect(secondsToUtcMidnight(NOON)).toBe(12 * 60 * 60);
    expect(secondsToUtcMidnight(Date.UTC(2026, 9, 7, 23, 59, 59, 500))).toBe(1);
    expect(secondsToUtcMidnight(Date.UTC(2026, 9, 8))).toBe(24 * 60 * 60);
  });
});

describe('admitLlm', () => {
  it('admits a member under the budget', async () => {
    store.spent.set(`sub-1/${DAY}`, LLM_DAILY_BUDGET_MICRO_USD - 1);
    expect((await admitLlm('sub-1', 'chat')).kind).toBe('ok');
  });

  it('refuses a member at the budget until UTC midnight, and frees the slot', async () => {
    store.spent.set(`sub-1/${DAY}`, LLM_DAILY_BUDGET_MICRO_USD);
    expect(await admitLlm('sub-1', 'chat')).toEqual({ kind: 'over', retryAfterSeconds: 12 * 60 * 60 });
    expect(inFlightForTest('sub-1')).toBe(0);
  });

  it("counts only today's spend", async () => {
    store.spent.set('sub-1/2026-10-06', LLM_DAILY_BUDGET_MICRO_USD * 5);
    expect((await admitLlm('sub-1', 'chat')).kind).toBe('ok');
  });

  it('keeps members apart', async () => {
    store.spent.set(`sub-1/${DAY}`, LLM_DAILY_BUDGET_MICRO_USD);
    expect((await admitLlm('sub-2', 'chat')).kind).toBe('ok');
  });

  it('answers unknown, not a refusal, when the store read fails', async () => {
    const failing: LlmUsageStore = {
      readSpent: () => Promise.reject(new Error('UNAVAILABLE')),
      addSpend: () => Promise.resolve(),
    };
    setLlmBudgetForTest({ store: failing, now: () => NOON });
    expect(await admitLlm('sub-1', 'chat')).toEqual({ kind: 'unknown' });
    expect(inFlightForTest('sub-1')).toBe(0);
  });

  it('allows a fixed number of requests in flight per member, even before the reads finish', async () => {
    const results = await Promise.all(
      Array.from({ length: LLM_MAX_IN_FLIGHT_PER_MEMBER + 2 }, () => admitLlm('sub-1', 'import')),
    );
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(LLM_MAX_IN_FLIGHT_PER_MEMBER);
    expect(results.filter((r) => r.kind === 'busy')).toHaveLength(2);
    expect((await admitLlm('sub-2', 'import')).kind).toBe('ok');
  });

  it('frees a slot on release, once however often it is called', async () => {
    const meters = await Promise.all(
      Array.from({ length: LLM_MAX_IN_FLIGHT_PER_MEMBER }, () => admitted()),
    );
    expect((await admitLlm('sub-1', 'import')).kind).toBe('busy');
    meters[0].release();
    meters[0].release();
    expect(inFlightForTest('sub-1')).toBe(LLM_MAX_IN_FLIGHT_PER_MEMBER - 1);
    const next = await admitLlm('sub-1', 'import');
    expect(next.kind).toBe('ok');
    for (const meter of meters) meter.release();
    if (next.kind === 'ok') next.meter.release();
    expect(inFlightForTest('sub-1')).toBe(0);
  });

  it('logs a refusal with the reason, never more', async () => {
    store.spent.set(`sub-1/${DAY}`, LLM_DAILY_BUDGET_MICRO_USD);
    await admitLlm('sub-1', 'agent');
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'llm_refused', sub: 'sub-1', route: 'agent', reason: 'over' }),
    );
  });
});

describe('meter.charge', () => {
  it("adds the call's cost to today's spend with a TTL date", async () => {
    const addSpend = vi.spyOn(store, 'addSpend');
    const meter = await admitted();
    const usage = { promptTokenCount: 2000, candidatesTokenCount: 500 };
    await meter.charge('gemini-3.7-flash', usage, 1);
    const cost = costMicroUsd('gemini-3.7-flash', usage, 1);
    expect(store.spent.get(`sub-1/${DAY}`)).toBe(cost);
    expect(addSpend).toHaveBeenCalledWith(
      'sub-1',
      DAY,
      cost,
      new Date(Date.UTC(2026, 9, 7) + LLM_USAGE_RETENTION_MS),
    );
  });

  it('refuses the next request once charges reach the budget', async () => {
    const meter = await admitted();
    await meter.charge('gemini-3.7-flash', undefined, Math.ceil(LLM_DAILY_BUDGET_MICRO_USD / SEARCH_QUERY_MICRO_USD));
    meter.release();
    expect((await admitLlm('sub-1', 'chat')).kind).toBe('over');
  });

  it('logs counts and cost, never content', async () => {
    const meter = await admitted();
    await meter.charge('gemini-3.7-flash', { promptTokenCount: 10, thoughtsTokenCount: 4, candidatesTokenCount: 6 });
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({
        event: 'llm',
        sub: 'sub-1',
        route: 'import',
        model: 'gemini-3.7-flash',
        inputTokens: 10,
        outputTokens: 10,
        searchQueries: 0,
        costMicroUsd: costMicroUsd('gemini-3.7-flash', { promptTokenCount: 10, candidatesTokenCount: 10 }),
      }),
    );
  });

  it('swallows a failed write', async () => {
    const failing: LlmUsageStore = {
      readSpent: () => Promise.resolve(0),
      addSpend: () => Promise.reject(new Error('DEADLINE_EXCEEDED quoting things')),
    };
    setLlmBudgetForTest({ store: failing, now: () => NOON });
    const meter = await admitted();
    await expect(meter.charge('gemini-3.7-flash', { promptTokenCount: 1 })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: 'llm_charge_failed', sub: 'sub-1', route: 'import' }),
    );
  });
});

describe('llmRefusal', () => {
  it('answers over-budget with 429, its code, and Retry-After', async () => {
    const res = llmRefusal({ kind: 'over', retryAfterSeconds: 3600 });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ code: LLM_BUDGET_EXCEEDED });
  });

  it('answers busy with 429 and its code', async () => {
    const res = llmRefusal({ kind: 'busy' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(await res.json()).toMatchObject({ code: LLM_BUSY });
  });

  it('answers unknown with 503', () => {
    expect(llmRefusal({ kind: 'unknown' }).status).toBe(503);
  });
});

type Models = Pick<GoogleGenAI['models'], 'generateContent'>;

function fakeAi(response: GenerateContentResponse | Error): { models: Models } {
  return {
    models: {
      generateContent: () =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    },
  };
}

describe('meteredAi', () => {
  it("charges each call's usage and Google's search queries", async () => {
    const response = new GenerateContentResponse();
    response.usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20 };
    response.candidates = [{ groundingMetadata: { webSearchQueries: ['a', 'b'] } }];
    const meter = await admitted();
    const charge = vi.spyOn(meter, 'charge');
    const ai = meteredAi(fakeAi(response), meter);
    const result = await ai.models.generateContent({ model: 'gemini-3.7-flash', contents: 'hi' });
    expect(result).toBe(response);
    expect(charge).toHaveBeenCalledWith('gemini-3.7-flash', response.usageMetadata, 2);
    expect(store.spent.get(`sub-1/${DAY}`)).toBe(costMicroUsd('gemini-3.7-flash', response.usageMetadata, 2));
  });

  it('passes a thrown call through uncharged', async () => {
    const meter = await admitted();
    const charge = vi.spyOn(meter, 'charge');
    const ai = meteredAi(fakeAi(new Error('boom')), meter);
    await expect(ai.models.generateContent({ model: 'm', contents: 'hi' })).rejects.toThrow('boom');
    expect(charge).not.toHaveBeenCalled();
  });
});

describe('onResponseEnd', () => {
  it('runs right away for a response without a body', () => {
    const onEnd = vi.fn();
    onResponseEnd(new Response(null, { status: 204 }), onEnd);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('runs once the body is read to the end, and keeps status and headers', async () => {
    const onEnd = vi.fn();
    const res = onResponseEnd(
      new Response('hello', { status: 201, headers: { 'X-Test': '1' } }),
      onEnd,
    );
    expect(onEnd).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Test')).toBe('1');
    expect(await res.text()).toBe('hello');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('runs when the reader cancels', async () => {
    const onEnd = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const res = onResponseEnd(new Response(source), onEnd);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('runs when the body errors', async () => {
    const onEnd = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('cut'));
      },
    });
    const res = onResponseEnd(new Response(source), onEnd);
    await expect(res.text()).rejects.toThrow();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('withChatBudget', () => {
  const req = () => new Request('http://localhost/api/chat', { method: 'POST', body: '{}' });

  it('refuses before the handler runs', async () => {
    store.spent.set(`sub-1/${DAY}`, LLM_DAILY_BUDGET_MICRO_USD);
    const handler = vi.fn();
    const res = await withChatBudget(handler)(req(), { authorizedSub: 'sub-1' });
    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it('charges what the handler reports and frees the slot when the body ends', async () => {
    const wrapped = withChatBudget(async (_req, ctx) => {
      expect(ctx.authorizedSub).toBe('sub-1');
      ctx.onUsage('gemini-3.7-flash', { promptTokenCount: 1000 });
      return new Response('reply');
    });
    const res = await wrapped(req(), { authorizedSub: 'sub-1' });
    expect(inFlightForTest('sub-1')).toBe(1);
    await res.text();
    expect(inFlightForTest('sub-1')).toBe(0);
    await vi.waitFor(() => expect(store.spent.get(`sub-1/${DAY}`)).toBe(1500));
  });

  it('frees the slot when the handler throws', async () => {
    const wrapped = withChatBudget(() => Promise.reject(new Error('boom')));
    await expect(wrapped(req(), { authorizedSub: 'sub-1' })).rejects.toThrow('boom');
    expect(inFlightForTest('sub-1')).toBe(0);
  });
});
