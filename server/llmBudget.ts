/**
 * A daily cap on what each member's model calls cost (`docs/plans/llm-budget.md`).
 *
 * Every route that calls Gemini admits the request with `admitLlm` after
 * auth and body checks and before the first model call, charges each call's
 * reported usage to the returned meter, and releases the meter when the
 * request is done. Spend is summed per member per UTC day in Firestore
 * (`users/{sub}/llmUsage/{YYYY-MM-DD}`), so the cap holds across instances
 * and restarts. Admission only reads; the charge comes after the call, from
 * the real usage. To bound how far parallel requests can overshoot, each
 * member may have only `LLM_MAX_IN_FLIGHT_PER_MEMBER` metered requests
 * running per instance.
 *
 * Over the cap is 429 `llm-budget-exceeded` until UTC midnight; too many at
 * once is 429 `llm-busy`; a failed read is 503 (unknown, never a refusal).
 * A failed charge is logged and never fails the request.
 *
 * Logs: one `event: 'llm'` line per charged call (sub, route, model, token
 * counts, searches, cost) and one `event: 'llm_refused'` line per refusal.
 * Never the prompt, the reply, or an error message.
 */
import { FieldValue } from '@google-cloud/firestore';
import type { GoogleGenAI } from '@google/genai';
import { costMicroUsd, inputTokens, outputTokens, type UsageCounts } from './llmPricing.ts';
import type { MembershipHandlerContext } from './membership.ts';
import { getStoreFirestore } from './store.ts';

/** $10 per member per UTC day. A code constant, not an env var. */
export const LLM_DAILY_BUDGET_MICRO_USD = 10_000_000;
/** Metered requests one member may have running at once, per instance. */
export const LLM_MAX_IN_FLIGHT_PER_MEMBER = 2;
/** Day docs carry `expireAt` this long after their day starts, for a TTL policy. */
export const LLM_USAGE_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export const LLM_USAGE_COLLECTION = 'llmUsage';

export const LLM_BUDGET_EXCEEDED = 'llm-budget-exceeded';
export const LLM_BUSY = 'llm-busy';

export type LlmRoute = 'chat' | 'agent' | 'import' | 'extension_import' | 'translate' | 'stt';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of `now`, `YYYY-MM-DD`. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Whole seconds until the next UTC midnight, at least 1. */
export function secondsToUtcMidnight(now: number): number {
  const next = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  return Math.max(1, Math.ceil((next - now) / 1000));
}

export function overBudget(spentMicroUsd: number, budget = LLM_DAILY_BUDGET_MICRO_USD): boolean {
  return spentMicroUsd >= budget;
}

export interface LlmUsageStore {
  /** Micro-USD charged to `sub` on `day`; 0 when there is no doc. Throws on a store failure. */
  readSpent(sub: string, day: string): Promise<number>;
  addSpend(sub: string, day: string, microUsd: number, expireAt: Date): Promise<void>;
}

function usageDocRef(sub: string, day: string) {
  return getStoreFirestore().collection('users').doc(sub).collection(LLM_USAGE_COLLECTION).doc(day);
}

export const firestoreLlmUsageStore: LlmUsageStore = {
  async readSpent(sub, day) {
    const snap = await usageDocRef(sub, day).get();
    const spent: unknown = snap.exists ? snap.get('spentMicroUsd') : 0;
    return typeof spent === 'number' && Number.isFinite(spent) ? spent : 0;
  },
  async addSpend(sub, day, microUsd, expireAt) {
    await usageDocRef(sub, day).set(
      {
        spentMicroUsd: FieldValue.increment(microUsd),
        calls: FieldValue.increment(1),
        expireAt,
      },
      { merge: true },
    );
  },
};

/** In-memory store for tests and test seams. */
export function memoryLlmUsageStore(): LlmUsageStore & { spent: Map<string, number> } {
  const spent = new Map<string, number>();
  return {
    spent,
    readSpent: (sub, day) => Promise.resolve(spent.get(`${sub}/${day}`) ?? 0),
    addSpend: (sub, day, microUsd) => {
      const key = `${sub}/${day}`;
      spent.set(key, (spent.get(key) ?? 0) + microUsd);
      return Promise.resolve();
    },
  };
}

let usageStore: LlmUsageStore = firestoreLlmUsageStore;
let clock: () => number = Date.now;
const inFlight = new Map<string, number>();

/** Test hook: swap the store and clock; `null` restores both. Clears in-flight counts. */
export function setLlmBudgetForTest(
  overrides: { store: LlmUsageStore; now?: () => number } | null,
): void {
  usageStore = overrides?.store ?? firestoreLlmUsageStore;
  clock = overrides?.now ?? Date.now;
  inFlight.clear();
}

export function inFlightForTest(sub: string): number {
  return inFlight.get(sub) ?? 0;
}

export interface LlmMeter {
  /**
   * Charges one model call. `usage` is the response's `usageMetadata` (for a
   * stream, the last chunk's). Never rejects; a failed write is logged.
   */
  charge(model: string, usage: UsageCounts | undefined, searchQueries?: number): Promise<void>;
  /** Frees the in-flight slot. Idempotent. */
  release(): void;
}

