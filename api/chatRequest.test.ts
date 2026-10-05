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

import { MAX_CHAT_BODY_BYTES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, POST, parseChatRequest } from './chat';

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
