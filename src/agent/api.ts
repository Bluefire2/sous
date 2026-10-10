import { t } from '../i18n';
import { serverErrorText } from '../lib/errorText';
import { invalidateSession } from '../lib/session';
import type { AgentServerEvent } from './protocol';

const MAX_LINE_BYTES = 1_000_000;

export type NdjsonParserFinish = {
  events: AgentServerEvent[];
  truncated?: boolean;
  error?: string;
};

export type NdjsonParser = {
  push(input: string | Uint8Array): AgentServerEvent[];
  finish(): NdjsonParserFinish;
};

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function parseEventLine(line: string): AgentServerEvent | null {
  if (line === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const t = record.t;
  if (t === 'text') {
    if (typeof record.step === 'number' && typeof record.d === 'string') {
      return { t: 'text', step: record.step, d: record.d };
    }
    return null;
  }
  if (t === 'interim') {
    if (typeof record.step === 'number') {
      return { t: 'interim', step: record.step };
    }
    return null;
  }
  if (t === 'tool') {
    if (
      typeof record.name === 'string' &&
      (record.phase === 'start' || record.phase === 'end')
    ) {
      const event: Extract<AgentServerEvent, { t: 'tool' }> = {
        t: 'tool',
        name: record.name,
        phase: record.phase,
      };
      if (record.ok !== undefined) {
        event.ok = record.ok === true;
      }
      return event;
    }
    return null;
  }
  if (t === 'card') {
    const card = record.card;
    if (card !== null && typeof card === 'object') {
      const c = card as Record<string, unknown>;
      if (
        typeof c.type === 'string' &&
        typeof c.v === 'number' &&
        typeof c.id === 'string' &&
        'data' in c
      ) {
        return {
          t: 'card',
          card: { type: c.type, v: c.v, id: c.id, data: c.data },
        };
      }
    }
    return null;
  }
  if (t === 'error') {
    if (typeof record.message === 'string') {
      const event: Extract<AgentServerEvent, { t: 'error' }> = {
        t: 'error',
        message: record.message,
      };
      if (typeof record.code === 'string' && record.code.length > 0) {
        event.code = record.code;
      }
      return event;
    }
    return null;
  }
  if (t === 'done') {
    return { t: 'done' };
  }
  return null;
}

export function createNdjsonParser(): NdjsonParser {
  const decoder = new TextDecoder();
  let pending = '';
  let sawDone = false;
  let fatalError: string | null = null;

  function consumeLine(rawLine: string): AgentServerEvent[] {
    if (fatalError !== null) {
      return [];
    }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      return [];
    }
    if (utf8ByteLength(line) > MAX_LINE_BYTES) {
      fatalError = t('assistant.responseTooLarge');
      return [];
    }
    const event = parseEventLine(line);
    if (event?.t === 'done') {
      sawDone = true;
    }
    return event ? [event] : [];
  }

  function push(input: string | Uint8Array): AgentServerEvent[] {
    if (fatalError !== null) {
      return [];
    }
    const chunk =
      typeof input === 'string' ? input : decoder.decode(input, { stream: true });
    pending += chunk;
    const out: AgentServerEvent[] = [];
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl === -1) {
        if (utf8ByteLength(pending) > MAX_LINE_BYTES) {
          fatalError = t('assistant.responseTooLarge');
          pending = '';
        }
        break;
      }
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      out.push(...consumeLine(line));
      if (fatalError !== null) {
        break;
      }
    }
    return out;
  }

  function finish(): NdjsonParserFinish {
    const events: AgentServerEvent[] = [];
    if (fatalError !== null) {
      return { events, error: fatalError };
    }
    if (pending !== '') {
      events.push(...consumeLine(pending));
      pending = '';
      if (fatalError !== null) {
        return { events, error: fatalError };
      }
    }
    decoder.decode();
    if (!sawDone) {
      return { events, truncated: true };
    }
    return { events };
  }

  return { push, finish };
}

export type PostAgentMessage = {
  role: 'user' | 'assistant';
  content: string;
  cards?: { type: string; v: number; id: string; data: unknown }[];
};

export async function postAgent(params: {
  messages: PostAgentMessage[];
  clientNow: string;
  timeZone: string;
  signal?: AbortSignal;
  onEvent: (event: AgentServerEvent) => void;
}): Promise<{ truncated?: boolean; aborted?: boolean }> {
  let response: Response;
  try {
    response = await fetch('/api/agent', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: params.messages,
        clientNow: params.clientNow,
        timeZone: params.timeZone,
      }),
      signal: params.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { aborted: true };
    }
    throw err;
  }

  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('assistant.sessionExpired'));
  }
  if (response.status === 429) {
    // The daily AI budget or too many requests at once (`server/llmBudget.ts`).
    const body: unknown = await response.json().catch(() => null);
    throw new Error(serverErrorText(body, 'assistant.requestFailed', { status: 429 }));
  }
  if (!response.ok || !response.body) {
    throw new Error(t('assistant.requestFailed', { status: response.status }));
  }

  const parser = createNdjsonParser();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      for (const event of parser.push(value)) {
        params.onEvent(event);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { aborted: true };
    }
    throw err;
  }

  const tail = parser.finish();
  for (const event of tail.events) {
    params.onEvent(event);
  }
  if (tail.error) {
    params.onEvent({ t: 'error', message: tail.error });
  }
  return { truncated: tail.truncated };
}
