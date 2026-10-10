import { t } from '../i18n';
import { onSessionReset } from '../lib/session';
import type { AgentServerEvent, AgentWireCard, AgentWireMessage } from './protocol';

/** Same string as server/agent/harness/types.ts. Duplicated because the client cannot import server/. */
const ASSISTANT_UNAVAILABLE_CODE = 'assistant_unavailable';

export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards?: AgentWireCard[];
  interim?: boolean;
};

export type MoveApplyStatus =
  | { phase: 'applying' }
  | { phase: 'applied'; moved: number }
  | { phase: 'error'; message: string };

export type AgentState = {
  messages: AgentMessage[];
  checked: Record<string, Record<string, true>>;
  applies: Record<string, MoveApplyStatus>;
  /** True from the moment a collection move starts until that apply settles. Survives Clear. */
  moveBusy: boolean;
  streaming: boolean;
  error: string | null;
  toolLabel: string | null;
};

export const initialAgentState: AgentState = {
  messages: [],
  checked: {},
  applies: {},
  moveBusy: false,
  streaming: false,
  error: null,
  toolLabel: null,
};

function cardIdOnThread(state: AgentState, cardId: string): boolean {
  for (const message of state.messages) {
    if (message.cards?.some((card) => card.id === cardId)) {
      return true;
    }
  }
  return false;
}

export function beginMoveApplyState(state: AgentState, cardId: string): AgentState {
  if (state.moveBusy || !cardIdOnThread(state, cardId)) {
    return state;
  }
  return {
    ...state,
    moveBusy: true,
    applies: { ...state.applies, [cardId]: { phase: 'applying' } },
  };
}

export function finishMoveApplyState(
  state: AgentState,
  cardId: string,
  status: { phase: 'applied'; moved: number } | { phase: 'error'; message: string },
): AgentState {
  if (!cardIdOnThread(state, cardId)) {
    return state;
  }
  return {
    ...state,
    applies: { ...state.applies, [cardId]: status },
  };
}

function newId(): string {
  return crypto.randomUUID();
}

function lastAssistant(state: AgentState): AgentMessage | undefined {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === 'assistant') {
    return last;
  }
  return undefined;
}

function appendAssistant(state: AgentState, partial: Omit<AgentMessage, 'id' | 'role'>): AgentState {
  const message: AgentMessage = {
    id: newId(),
    role: 'assistant',
    ...partial,
  };
  return { ...state, messages: [...state.messages, message] };
}

function updateLastAssistant(
  state: AgentState,
  update: (msg: AgentMessage) => AgentMessage,
): AgentState {
  const idx = state.messages.length - 1;
  const last = state.messages[idx];
  if (!last || last.role !== 'assistant') {
    return state;
  }
  const next = [...state.messages];
  next[idx] = update(last);
  return { ...state, messages: next };
}

/**
 * A turn that ends on interim narration keeps it as the reply. Replay skips
 * interim messages, so otherwise the next request would carry two user turns.
 */
function settleInterim(state: AgentState): AgentState {
  const last = lastAssistant(state);
  if (!last?.interim) {
    return state;
  }
  return updateLastAssistant(state, (msg) => ({ ...msg, interim: false }));
}

export function applyEvent(state: AgentState, event: AgentServerEvent): AgentState {
  switch (event.t) {
    case 'text': {
      let next = state;
      const current = lastAssistant(next);
      if (current?.interim) {
        next = appendAssistant(next, { content: event.d });
      } else if (current && next.streaming) {
        next = updateLastAssistant(next, (msg) => ({
          ...msg,
          content: msg.content + event.d,
        }));
      } else {
        next = appendAssistant(next, { content: event.d });
      }
      return { ...next, toolLabel: null };
    }
    case 'interim': {
      let next = state;
      const current = lastAssistant(next);
      if (!current || !next.streaming) {
        next = appendAssistant(next, { content: '', interim: true });
      } else {
        next = updateLastAssistant(next, (msg) => ({ ...msg, interim: true }));
      }
      return next;
    }
    case 'card': {
      let next = state;
      const current = lastAssistant(next);
      if (!current || !next.streaming) {
        next = appendAssistant(next, { content: '', cards: [event.card] });
      } else {
        next = updateLastAssistant(next, (msg) => ({
          ...msg,
          cards: [...(msg.cards ?? []), event.card],
        }));
      }
      return next;
    }
    case 'tool': {
      if (event.phase === 'start') {
        return { ...state, toolLabel: event.name };
      }
      return state;
    }
    case 'error': {
      const message =
        event.code === ASSISTANT_UNAVAILABLE_CODE
          ? t('assistant.couldntAnswer')
          : event.message;
      return { ...settleInterim(state), error: message, streaming: false };
    }
    case 'done':
      return { ...settleInterim(state), streaming: false };
    default:
      return state;
  }
}

export function toggleChecked(state: AgentState, cardId: string, itemKey: string): AgentState {
  const card = state.checked[cardId] ?? {};
  const nextCard = { ...card };
  if (nextCard[itemKey]) {
    delete nextCard[itemKey];
  } else {
    nextCard[itemKey] = true;
  }
  const checked = { ...state.checked };
  if (Object.keys(nextCard).length === 0) {
    delete checked[cardId];
  } else {
    checked[cardId] = nextCard;
  }
  return { ...state, checked };
}

export function clearThread(state: AgentState): AgentState {
  if (state.moveBusy) {
    return { ...initialAgentState, moveBusy: true };
  }
  return { ...initialAgentState };
}

