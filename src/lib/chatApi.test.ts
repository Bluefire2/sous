import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHAT_PHOTOS, recipeForChat, streamChatReply } from './chatApi';
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
  it('strips lang and leaves every other field', () => {
    expect(recipeForChat({ ...RECIPE, lang: 'it', description: 'Hot.' })).toEqual({
      ...RECIPE,
      description: 'Hot.',
    });
    expect(recipeForChat(RECIPE)).toEqual(RECIPE);
    expect(recipeForChat({ ...RECIPE, lang: 'uk' })).not.toHaveProperty('lang');
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
