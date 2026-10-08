import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No test here reaches the network: the model client is replaced, and each
// test says what its generateContentStream does.
const model = vi.hoisted(() => ({
  constructed: 0,
  generate: (() => {
    throw new Error('generateContentStream not set for this test');
  }) as (...args: unknown[]) => Promise<unknown>,
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    models = { generateContentStream: (...args: unknown[]) => model.generate(...args) };
    constructor() {
      model.constructed += 1;
    }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

import { endlessBody } from '../test/endlessBody';
import {
  MAX_CHAT_BODY_BYTES,
  MAX_CHAT_CONTEXT_CHARS,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_TEXT_CHARS,
  POST,
  estimatedPromptTokens,
  parseChatRequest,
} from './chat';

const SECRET_TEXT = 'secret-recipe-text-quoted-by-the-sdk';
const ctx = { authorizedSub: 'member-sub' };
// The first bytes of a JPEG, as base64.
const JPEG = '/9j/4A==';

function chatRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messages: [
      { role: 'user', content: 'How long do I rest the dough?' },
      { role: 'assistant', content: 'Thirty minutes.' },
      { role: 'user', content: 'Does this look right?', images: [{ mediaType: 'image/jpeg', base64: JPEG }] },
    ],
    recipe: { title: 'Bread', steps: [] },
    cookingState: { servings: 2, currentStep: 1, checkedIngredients: [] },
    ...overrides,
  };
}

async function expectJsonError(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({ error });
}

let savedKey: string | undefined;

beforeEach(() => {
  process.env.SESSION_SECRET = 'chat-request-test-secret';
  process.env.ALLOWED_EMAILS = 'allowed@example.com';
  savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  model.constructed = 0;
  model.generate = () => {
    throw new Error('generateContentStream not set for this test');
  };
});

afterEach(() => {
  if (savedKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = savedKey;
  }
  vi.restoreAllMocks();
});

describe('POST /api/chat request checks', () => {
  it('still answers 401 without a session or an authorized sub', async () => {
    const res = await POST(chatRequest(JSON.stringify(validBody())));
    expect(res.status).toBe(401);
  });

  it('answers 400 for a body that is not JSON', async () => {
    await expectJsonError(await POST(chatRequest('not json'), ctx), 400, 'Bad request');
  });

  it('answers 400 for an empty object', async () => {
    await expectJsonError(await POST(chatRequest('{}'), ctx), 400, 'Bad request');
  });

  it('answers 400 for an empty body', async () => {
    await expectJsonError(await POST(chatRequest(''), ctx), 400, 'Bad request');
  });

  it('answers 413 for a body over the cap, by Content-Length', async () => {
    const res = await POST(
      chatRequest('{}', { 'content-length': String(MAX_CHAT_BODY_BYTES + 1) }),
      ctx,
    );
    await expectJsonError(res, 413, 'Request too large');
  });

  it('answers 413 for a body over the cap without Content-Length', async () => {
    const big = JSON.stringify(validBody({ recipe: { notes: 'x'.repeat(MAX_CHAT_BODY_BYTES) } }));
    const req = chatRequest(big);
    expect(req.headers.get('content-length')).toBeNull();
    await expectJsonError(await POST(req, ctx), 413, 'Request too large');
  });

  it('stops reading past the cap and leaves the rest unread, not cancelled', async () => {
    const endless = endlessBody();
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: endless.body,
      duplex: 'half',
    } as RequestInit);
    await expectJsonError(await POST(req, ctx), 413, 'Request too large');
    expect(endless.cancelled()).toBe(false);
    expect(endless.read()).toBeLessThan(MAX_CHAT_BODY_BYTES + 256 * 1024);
  });

  it('answers 503 for a valid body when GEMINI_API_KEY is unset, before building a client', async () => {
    await expectJsonError(
      await POST(chatRequest(JSON.stringify(validBody())), ctx),
      503,
      'Assistant is unavailable.',
    );
    expect(model.constructed).toBe(0);
  });

  it('answers 503 when GEMINI_API_KEY is blank', async () => {
    process.env.GEMINI_API_KEY = '   ';
    await expectJsonError(
      await POST(chatRequest(JSON.stringify(validBody())), ctx),
      503,
      'Assistant is unavailable.',
    );
    expect(model.constructed).toBe(0);
  });

  it('answers 502 when the model call throws, and logs no message', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    model.generate = async () => {
      throw Object.assign(new Error(`bad request: ${SECRET_TEXT}`), { status: 400 });
    };
    await expectJsonError(
      await POST(chatRequest(JSON.stringify(validBody())), ctx),
      502,
      'Assistant is unavailable.',
    );
    const lines = logged.mock.calls.map((call) => call.map(String).join(' '));
    expect(lines).toEqual(['Chat model call failed: Error (status 400); message withheld']);
  });

  it('streams the reply with the 0x1E framing for a valid body', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let request: { contents?: unknown } | undefined;
    model.generate = async (params) => {
      request = params as { contents?: unknown };
      return (async function* () {
        yield { text: 'Looks good.' };
      })();
    };
    const res = await POST(chatRequest(JSON.stringify(validBody())), ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Looks good.\x1E\x1E');
    expect(request?.contents).toEqual([
      { role: 'user', parts: [{ text: 'How long do I rest the dough?' }] },
      { role: 'model', parts: [{ text: 'Thirty minutes.' }] },
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: JPEG } }, { text: 'Does this look right?' }],
      },
    ]);
  });

  it('fails a broken stream with an error that holds no message', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    model.generate = async () =>
      (async function* () {
        yield { text: 'Partial' };
        throw Object.assign(new TypeError(`stream broke: ${SECRET_TEXT}`), { status: 500 });
      })();
    const res = await POST(chatRequest(JSON.stringify(validBody())), ctx);
    expect(res.status).toBe(200);
    const failure = await res.text().then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Chat stream failed: TypeError (status 500); message withheld');
    expect(String((failure as Error).stack)).not.toContain(SECRET_TEXT);
  });
});