export function endMoveBusyState(state: AgentState): AgentState {
  if (!state.moveBusy) {
    return state;
  }
  return { ...state, moveBusy: false };
}

export function beginTurn(state: AgentState, userText: string): AgentState {
  const userMessage: AgentMessage = {
    id: newId(),
    role: 'user',
    content: userText,
  };
  return {
    ...state,
    messages: [...state.messages, userMessage],
    streaming: true,
    error: null,
    toolLabel: null,
  };
}

/** Replay keeps the proposal summary. The id lists stay on the in-memory card for apply. */
function collectionMoveReplayData(data: unknown): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  const record = data as Record<string, unknown>;
  return {
    destination: record.destination,
    preview: record.preview,
    total: record.total,
  };
}

function collectionCreateReplayData(data: unknown): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  const record = data as Record<string, unknown>;
  return {
    name: record.name,
    preview: record.preview,
    total: record.total,
  };
}

function wireCards(cards: AgentWireCard[]): AgentWireCard[] {
  return cards.map((c) => ({
    type: c.type,
    v: c.v,
    id: c.id,
    data:
      c.type === 'collection_move'
        ? collectionMoveReplayData(c.data)
        : c.type === 'collection_create'
          ? collectionCreateReplayData(c.data)
          : c.data,
  }));
}

/** Keep partial text, clear the interim flag, and label the reply so it replays. */
export function markStopped(state: AgentState): AgentState {
  if (!state.streaming) {
    return state;
  }
  const label = t('assistant.stopped');
  const settled = { ...state, streaming: false, toolLabel: null };
  const last = lastAssistant(state);
  if (!last) {
    return appendAssistant(settled, { content: label });
  }
  return updateLastAssistant(settled, (msg) => ({
    ...msg,
    interim: false,
    content: msg.content === '' ? label : `${msg.content}\n\n${label}`,
  }));
}

export function messagesForReplay(state: AgentState): AgentWireMessage[] {
  const out: AgentWireMessage[] = [];
  let carried: AgentWireCard[] = [];

  const takeCarried = (): AgentWireCard[] => {
    const cards = carried;
    carried = [];
    return cards;
  };

  const pushAssistant = (content: string, cards: AgentWireCard[]) => {
    const wire: AgentWireMessage = { role: 'assistant', content };
    if (cards.length > 0) {
      wire.cards = cards;
    }
    out.push(wire);
  };

  for (const m of state.messages) {
    const own = m.cards && m.cards.length > 0 ? wireCards(m.cards) : [];
    if (m.interim) {
      if (own.length > 0) {
        carried = [...carried, ...own];
      }
      continue;
    }
    if (m.role === 'assistant') {
      pushAssistant(m.content, [...takeCarried(), ...own]);
      continue;
    }
    if (carried.length > 0) {
      pushAssistant('', takeCarried());
    }
    const wire: AgentWireMessage = { role: 'user', content: m.content };
    if (own.length > 0) {
      wire.cards = own;
    }
    out.push(wire);
  }
  if (carried.length > 0) {
    pushAssistant('', takeCarried());
  }
  return out;
}

type AgentAction =
  | { type: 'event'; event: AgentServerEvent }
  | { type: 'toggle'; cardId: string; itemKey: string }
  | { type: 'beginMoveApply'; cardId: string }
  | { type: 'endMoveBusy' }
  | {
      type: 'finishMoveApply';
      cardId: string;
      status: { phase: 'applied'; moved: number } | { phase: 'error'; message: string };
    }
  | { type: 'clear' }
  | { type: 'begin'; userText: string }
  | { type: 'stopped' };

let state: AgentState = { ...initialAgentState };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function reduce(current: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'event':
      return applyEvent(current, action.event);
    case 'toggle':
      return toggleChecked(current, action.cardId, action.itemKey);
    case 'beginMoveApply':
      return beginMoveApplyState(current, action.cardId);
    case 'endMoveBusy':
      return endMoveBusyState(current);
    case 'finishMoveApply':
      return finishMoveApplyState(current, action.cardId, action.status);
    case 'clear':
      return clearThread(current);
    case 'begin':
      return beginTurn(current, action.userText);
    case 'stopped':
      return markStopped(current);
    default:
      return current;
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentSnapshot(): AgentState {
  return state;
}

export function dispatch(action: AgentAction): void {
  state = reduce(state, action);
  emit();
}

/**
 * The in-flight request lives beside the thread, not in the screen, so Stop
 * still works after the screen remounts and Clear or sign-out can end it.
 */
let activeRequest: AbortController | null = null;

export function beginAgentRequest(): AbortController {
  activeRequest?.abort();
  activeRequest = new AbortController();
  return activeRequest;
}

/** False once Clear, sign-out, or a newer turn has replaced this request. */
export function isActiveAgentRequest(controller: AbortController): boolean {
  return activeRequest === controller;
}

export function endAgentRequest(controller: AbortController): void {
  if (activeRequest === controller) {
    activeRequest = null;
  }
}

/** Stop keeps the request active so its partial reply is labelled Stopped. */
export function stopAgentRequest(): void {
  activeRequest?.abort();
}

function discardAgentRequest(): void {
  const controller = activeRequest;
  activeRequest = null;
  controller?.abort();
}

export function clearAgentThread(): void {
  discardAgentRequest();
  dispatch({ type: 'clear' });
}

onSessionReset(() => {
  discardAgentRequest();
  dispatch({ type: 'clear' });
});
