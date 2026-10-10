import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { LOCALE_KEY } from '../lib/settings';
import { invalidateSession } from '../lib/session';
import {
  applyEvent,
  beginAgentRequest,
  beginMoveApplyState,
  beginTurn,
  clearAgentThread,
  clearThread,
  dispatch,
  endAgentRequest,
  endMoveBusyState,
  finishMoveApplyState,
  getAgentSnapshot,
  isActiveAgentRequest,
  initialAgentState,
  markStopped,
  messagesForReplay,
  stopAgentRequest,
  toggleChecked,
} from './store';

const clearLibraryMock = vi.fn();

vi.mock('../lib/libraryMemory', () => ({
  clearLibrary: () => clearLibraryMock(),
}));

beforeEach(() => {
  clearAgentThread();
  dispatch({ type: 'endMoveBusy' });
  const store = new Map<string, string>([[LOCALE_KEY, 'en']]);
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
});

afterEach(() => {
  clearAgentThread();
  vi.restoreAllMocks();
});

describe('applyEvent', () => {
  it('streams text into one assistant message', () => {
    let state = beginTurn(initialAgentState, 'hello');
    state = applyEvent(state, { t: 'text', step: 1, d: 'Hi ' });
    state = applyEvent(state, { t: 'text', step: 1, d: 'there' });
    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toBe('Hi there');
  });

  it('starts a new assistant message after interim text', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'text', step: 1, d: 'draft' });
    state = applyEvent(state, { t: 'interim', step: 1 });
    state = applyEvent(state, { t: 'text', step: 2, d: 'final' });
    const assistants = state.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.interim).toBe(true);
    expect(assistants[0]?.content).toBe('draft');
    expect(assistants[1]?.content).toBe('final');
    expect(messagesForReplay(state).map((m) => m.content)).toEqual(['q', 'final']);
  });

  it('carries cards from an interim message onto the next assistant reply', () => {
    let state = beginTurn(initialAgentState, 'list');
    const card = { type: 'shopping_list', v: 1, id: 'c1', data: { title: 'Shop' } };
    state = applyEvent(state, { t: 'text', step: 1, d: 'draft' });
    state = applyEvent(state, { t: 'interim', step: 1 });
    state = applyEvent(state, { t: 'card', card });
    state = applyEvent(state, { t: 'text', step: 2, d: 'final' });
    const replay = messagesForReplay(state);
    expect(replay.map((m) => m.content)).toEqual(['list', 'final']);
    expect(replay[1]?.cards).toEqual([card]);
  });

  it('replays a collection move without the recipe id lists', () => {
    let state = beginTurn(initialAgentState, 'move');
    const data = {
      destination: { kind: 'unfiled' },
      recipeIds: ['r1', 'r2'],
      sources: [{ id: 'r1', from: { kind: 'unfiled' } }],
      preview: [{ id: 'r1', title: 'One', from: { kind: 'unfiled' } }],
      total: 2,
    };
    const card = { type: 'collection_move', v: 1, id: 'c-move', data };
    state = applyEvent(state, { t: 'card', card });
    const replay = messagesForReplay(state);
    expect(replay[1]?.cards).toEqual([
      {
        type: 'collection_move',
        v: 1,
        id: 'c-move',
        data: {
          destination: data.destination,
          preview: data.preview,
          total: data.total,
        },
      },
    ]);
    expect(state.messages[state.messages.length - 1]?.cards?.[0]?.data).toEqual(data);
  });

  it('replays a collection create without the recipe id lists', () => {
    let state = beginTurn(initialAgentState, 'create');
    const data = {
      name: 'Soups',
      recipeIds: ['r1', 'r2'],
      sources: [{ id: 'r1', from: { kind: 'unfiled' } }],
      preview: [{ id: 'r1', title: 'One', from: { kind: 'unfiled' } }],
      total: 2,
    };
    const card = { type: 'collection_create', v: 1, id: 'c-create', data };
    state = applyEvent(state, { t: 'card', card });
    const replay = messagesForReplay(state);
    expect(replay[1]?.cards).toEqual([
      {
        type: 'collection_create',
        v: 1,
        id: 'c-create',
        data: {
          name: data.name,
          preview: data.preview,
          total: data.total,
        },
      },
    ]);
    expect(state.messages[state.messages.length - 1]?.cards?.[0]?.data).toEqual(data);
  });

  it('keeps interim cards when no later assistant text arrives', () => {
    let state = beginTurn(initialAgentState, 'list');
    const card = { type: 'shopping_list', v: 1, id: 'c1', data: {} };
    state = applyEvent(state, { t: 'text', step: 1, d: 'draft' });
    state = applyEvent(state, { t: 'interim', step: 1 });
    state = applyEvent(state, { t: 'card', card });
    const replay = messagesForReplay(state);
    expect(replay.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(replay[1]?.content).toBe('');
    expect(replay[1]?.cards).toEqual([card]);
  });

  it('labels a stopped reply and replays it', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'text', step: 1, d: 'partial' });
    state = markStopped(state);
    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.interim).toBe(false);
    expect(assistant?.content).toBe(`partial\n\n${t('assistant.stopped')}`);
    expect(state.streaming).toBe(false);
    expect(messagesForReplay(state).map((m) => m.content)).toEqual([
      'q',
      `partial\n\n${t('assistant.stopped')}`,
    ]);
  });

  it('records tool label and clears on non-interim text', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'tool', name: 'search_recipes', phase: 'start' });
    expect(state.toolLabel).toBe('search_recipes');
    state = applyEvent(state, { t: 'text', step: 1, d: 'answer' });
    expect(state.toolLabel).toBeNull();
  });

  it('attaches cards to the streaming assistant message', () => {
    let state = beginTurn(initialAgentState, 'list');
    const card = { type: 'shopping_list', v: 1, id: 'c1', data: {} };
    state = applyEvent(state, { t: 'card', card });
    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.cards).toEqual([card]);
  });

  it('sets error and stops streaming on error event', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'error', message: 'nope' });
    expect(state.error).toBe('nope');
    expect(state.streaming).toBe(false);
  });

  it('shows the catalog sentence for assistant_unavailable', () => {
    localStorage.setItem(LOCALE_KEY, 'uk');
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, {
      t: 'error',
      code: 'assistant_unavailable',
      message: "The assistant couldn't answer that.",
    });
    expect(state.error).toBe('Помічник не зміг на це відповісти.');
    expect(state.error).toBe(t('assistant.couldntAnswer'));
  });

  it('ends streaming on done', () => {
    let state = beginTurn(initialAgentState, 'q');
    state = applyEvent(state, { t: 'done' });
    expect(state.streaming).toBe(false);
  });

  it('keeps interim narration as the reply when the turn errors', () => {
    let state = beginTurn(initialAgentState, 'q1');
    state = applyEvent(state, { t: 'text', step: 1, d: 'Let me look.' });
    state = applyEvent(state, { t: 'interim', step: 1 });
    state = applyEvent(state, { t: 'error', code: 'assistant_unavailable', message: 'x' });
    state = applyEvent(state, { t: 'done' });
    state = beginTurn(state, 'q2');
    const replay = messagesForReplay(state);
    expect(replay.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(replay[1]?.content).toBe('Let me look.');
  });
});