describe('parseChatRequest', () => {
  it('accepts the shape the client sends and drops unknown keys', () => {
    const parsed = parseChatRequest({
      ...validBody(),
      extra: true,
      messages: [{ role: 'user', content: 'Hi', images: [{ mediaType: ' IMAGE/JPEG ', base64: JPEG, x: 1 }], y: 2 }],
    });
    expect(parsed).toEqual({
      messages: [{ role: 'user', content: 'Hi', images: [{ mediaType: 'image/jpeg', base64: JPEG }] }],
      recipe: { title: 'Bread', steps: [] },
      cookingState: { servings: 2, currentStep: 1, checkedIngredients: [] },
    });
  });

  it('accepts a missing cookingState and an empty text with a photo', () => {
    const parsed = parseChatRequest({
      messages: [{ role: 'user', content: '', images: [{ mediaType: 'image/png', base64: 'iVBORw0KGgo=' }] }],
      recipe: {},
    });
    expect(parsed?.cookingState).toBeUndefined();
    expect(parsed?.messages).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', []],
    ['no messages', { recipe: {} }],
    ['empty messages', { messages: [], recipe: {} }],
    ['messages not an array', { messages: 'hi', recipe: {} }],
    ['a message that is not an object', { messages: ['hi'], recipe: {} }],
    ['an unknown role', { messages: [{ role: 'system', content: 'x' }], recipe: {} }],
    ['content that is not a string', { messages: [{ role: 'user', content: 1 }], recipe: {} }],
    ['no recipe', { messages: [{ role: 'user', content: 'x' }] }],
    ['a recipe that is an array', { messages: [{ role: 'user', content: 'x' }], recipe: [] }],
    ['a recipe that is a string', { messages: [{ role: 'user', content: 'x' }], recipe: 'Bread' }],
    ['images not an array', { messages: [{ role: 'user', content: 'x', images: {} }], recipe: {} }],
    [
      'an image type outside the allow-list',
      { messages: [{ role: 'user', content: 'x', images: [{ mediaType: 'image/gif', base64: JPEG }] }], recipe: {} },
    ],
    [
      'an image without base64',
      { messages: [{ role: 'user', content: 'x', images: [{ mediaType: 'image/jpeg' }] }], recipe: {} },
    ],
    [
      'an image that is not base64',
      { messages: [{ role: 'user', content: 'x', images: [{ mediaType: 'image/jpeg', base64: 'not base64!' }] }], recipe: {} },
    ],
    [
      'an empty image',
      { messages: [{ role: 'user', content: 'x', images: [{ mediaType: 'image/jpeg', base64: '' }] }], recipe: {} },
    ],
    [
      'too many images',
      {
        messages: [
          {
            role: 'user',
            content: 'x',
            images: Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => ({ mediaType: 'image/jpeg', base64: JPEG })),
          },
        ],
        recipe: {},
      },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(parseChatRequest(raw)).toBeNull();
  });

  it('caps one image at MAX_CHAT_IMAGE_BYTES decoded', () => {
    const atCap = 'A'.repeat((MAX_CHAT_IMAGE_BYTES / 3) * 4);
    const overCap = `${atCap}AAAA`;
    const body = (base64: string) => ({
      messages: [{ role: 'user', content: 'x', images: [{ mediaType: 'image/jpeg', base64 }] }],
      recipe: {},
    });
    expect(parseChatRequest(body(atCap))).not.toBeNull();
    expect(parseChatRequest(body(overCap))).toBeNull();
  });

  it(`accepts ${MAX_CHAT_IMAGES} images on one message`, () => {
    const images = Array.from({ length: MAX_CHAT_IMAGES }, () => ({ mediaType: 'image/jpeg', base64: JPEG }));
    expect(parseChatRequest({ messages: [{ role: 'user', content: 'x', images }], recipe: {} })).not.toBeNull();
  });
});

