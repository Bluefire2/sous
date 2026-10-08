/**
 * `POST /api/agent` gate order: membership, body cap, JSON and shape, the
 * model key, then the library load, each answered before the next runs.
 * AGENTS.md: membership denied is never 503 and unknown is never 401.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { endlessBody } from '../../test/endlessBody.ts';
import * as membership from '../membership.ts';
import * as run from './harness/run.ts';
import type { AgentEvent, AgentRunSummary, StartAgentResult } from './harness/types.ts';
import { MAX_AGENT_BODY_BYTES } from './request.ts';
import { agentPost } from './route.ts';
import * as library from './sous/library.ts';
import {
  LLM_DAILY_BUDGET_MICRO_USD,
  inFlightForTest,
  memoryLlmUsageStore,
  setLlmBudgetForTest,
  utcDayKey,
} from '../llmBudget.ts';

// Model routes admit against the daily budget; keep it off Firestore.
let llmUsage: ReturnType<typeof memoryLlmUsageStore>;
beforeEach(() => {
  llmUsage = memoryLlmUsageStore();
  setLlmBudgetForTest({ store: llmUsage });
});
afterEach(() => setLlmBudgetForTest(null));

vi.mock('../membership.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../membership.ts')>();
  return { ...actual, requireMember: vi.fn() };
});

vi.mock('./sous/library.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sous/library.ts')>();
  return { ...actual, loadAgentLibrary: vi.fn() };
});

vi.mock('./harness/run.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./harness/run.ts')>();
  return { ...actual, startAgent: vi.fn() };
});

const requireMember = vi.mocked(membership.requireMember);
const loadAgentLibrary = vi.mocked(library.loadAgentLibrary);
const startAgent = vi.mocked(run.startAgent);

const LIBRARY = library.buildAgentLibrary([], [], {
  truncated: false,
  maxIndexEntries: 500,
  maxIndexChars: 40_000,
});

function validBody(): string {
  return JSON.stringify({
    messages: [{ role: 'user', content: 'What can I cook tonight?' }],
    clientNow: '2026-10-05T18:00:00.000Z',
    timeZone: 'Europe/London',
  });
}

function post(body: string | ReadableStream<Uint8Array> = validBody()): Request {
  return new Request('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);
}

function fakeRun(events: AgentEvent[], outcome: 'ok' | 'throw' = 'ok'): StartAgentResult {
  return {
    async run(emit): Promise<AgentRunSummary> {
      for (const event of events) emit(event);
      if (outcome === 'throw') throw new Error('model stream broke: secret detail');
      return { steps: 1, calls: 0, resultBytes: 0, finish: 'text' };
    },
  };
}

function lines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

beforeEach(() => {
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  requireMember.mockReset().mockResolvedValue({ kind: 'ok', sub: 'member-sub', email: 'm@example.com', isOwner: false });
  loadAgentLibrary.mockReset().mockResolvedValue(LIBRARY);
  startAgent.mockReset().mockResolvedValue(fakeRun([{ t: 'text', step: 0, d: 'Soup.' }, { t: 'done' }]));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/agent gates', () => {
  it('answers denied with 401 before reading the body', async () => {
    requireMember.mockResolvedValue({ kind: 'denied' });
    const endless = endlessBody();
    const res = await agentPost(post(endless.body));
    expect(res.status).toBe(401);
    // A ReadableStream prefetches one chunk when it is created; the route reads nothing past that.
    expect(endless.read()).toBeLessThanOrEqual(64 * 1024);
    expect(loadAgentLibrary).not.toHaveBeenCalled();
  });

  it('answers unknown membership with 503, never 401', async () => {
    requireMember.mockResolvedValue({ kind: 'unknown' });
    const res = await agentPost(post());
    expect(res.status).toBe(503);
    expect(loadAgentLibrary).not.toHaveBeenCalled();
  });

  it('answers 413 and stops reading a body over the cap', async () => {
    const endless = endlessBody();
    const res = await agentPost(post(endless.body));
    expect(res.status).toBe(413);
    expect(endless.read()).toBeLessThan(MAX_AGENT_BODY_BYTES + 128 * 1024);
    expect(endless.cancelled()).toBe(false);
    expect(loadAgentLibrary).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not JSON or not a valid request', async () => {
    for (const body of ['not json', '{}', JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }], clientNow: '2026-10-05T18:00:00.000Z', timeZone: 'UTC' })]) {
      const res = await agentPost(post(body));
      expect(res.status, body).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(loadAgentLibrary).not.toHaveBeenCalled();
  });

  it('answers 503 without a model key, before loading the library', async () => {
    for (const key of ['', '  ']) {
      vi.stubEnv('GEMINI_API_KEY', key);
      const res = await agentPost(post());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Assistant is unavailable.' });
    }
    expect(loadAgentLibrary).not.toHaveBeenCalled();
  });

  it('loads the session member’s library, never one named in the body', async () => {
    const body = JSON.parse(validBody()) as Record<string, unknown>;
    await agentPost(post(JSON.stringify({ ...body, sub: 'someone-else', uid: 'someone-else' })));
    expect(loadAgentLibrary).toHaveBeenCalledWith('member-sub', expect.any(Object));
  });

  it('answers 503 when the library load fails', async () => {
    loadAgentLibrary.mockRejectedValue(new Error('firestore down'));
    const res = await agentPost(post());
    expect(res.status).toBe(503);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('answers 503 when the library load outlasts its 90 s budget', async () => {
    vi.useFakeTimers();
    loadAgentLibrary.mockReturnValue(new Promise(() => {}));
    let settled = false;
    const pending = agentPost(post()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('answers 502 when the model run cannot start', async () => {
    startAgent.mockRejectedValue(new Error('open failed'));
    const res = await agentPost(post());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Assistant is unavailable.' });
  });
});

describe('POST /api/agent stream', () => {
  it('streams the run as NDJSON with no-store', async () => {
    const res = await agentPost(post());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(lines(await res.text())).toEqual([{ t: 'text', step: 0, d: 'Soup.' }, { t: 'done' }]);
  });

  it('ends a broken run with the canned error and done, never the error text', async () => {
    startAgent.mockResolvedValue(fakeRun([{ t: 'text', step: 0, d: 'Partial' }], 'throw'));
    const res = await agentPost(post());
    const text = await res.text();
    expect(text).not.toContain('secret detail');
    expect(lines(text)).toEqual([
      { t: 'text', step: 0, d: 'Partial' },
      { t: 'error', code: 'assistant_unavailable', message: "The assistant couldn't answer that." },
      { t: 'done' },
    ]);
  });

  it('adds nothing after done when the run throws late', async () => {
    startAgent.mockResolvedValue(fakeRun([{ t: 'done' }], 'throw'));
    expect(lines(await (await agentPost(post())).text())).toEqual([{ t: 'done' }]);
  });

  it('logs counts and the tool outcome, never message text', async () => {
    startAgent.mockResolvedValue(
      fakeRun([{ t: 'tool', name: 'search_recipes', phase: 'end', ok: true }, { t: 'text', step: 0, d: 'Soup.' }, { t: 'done' }]),
    );
    await (await agentPost(post())).text();
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('agent tool search_recipes ok=true');
    expect(logged).toMatch(/agent steps=1 calls=0 .*finish=text/);
    expect(logged).not.toContain('What can I cook');
    expect(logged).not.toContain('Soup.');
  });
});

describe('POST /api/agent daily AI budget', () => {
  it('refuses over the budget before starting the run', async () => {
    llmUsage.spent.set(`member-sub/${utcDayKey(Date.now())}`, LLM_DAILY_BUDGET_MICRO_USD);
    const res = await agentPost(post());
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'llm-budget-exceeded' });
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('holds a slot while the run streams and frees it after', async () => {
    const res = await agentPost(post());
    expect(inFlightForTest('member-sub')).toBe(1);
    await res.text();
    await vi.waitFor(() => expect(inFlightForTest('member-sub')).toBe(0));
  });

  it('frees the slot when the run cannot start', async () => {
    startAgent.mockRejectedValue(new Error('no stream'));
    const res = await agentPost(post());
    expect(res.status).toBe(502);
    expect(inFlightForTest('member-sub')).toBe(0);
  });
});