export type LlmAdmission =
  | { kind: 'ok'; meter: LlmMeter }
  | { kind: 'over'; retryAfterSeconds: number }
  | { kind: 'busy' }
  | { kind: 'unknown' };

function logRefusal(sub: string, route: LlmRoute, reason: 'over' | 'busy' | 'unknown'): void {
  console.log(JSON.stringify({ event: 'llm_refused', sub, route, reason }));
}

export async function admitLlm(sub: string, route: LlmRoute): Promise<LlmAdmission> {
  const held = inFlight.get(sub) ?? 0;
  if (held >= LLM_MAX_IN_FLIGHT_PER_MEMBER) {
    logRefusal(sub, route, 'busy');
    return { kind: 'busy' };
  }
  // Take the slot before the read, so parallel requests cannot all pass it.
  inFlight.set(sub, held + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(sub) ?? 1) - 1;
    if (left > 0) inFlight.set(sub, left);
    else inFlight.delete(sub);
  };

  const admittedAt = clock();
  let spent: number;
  try {
    spent = await usageStore.readSpent(sub, utcDayKey(admittedAt));
  } catch {
    release();
    logRefusal(sub, route, 'unknown');
    return { kind: 'unknown' };
  }
  if (overBudget(spent)) {
    release();
    logRefusal(sub, route, 'over');
    return { kind: 'over', retryAfterSeconds: secondsToUtcMidnight(admittedAt) };
  }

  const meter: LlmMeter = {
    async charge(model, usage, searchQueries = 0) {
      const cost = costMicroUsd(model, usage, searchQueries);
      console.log(
        JSON.stringify({
          event: 'llm',
          sub,
          route,
          model,
          inputTokens: inputTokens(usage),
          outputTokens: outputTokens(usage),
          searchQueries,
          costMicroUsd: cost,
        }),
      );
      // The day the call ends in, so a call that crosses midnight counts tomorrow.
      const now = clock();
      const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
      try {
        await usageStore.addSpend(sub, utcDayKey(now), cost, new Date(dayStart + LLM_USAGE_RETENTION_MS));
      } catch {
        console.error(JSON.stringify({ event: 'llm_charge_failed', sub, route }));
      }
    },
    release,
  };
  return { kind: 'ok', meter };
}

/** The response for a refused admission. */
export function llmRefusal(admission: Exclude<LlmAdmission, { kind: 'ok' }>): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (admission.kind === 'unknown') {
    return new Response(JSON.stringify({ error: 'Store unavailable' }), { status: 503, headers });
  }
  if (admission.kind === 'busy') {
    return new Response(
      JSON.stringify({ error: 'Too many requests at once. Try again in a moment.', code: LLM_BUSY }),
      { status: 429, headers },
    );
  }
  headers['Retry-After'] = String(admission.retryAfterSeconds);
  return new Response(
    JSON.stringify({ error: "You've reached today's limit. It resets at midnight UTC.", code: LLM_BUDGET_EXCEEDED }),
    { status: 429, headers },
  );
}

type GenerateContentClient = { models: Pick<GoogleGenAI['models'], 'generateContent'> };

/**
 * The same client, with every `generateContent` call charged to `meter`
 * once it resolves. The result does not wait for the charge's write, so a
 * slow store never holds up an answer the model already gave. A call that
 * throws is not charged: nothing reports its usage.
 */
export function meteredAi<T extends GenerateContentClient>(ai: T, meter: LlmMeter): GenerateContentClient {
  return {
    models: {
      generateContent: async (params) => {
        const result = await ai.models.generateContent(params);
        const queries = result.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length ?? 0;
        void meter.charge(params.model, result.usageMetadata, queries);
        return result;
      },
    },
  };
}

/**
 * Wraps a response body so `onEnd` runs once when the body finishes, errors,
 * or is cancelled, or right away when there is no body.
 */
export function onResponseEnd(res: Response, onEnd: () => void): Response {
  if (res.body === null) {
    onEnd();
    return res;
  }
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        end();
        controller.error(err);
      }
    },
    async cancel(reason) {
      end();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** What `api/chat.ts` receives on Cloud Run; it cannot import this module. */
export type ChatUsageContext = MembershipHandlerContext & {
  onUsage: (model: string, usage: UsageCounts | undefined) => void;
};

/**
 * The chat route's meter, outside `api/chat.ts` (which cannot import
 * siblings). Runs after `withMembership` decided access, and uses the sub only
 * to key the budget. Admits before the handler reads the body, hands it
 * `onUsage`, and releases when the response body ends. Every other field of
 * the context reaches the handler unchanged (the kitchen profile does).
 */
export function withChatBudget<C extends MembershipHandlerContext>(
  handler: (req: Request, ctx: C & ChatUsageContext) => Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    const admission = await admitLlm(ctx.authorizedSub, 'chat');
    if (admission.kind !== 'ok') return llmRefusal(admission);
    const { meter } = admission;
    let res: Response;
    try {
      res = await handler(req, { ...ctx, onUsage: (model, usage) => void meter.charge(model, usage) });
    } catch (err) {
      meter.release();
      throw err;
    }
    return onResponseEnd(res, meter.release);
  };
}
