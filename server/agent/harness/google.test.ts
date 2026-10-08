import { describe, expect, it, vi } from 'vitest';
import { FunctionCallingConfigMode, Type } from '@google/genai';
import { estimatedStepPromptTokens, googleModel, toolParametersToSchema } from './google.ts';
import { callChunk, fakeGenerateStream, textChunk } from '../../../test/fakeGeminiStream.ts';
import type { AgentMessage } from './types.ts';

describe('toolParametersToSchema', () => {
  it('maps object, array, string enum, and number', () => {
    const schema = toolParametersToSchema({
      type: 'object',
      description: 'root',
      properties: {
        q: { type: 'string', enum: ['a', 'b'] },
        n: { type: 'number', description: 'num' },
        tags: {
          type: 'array',
          maxItems: 3,
          items: { type: 'integer' },
        },
      },
      required: ['q'],
    });
    expect(schema.type).toBe(Type.OBJECT);
    expect(schema.description).toBe('root');
    expect(schema.required).toEqual(['q']);
    expect(schema.properties?.q?.type).toBe(Type.STRING);
    expect(schema.properties?.q?.enum).toEqual(['a', 'b']);
    expect(schema.properties?.n?.type).toBe(Type.NUMBER);
    expect(schema.properties?.tags?.type).toBe(Type.ARRAY);
    expect(schema.properties?.tags?.maxItems).toBe('3');
    expect(schema.properties?.tags?.items?.type).toBe(Type.INTEGER);
  });
});

describe('googleModel adapter request mapping', () => {
  it('maps AgentMessage roles and passes tool declarations', async () => {
    const { generate, calls } = fakeGenerateStream([[textChunk('hi')]]);
    const client = googleModel({ apiKey: 'k', model: 'm', generate });
    const messages: AgentMessage[] = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'there' },
    ];
    const stream = await client.step({
      systemInstruction: 'sys',
      messages,
      priorTurns: [],
      tools: [
        {
          name: 'search',
          description: 'find',
          parameters: { type: 'object', properties: {} },
        },
      ],
      forceText: false,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    });
    for await (const _ of stream.events) {
      /* drain */
    }
    expect(calls).toHaveLength(1);
    const contents = calls[0]!.contents as { role?: string; parts?: { text?: string }[] }[];
    expect(contents[0]?.role).toBe('user');
    expect(contents[0]?.parts?.[0]?.text).toBe('hello');
    expect(contents[1]?.role).toBe('model');
    expect(contents[1]?.parts?.[0]?.text).toBe('there');
    const toolUnion = calls[0]!.config?.tools?.[0] as
      | { functionDeclarations?: { name?: string; parameters?: { type?: Type } }[] }
      | undefined;
    const decl = toolUnion?.functionDeclarations?.[0];
    expect(decl?.name).toBe('search');
    expect(decl?.parameters?.type).toBe(Type.OBJECT);
  });

  it('sets functionCallingConfig NONE when forceText', async () => {
    const { generate, calls } = fakeGenerateStream([[textChunk('done')]]);
    const client = googleModel({ apiKey: 'k', model: 'm', generate });
    const stream = await client.step({
      systemInstruction: 'sys',
      messages: [{ role: 'user', text: 'x' }],
      priorTurns: [],
      tools: [
        {
          name: 't',
          description: 'd',
          parameters: { type: 'object', properties: {} },
        },
      ],
      forceText: true,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    });
    for await (const _ of stream.events) {
      /* drain */
    }
    expect(calls[0]!.config?.toolConfig?.functionCallingConfig?.mode).toBe(
      FunctionCallingConfigMode.NONE,
    );
  });

  it('yields each chunk text as a delta', async () => {
    const { generate } = fakeGenerateStream([
      [textChunk('Here are '), textChunk('three ideas'), textChunk('!')],
    ]);
    const client = googleModel({ apiKey: 'k', model: 'm', generate });
    const stream = await client.step({
      systemInstruction: 'sys',
      messages: [{ role: 'user', text: 'compare' }],
      priorTurns: [],
      tools: [],
      forceText: true,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    });
    const deltas: string[] = [];
    for await (const ev of stream.events) {
      if (ev.kind === 'text') {
        deltas.push(ev.d);
      }
    }
    expect(deltas.join('')).toBe('Here are three ideas!');
  });

  it('appends extraUserNote onto the function-response turn', async () => {
    const { generate, calls } = fakeGenerateStream([
      [callChunk('search', {}, 'c1')],
      [textChunk('done')],
    ]);
    const client = googleModel({ apiKey: 'k', model: 'm', generate });
    const first = await client.step({
      systemInstruction: 'sys',
      messages: [{ role: 'user', text: 'hello' }],
      priorTurns: [],
      tools: [
        {
          name: 'search',
          description: 'find',
          parameters: { type: 'object', properties: {} },
        },
      ],
      forceText: false,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    });
    for await (const _ of first.events) {
      /* drain */
    }
    const turn = await first.continueWith([
      { id: 'c1', name: 'search', result: { output: { hits: [] } } },
    ]);
    const second = await client.step({
      systemInstruction: 'sys',
      messages: [{ role: 'user', text: 'hello' }],
      priorTurns: [turn],
      tools: [
        {
          name: 'search',
          description: 'find',
          parameters: { type: 'object', properties: {} },
        },
      ],
      forceText: true,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
      extraUserNote: 'You have reached the tool limit. Answer now.',
    });
    for await (const _ of second.events) {
      /* drain */
    }
    const contents = calls[1]!.contents as {
      role?: string;
      parts?: { text?: string; functionResponse?: unknown }[];
    }[];
    for (let i = 1; i < contents.length; i += 1) {
      expect(contents[i]!.role).not.toBe(contents[i - 1]!.role);
    }
    const last = contents[contents.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.parts?.some((part) => part.functionResponse !== undefined)).toBe(true);
    expect(last.parts?.some((part) => part.text?.includes('tool limit'))).toBe(true);
    expect(contents.filter((content) => content.role === 'user')).toHaveLength(2);
  });
});