describe('chat text caps', () => {
  it('accepts message text up to the cap, summed over the thread', () => {
    const half = 'x'.repeat(MAX_CHAT_TEXT_CHARS / 2);
    const messages = [
      { role: 'user', content: half },
      { role: 'assistant', content: half },
    ];
    expect(parseChatRequest(validBody({ messages }))).not.toBeNull();
    messages.push({ role: 'user', content: 'x' });
    expect(parseChatRequest(validBody({ messages }))).toBeNull();
  });

  it('refuses a recipe and cooking state over the context cap', () => {
    const recipe = { title: 'Bread', notes: 'x'.repeat(MAX_CHAT_CONTEXT_CHARS) };
    expect(parseChatRequest(validBody({ recipe }))).toBeNull();
    const cookingState = { notes: 'x'.repeat(MAX_CHAT_CONTEXT_CHARS) };
    expect(parseChatRequest(validBody({ cookingState }))).toBeNull();
  });

  it('estimates a token per character, the tool schema included, and 1 300 tokens a photo', () => {
    const textOnly = estimatedPromptTokens('', []);
    expect(textOnly).toBeGreaterThan(500); // the update_recipe schema
    expect(
      estimatedPromptTokens('abcd', [
        { role: 'user', content: 'ab' },
        { role: 'user', content: 'abc', images: [{ mediaType: 'image/jpeg', base64: JPEG }] },
      ]),
    ).toBe(textOnly + 9 + 1300);
  });
});

describe('POST usage reporting', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it("reports the stream's last usage once it ends", async () => {
    model.generate = async () =>
      (async function* () {
        yield { text: 'A', usageMetadata: { promptTokenCount: 10 } };
        yield { text: 'B', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } };
      })();
    const onUsage = vi.fn();
    const res = await POST(chatRequest(JSON.stringify(validBody())), { ...ctx, onUsage });
    expect(await res.text()).toBe('AB');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][1]).toEqual({ promptTokenCount: 10, candidatesTokenCount: 4 });
  });

  it('reports an estimate for a stream that breaks before any usage', async () => {
    model.generate = async () =>
      (async function* () {
        yield { text: 'Partial' };
        throw new Error('cut');
      })();
    const onUsage = vi.fn();
    const res = await POST(chatRequest(JSON.stringify(validBody())), { ...ctx, onUsage });
    await res.text().catch(() => {});
    expect(onUsage).toHaveBeenCalledTimes(1);
    const usage = onUsage.mock.calls[0][1] as { promptTokenCount: number };
    expect(usage.promptTokenCount).toBeGreaterThan(1300);
  });

  it('charges what a cut-off stream already wrote', async () => {
    model.generate = async () =>
      (async function* () {
        yield { text: 'Partial' };
        throw new Error('cut');
      })();
    const onUsage = vi.fn();
    const res = await POST(chatRequest(JSON.stringify(validBody())), { ...ctx, onUsage });
    await res.text().catch(() => {});
    expect((onUsage.mock.calls[0][1] as { candidatesTokenCount: number }).candidatesTokenCount).toBe(7);
  });

  it('survives the client cancelling mid-reply, and still reports usage', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let next!: () => void;
      model.generate = async () =>
        (async function* () {
          yield { text: 'First' };
          await new Promise<void>((resolve) => {
            next = resolve;
          });
          yield { text: 'Second' };
        })();
      const onUsage = vi.fn();
      const res = await POST(chatRequest(JSON.stringify(validBody())), { ...ctx, onUsage });
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      next();
      await vi.waitFor(() => expect(onUsage).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reports nothing when the model call never starts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    model.generate = async () => {
      throw new Error('down');
    };
    const onUsage = vi.fn();
    const res = await POST(chatRequest(JSON.stringify(validBody())), { ...ctx, onUsage });
    expect(res.status).toBe(502);
    expect(onUsage).not.toHaveBeenCalled();
  });
});
