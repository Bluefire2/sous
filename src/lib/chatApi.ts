import { t } from '../i18n';
import { serverErrorText } from './errorText';
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
 * Message text per request, summed over the thread. Mirrors
 * `MAX_CHAT_TEXT_CHARS` in `api/chat.ts`, which answers 400 above it.
 */
export const MAX_CHAT_HISTORY_CHARS = 120_000;

/**
 * The newest messages whose text fits `MAX_CHAT_HISTORY_CHARS`, oldest
 * dropped first, so a long thread keeps working; the model just no longer
 * sees its start. A trimmed thread starts on a user message, as the
 * conversation does. The newest message is always kept, even alone over the
 * cap (the server then refuses it).
 */
export function fitChatHistory(messages: OutgoingMessage[]): OutgoingMessage[] {
  let chars = 0;
  let start = messages.length;
  while (start > 0) {
    const next = chars + messages[start - 1].content.length;
    if (next > MAX_CHAT_HISTORY_CHARS && start < messages.length) break;
    chars = next;
    start -= 1;
  }
  if (start > 0) {
    while (start < messages.length - 1 && messages[start].role === 'assistant') start += 1;
  }
  return messages.slice(start);
}

/**
 * The recipe posted to `/api/chat`. `lang` and `variantOf` are removed so the
 * request stays the same shape it had before those fields existed.
 */
export function recipeForChat(recipe: Recipe): Recipe {
  const posted: Recipe = { ...recipe };
  delete posted.lang;
  delete posted.variantOf;
  return posted;
}

/**
 * The recipe fields an Ask proposal may leave out (the update_recipe schema
 * in `api/chat.ts`). `title` is not one: a reply without a title is not
 * taken as a recipe, so `{"steps":[]}` cannot become an edit that clears
 * every step.
 */
const FILLED_PROPOSAL_FIELDS = [
  'description',
  'servings',
  'prepMinutes',
  'cookMinutes',
  'ingredientSections',
  'steps',
  'tags',
  'notes',
] as const;

/**
 * The proposal with every field the model left out, except the title, taken
 * from the viewed recipe, so a missing field reads as "unchanged". The schema asks for the
 * complete recipe and marks some fields required, but Gemini does not
 * enforce `required` on function-call arguments and often omits unchanged
 * ones (seen with `servings` on "split the steps for two cooks"). Without
 * this, a missing `servings` dropped the whole proposal (no text, no Apply),
 * and any other missing field would be cleared by Apply without showing in
 * the diff.
 *
 * Only an absent key is filled. A present but invalid value is still
 * rejected by `normalizeRecipeDraft`, and an empty string still clears an
 * optional text field. One known gap: if the model scales the quantities
 * but leaves out `servings`, the old count is kept.
 */
export function withUnchangedFields(proposal: unknown, recipe: Recipe): unknown {
  if (typeof proposal !== 'object' || proposal === null || Array.isArray(proposal)) {
    return proposal;
  }
  const filled: Record<string, unknown> = { ...proposal };
  for (const field of FILLED_PROPOSAL_FIELDS) {
    if (!(field in filled) && recipe[field] !== undefined) {
      filled[field] = recipe[field];
    }
  }
  return filled;
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
      messages: fitChatHistory(params.messages),
      recipe: recipeForChat(params.recipe),
      cookingState: params.cookingState,
    }),
    signal: params.signal,
  });

  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  if (response.status === 429) {
    // The daily AI budget or too many requests at once (`server/llmBudget.ts`).
    const body: unknown = await response.json().catch(() => null);
    throw new Error(serverErrorText(body, 'error.assistantRequestFailed', { status: 429 }));
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
      proposedRecipe = normalizeRecipeDraft(
        withUnchangedFields(JSON.parse(parts[1]), params.recipe),
      );
    } catch {
      // Truncated/malformed proposal — keep the text reply.
    }
  }
  return { text, proposedRecipe, truncated: !complete };
}
