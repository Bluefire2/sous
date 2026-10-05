import { t } from '../i18n';
import type { EncodedImage } from './image';
import { invalidateSession } from './session';
import { normalizeRecipeDraft } from './recipeShape';
import type { Recipe, RecipeDraft } from './types';

export interface OutgoingMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: EncodedImage[];
}

export interface CookingState {
  servings: number;
  currentStep: number;
  checkedIngredients: string[];
}

/**
 * Photos per message. Mirrors `MAX_CHAT_IMAGES` in `api/chat.ts`, which stays
 * authoritative and answers 400 above it; the composer stops attaching at the
 * cap so a message never fails for a fifth photo.
 */
export const MAX_CHAT_PHOTOS = 4;

/**
 * The recipe posted to `/api/chat`. `lang` is removed so the request stays
 * the same shape it had before the field existed.
 */
export function recipeForChat(recipe: Recipe): Recipe {
  const posted: Recipe = { ...recipe };
  delete posted.lang;
  return posted;
}

export interface ChatReply {
  text: string;
  /** Present when the assistant proposed a recipe modification. */
  proposedRecipe?: RecipeDraft;
  /** The stream ended without its terminator, so the reply is cut off. */
  truncated: boolean;
}

/**
 * Streams an assistant reply. Calls `onDelta` with the text so far on every
 * chunk and resolves with the complete reply. A proposed recipe update, if
 * any, arrives after an ASCII Record Separator (0x1E) as JSON.
 */
export async function streamChatReply(params: {
  messages: OutgoingMessage[];
  recipe: Recipe;
  cookingState?: CookingState;
  onDelta: (textSoFar: string) => void;
  signal?: AbortSignal;
}): Promise<ChatReply> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: params.messages,
      recipe: recipeForChat(params.recipe),
      cookingState: params.cookingState,
    }),
    signal: params.signal,
  });

  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  if (!response.ok || !response.body) {
    throw new Error(t('error.assistantRequestFailed', { status: response.status }));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    params.onDelta(raw.split('\x1E')[0]);
  }

  // A function killed by the platform looks exactly like a clean `done` to the reader —
  // only the trailing separator distinguishes a complete reply from a cut-off one.
  const parts = raw.split('\x1E');
  const complete = parts.length >= 3;
  const text = parts[0];
  let proposedRecipe: RecipeDraft | undefined;
  if (complete && parts[1]) {
    try {
      proposedRecipe = normalizeRecipeDraft(JSON.parse(parts[1]));
    } catch {
      // Truncated/malformed proposal — keep the text reply.
    }
  }
  return { text, proposedRecipe, truncated: !complete };
}
