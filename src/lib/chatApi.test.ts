import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHAT_TEXT_CHARS } from '../../api/chat';
import {
  MAX_CHAT_HISTORY_CHARS,
  MAX_CHAT_PHOTOS,
  fitChatHistory,
  recipeForChat,
  streamChatReply,
} from './chatApi';
import * as session from './session';
import type { Recipe } from './types';

const RECIPE: Recipe = {
  id: 'r1',
  createdAt: 1,
  updatedAt: 2,
  title: 'Soup',
  servings: 4,
  ingredientSections: [{ items: [{ item: 'water' }] }],
  steps: [{ text: 'Boil.' }],
  tags: ['lunch'],
};

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MAX_CHAT_PHOTOS', () => {
  it('matches the server cap in api/chat.ts', () => {
    expect(MAX_CHAT_PHOTOS).toBe(4);
  });
});

describe('recipeForChat', () => {
  it('strips lang and variantOf and leaves every other field', () => {
    expect(recipeForChat({ ...RECIPE, lang: 'it', description: 'Hot.' })).toEqual({
      ...RECIPE,
      description: 'Hot.',
    });
    expect(recipeForChat(RECIPE)).toEqual(RECIPE);
    expect(recipeForChat({ ...RECIPE, lang: 'uk' })).not.toHaveProperty('lang');
    expect(
      recipeForChat({ ...RECIPE, variantOf: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).toEqual(RECIPE);
  });
});

describe('streamChatReply', () => {
  it('parses a text-only complete reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamFromChunks(['Hello ', 'there', '\x1E\x1E']), { status: 200 })),
    );

    const reply = await streamChatReply({
      messages: [],
      recipe: RECIPE,
      onDelta: () => {},
    });

    expect(reply.text).toBe('Hello there');
    expect(reply.proposedRecipe).toBeUndefined();
    expect(reply.truncated).toBe(false);
  });

  it('parses a proposal split across chunk boundaries', async () => {
    const proposal = JSON.stringify({
      title: 'New Soup',
      servings: 6,
      ingredientSections: [],
      steps: [],
      tags: [],
    });
    const splitAt = Math.floor(proposal.length / 2);
    const firstHalf = proposal.slice(0, splitAt);
    const secondHalf = proposal.slice(splitAt);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          streamFromChunks(['Here is the update', '\x1E' + firstHalf, secondHalf, '\x1E']),
          { status: 200 },
        ),
      ),
    );

    const deltas: string[] = [];
    const reply = await streamChatReply({
      messages: [],
      recipe: RECIPE,
      onDelta: (text) => {
        deltas.push(text);
      },
    });

    expect(reply.text).toBe('Here is the update');
    expect(reply.proposedRecipe).toEqual({
      title: 'New Soup',
      servings: 6,
      ingredientSections: [],
      steps: [],
      tags: [],
    });
    expect(reply.truncated).toBe(false);
    expect(reply.text).not.toContain('{');
    for (const delta of deltas) {
      expect(reply.text.startsWith(delta)).toBe(true);
    }
  });

  it('flags a truncated proposal without a terminator', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(streamFromChunks(['Partial reply', '\x1E{"title":"Dr']), { status: 200 }),
      ),
    );

    const reply = await streamChatReply({
      messages: [],
      recipe: RECIPE,
      onDelta: () => {},
    });

    expect(reply.text).toBe('Partial reply');
    expect(reply.proposedRecipe).toBeUndefined();
    expect(reply.truncated).toBe(true);
  });

  it('flags a reply with no separator at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamFromChunks(['Just text']), { status: 200 })),
    );

    const reply = await streamChatReply({
      messages: [],
      recipe: RECIPE,
      onDelta: () => {},
    });

    expect(reply.text).toBe('Just text');
    expect(reply.truncated).toBe(true);
  });

  it('handles an empty stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamFromChunks([]), { status: 200 })),
    );

    const reply = await streamChatReply({
      messages: [],
      recipe: RECIPE,
      onDelta: () => {},
    });

    expect(reply.text).toBe('');
    expect(reply.truncated).toBe(true);
  });

  it('drops an unusable proposal from a complete reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(streamFromChunks(['Updated.', '\x1E{"steps":[]}\x1E']), { status: 200 }),
      ),
    );

    const reply = await streamChatReply({
      messages: [],
      recipe: RECIPE,
      onDelta: () => {},
    });

    expect(reply.text).toBe('Updated.');
    expect(reply.proposedRecipe).toBeUndefined();
    expect(reply.truncated).toBe(false);
  });

  it('keeps every field the proposal leaves out, so Apply clears nothing it did not show', async () => {
    const recipe: Recipe = {
      ...RECIPE,
      description: 'Simple.',
      prepMinutes: 5,
      cookMinutes: 20,
      notes: 'Salt to taste.',
    };
    const proposal = JSON.stringify({ title: 'Soup', steps: [{ text: 'Boil well.' }] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamFromChunks([`\x1E${proposal}\x1E`]), { status: 200 })),
    );

    const reply = await streamChatReply({ messages: [], recipe, onDelta: () => {} });

    expect(reply.proposedRecipe).toEqual({
      title: 'Soup',
      description: 'Simple.',
      servings: 4,
      prepMinutes: 5,
      cookMinutes: 20,
      ingredientSections: [{ items: [{ item: 'water' }] }],
      steps: [{ text: 'Boil well.' }],
      tags: ['lunch'],
      notes: 'Salt to taste.',
    });
  });

  it('still clears an optional field the proposal empties', async () => {
    const recipe: Recipe = { ...RECIPE, notes: 'Salt to taste.' };
    const proposal = JSON.stringify({ title: 'Soup', notes: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamFromChunks([`\x1E${proposal}\x1E`]), { status: 200 })),
    );

    const reply = await streamChatReply({ messages: [], recipe, onDelta: () => {} });

    expect(reply.proposedRecipe).not.toHaveProperty('notes');
    expect(reply.proposedRecipe?.steps).toEqual(RECIPE.steps);
  });

  it('takes servings from the viewed recipe when the proposal leaves it out', async () => {
    // Gemini does not enforce the schema's `required` on function-call
    // arguments; this is the shape it returned for "split the steps".
    const proposal = JSON.stringify({
      title: 'Soup',
      ingredientSections: [{ items: [{ item: 'water' }] }],
      steps: [{ text: 'Boil.' }],
      tags: ['lunch'],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamFromChunks([`\x1E${proposal}\x1E`]), { status: 200 })),
    );

    const reply = await streamChatReply({ messages: [], recipe: RECIPE, onDelta: () => {} });

    expect(reply.text).toBe('');
    expect(reply.truncated).toBe(false);
    expect(reply.proposedRecipe).toEqual({
      title: 'Soup',
      servings: 4,
      ingredientSections: [{ items: [{ item: 'water' }] }],
      steps: [{ text: 'Boil.' }],
      tags: ['lunch'],
    });
  });

  it('still drops a proposal whose servings is present but invalid', async () => {
    const proposal = JSON.stringify({ title: 'Soup', servings: 0, steps: [], tags: [] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(streamFromChunks([`\x1E${proposal}\x1E`]), { status: 200 })),
    );

    const reply = await streamChatReply({ messages: [], recipe: RECIPE, onDelta: () => {} });

    expect(reply.proposedRecipe).toBeUndefined();
  });

  it('rejects unauthorized and server error responses', async () => {
    const invalidateSpy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unauthorized', { status: 401 })),
    );

    await expect(
      streamChatReply({ messages: [], recipe: RECIPE, onDelta: () => {} }),
    ).rejects.toThrow('Please sign in again — your session expired.');
    expect(invalidateSpy).toHaveBeenCalled();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('fail', { status: 500 })),
    );

    await expect(
      streamChatReply({ messages: [], recipe: RECIPE, onDelta: () => {} }),
    ).rejects.toThrow('Assistant request failed (500).');
  });
});