describe('googleModel usage', () => {
  function stepRequest() {
    return {
      systemInstruction: 'sys',
      messages: [{ role: 'user' as const, text: 'hello' }],
      priorTurns: [],
      tools: [],
      forceText: false,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
    };
  }

  it("reports each step's last usage once its stream ends", async () => {
    const first = textChunk('a');
    first.usageMetadata = { promptTokenCount: 5 };
    const last = textChunk('b');
    last.usageMetadata = { promptTokenCount: 5, candidatesTokenCount: 2 };
    const { generate } = fakeGenerateStream([[first, last]]);
    const onUsage = vi.fn();
    const client = googleModel({ apiKey: 'k', model: 'm', generate, onUsage });
    const stream = await client.step(stepRequest());
    for await (const _ of stream.events) {
      expect(onUsage).not.toHaveBeenCalled();
    }
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith('m', { promptTokenCount: 5, candidatesTokenCount: 2 });
  });

  it('reports an estimate when the stream reported no usage', async () => {
    const { generate, calls } = fakeGenerateStream([[textChunk('a')]]);
    const onUsage = vi.fn();
    const client = googleModel({ apiKey: 'k', model: 'm', generate, onUsage });
    const stream = await client.step(stepRequest());
    for await (const _ of stream.events) {
      /* drain */
    }
    const contents = calls[0]!.contents as Parameters<typeof estimatedStepPromptTokens>[1];
    expect(onUsage).toHaveBeenCalledWith('m', {
      promptTokenCount: estimatedStepPromptTokens('sys', contents, []),
      candidatesTokenCount: 1,
    });
  });

  it('estimates a token per character of the request, tools included', () => {
    const contents = [{ role: 'user', parts: [{ text: 'hello' }] }];
    const tools = [{ name: 'search', description: 'find', parameters: { type: 'object', properties: {} } }];
    expect(estimatedStepPromptTokens('sys', contents, tools)).toBe(
      3 + JSON.stringify(contents).length + JSON.stringify(tools).length,
    );
  });

  it('reports when the consumer stops early', async () => {
    const { generate } = fakeGenerateStream([[textChunk('a'), textChunk('b')]]);
    const onUsage = vi.fn();
    const client = googleModel({ apiKey: 'k', model: 'm', generate, onUsage });
    const stream = await client.step(stepRequest());
    for await (const _ of stream.events) {
      break;
    }
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});