describe('toggleChecked', () => {
  it('toggles item keys per card', () => {
    let state = initialAgentState;
    state = toggleChecked(state, 'card-1', 'onion');
    expect(state.checked['card-1']?.onion).toBe(true);
    state = toggleChecked(state, 'card-1', 'onion');
    expect(state.checked['card-1']).toBeUndefined();
  });
});

describe('session reset', () => {
  it('clears the thread when invalidateSession runs', () => {
    dispatch({ type: 'begin', userText: 'keep?' });
    dispatch({ type: 'event', event: { t: 'text', step: 1, d: 'x' } });
    expect(getAgentSnapshot().messages.length).toBeGreaterThan(0);
    invalidateSession();
    expect(getAgentSnapshot()).toEqual(initialAgentState);
  });
});

function stateWithMoveCard(cardId: string) {
  let state = beginTurn(initialAgentState, 'move');
  const card = { type: 'collection_move', v: 1, id: cardId, data: {} };
  state = applyEvent(state, { t: 'card', card });
  return state;
}

describe('move apply state', () => {
  it('beginMoveApplyState sets applying when the card is on the thread', () => {
    const state = stateWithMoveCard('move-1');
    const next = beginMoveApplyState(state, 'move-1');
    expect(next.applies['move-1']).toEqual({ phase: 'applying' });
    expect(next.moveBusy).toBe(true);
  });

  it('beginMoveApplyState is unchanged when the card is not on the thread', () => {
    const state = stateWithMoveCard('move-1');
    const next = beginMoveApplyState(state, 'other');
    expect(next).toBe(state);
  });

  it('finishMoveApplyState sets applied or error when the card is on the thread', () => {
    const state = stateWithMoveCard('move-1');
    const applied = finishMoveApplyState(state, 'move-1', { phase: 'applied', moved: 3 });
    expect(applied.applies['move-1']).toEqual({ phase: 'applied', moved: 3 });
    const errored = finishMoveApplyState(state, 'move-1', {
      phase: 'error',
      message: 'nope',
    });
    expect(errored.applies['move-1']).toEqual({ phase: 'error', message: 'nope' });
  });

  it('clearThread keeps moveBusy until the apply settles', () => {
    let state = stateWithMoveCard('move-1');
    state = beginMoveApplyState(state, 'move-1');
    state = clearThread(state);
    expect(state.messages).toEqual([]);
    expect(state.applies).toEqual({});
    expect(state.moveBusy).toBe(true);
    state = endMoveBusyState(state);
    expect(state.moveBusy).toBe(false);
    expect(state).toEqual(initialAgentState);
  });

  it('finishMoveApplyState is unchanged after clearThread', () => {
    let state = stateWithMoveCard('move-1');
    state = beginMoveApplyState(state, 'move-1');
    state = clearThread(state);
    const next = finishMoveApplyState(state, 'move-1', { phase: 'applied', moved: 1 });
    expect(next.applies).toEqual({});
    expect(next).toBe(state);
  });

  it('dispatch wires begin and finish move apply', () => {
    dispatch({ type: 'begin', userText: 'move' });
    dispatch({
      type: 'event',
      event: {
        t: 'card',
        card: { type: 'collection_move', v: 1, id: 'c-move', data: {} },
      },
    });
    dispatch({ type: 'beginMoveApply', cardId: 'c-move' });
    expect(getAgentSnapshot().applies['c-move']).toEqual({ phase: 'applying' });
    dispatch({
      type: 'finishMoveApply',
      cardId: 'c-move',
      status: { phase: 'applied', moved: 2 },
    });
    expect(getAgentSnapshot().applies['c-move']).toEqual({ phase: 'applied', moved: 2 });
  });
});