describe('fitChatHistory', () => {
  const msg = (chars: number, role: 'user' | 'assistant' = 'user') => ({ role, content: 'x'.repeat(chars) });

  it('mirrors the server cap', () => {
    expect(MAX_CHAT_HISTORY_CHARS).toBe(MAX_CHAT_TEXT_CHARS);
  });

  it('keeps a thread that fits', () => {
    const thread = [msg(10), msg(10, 'assistant'), msg(10)];
    expect(fitChatHistory(thread)).toEqual(thread);
  });

  it('drops the oldest messages first, keeping the total within the cap', () => {
    const half = MAX_CHAT_HISTORY_CHARS / 2;
    const thread = [msg(5), msg(5, 'assistant'), msg(half), msg(half - 10, 'assistant'), msg(5)];
    expect(fitChatHistory(thread)).toEqual(thread.slice(2));
  });

  it('starts a trimmed thread on a user message', () => {
    const half = MAX_CHAT_HISTORY_CHARS / 2;
    const thread = [msg(half), msg(half, 'assistant'), msg(1)];
    expect(fitChatHistory(thread)).toEqual([thread[2]]);
  });

  it('keeps a thread that already starts with the assistant when nothing is trimmed', () => {
    const thread = [msg(5, 'assistant'), msg(5)];
    expect(fitChatHistory(thread)).toEqual(thread);
  });

  it('always keeps the newest message, even alone over the cap', () => {
    const thread = [msg(1), msg(MAX_CHAT_HISTORY_CHARS + 1)];
    expect(fitChatHistory(thread)).toEqual([thread[1]]);
  });

  it('keeps photos on the messages it keeps', () => {
    const newest = { role: 'user' as const, content: 'look', images: [{ mediaType: 'image/jpeg', base64: 'AAAA' }] };
    expect(fitChatHistory([newest])[0]).toBe(newest);
  });
});

describe('streamChatReply over the daily AI budget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the budget message from the server's code", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'English', code: 'llm-budget-exceeded' }), { status: 429 }),
        ),
      ),
    );
    await expect(
      streamChatReply({ messages: [{ role: 'user', content: 'hi' }], recipe: RECIPE, onDelta: () => {} }),
    ).rejects.toThrow("You've reached today's limit for Sous's AI features. It resets at midnight UTC.");
  });
});