describe('move apply mutex', () => {
  it('beginMoveApplyState refuses while another apply is in flight', () => {
    let state = stateWithMoveCard('move-1');
    state = applyEvent(state, {
      t: 'card',
      card: { type: 'collection_move', v: 1, id: 'move-2', data: {} },
    });
    state = beginMoveApplyState(state, 'move-1');
    const next = beginMoveApplyState(state, 'move-2');
    expect(next).toBe(state);
    expect(next.applies['move-2']).toBeUndefined();
    state = endMoveBusyState(state);
    expect(beginMoveApplyState(state, 'move-2').applies['move-2']).toEqual({
      phase: 'applying',
    });
  });

  it('clearThread does not release the in-flight apply', () => {
    dispatch({ type: 'begin', userText: 'move' });
    dispatch({
      type: 'event',
      event: { t: 'card', card: { type: 'collection_move', v: 1, id: 'c-move', data: {} } },
    });
    dispatch({ type: 'beginMoveApply', cardId: 'c-move' });
    dispatch({ type: 'clear' });
    expect(getAgentSnapshot().moveBusy).toBe(true);
    dispatch({ type: 'endMoveBusy' });
    expect(getAgentSnapshot().moveBusy).toBe(false);
  });
});

describe('agent request', () => {
  it('Clear aborts and retires a streaming request', () => {
    const controller = beginAgentRequest();
    dispatch({ type: 'begin', userText: 'q' });
    clearAgentThread();
    expect(controller.signal.aborted).toBe(true);
    expect(isActiveAgentRequest(controller)).toBe(false);
  });

  it('sign-out aborts and retires a streaming request', () => {
    const controller = beginAgentRequest();
    dispatch({ type: 'begin', userText: 'q' });
    invalidateSession();
    expect(controller.signal.aborted).toBe(true);
    expect(isActiveAgentRequest(controller)).toBe(false);
  });

  it('Stop aborts but keeps the request active so it can be labelled', () => {
    const controller = beginAgentRequest();
    stopAgentRequest();
    expect(controller.signal.aborted).toBe(true);
    expect(isActiveAgentRequest(controller)).toBe(true);
    endAgentRequest(controller);
    expect(isActiveAgentRequest(controller)).toBe(false);
  });

  it('a newer request replaces and aborts the old one', () => {
    const first = beginAgentRequest();
    const second = beginAgentRequest();
    expect(first.signal.aborted).toBe(true);
    expect(isActiveAgentRequest(first)).toBe(false);
    endAgentRequest(first);
    expect(isActiveAgentRequest(second)).toBe(true);
    endAgentRequest(second);
  });
});
