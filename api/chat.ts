import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GoogleGenAI,
  Type,
  type Content,
  type GenerateContentResponseUsageMetadata,
  type Part,
  type Schema,
} from '@google/genai';

// NOTE: Duplicated in server/session.ts + server/allowlist.ts.
// This inline copy is the Vercel gate and must stay in sync with those files.
// On Cloud Run it is bypassed by an explicit authorizedSub argument after
// requireMember passed in scripts/server.ts; server/membership.ts is authoritative.

const SESSION_COOKIE_NAME = 'sous_session';

function parseAllowedEmails(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (email !== '') {
      out.add(email);
    }
  }
  return out;
}

function isEmailAllowed(email: string, raw: string): boolean {
  if (raw.trim() === '') {
    return false;
  }
  const normalized = email.trim().toLowerCase();
  if (normalized === '') {
    return false;
  }
  return parseAllowedEmails(raw).has(normalized);
}

function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key !== SESSION_COOKIE_NAME) {
      continue;
    }
    return trimmed.slice(eq + 1);
  }
  return null;
}

export function sessionSub(req: Request): string | null {
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret.trim() === '') {
    return null;
  }
  const token = readSessionCookie(req);
  if (token === null) {
    return null;
  }
  const dot = token.indexOf('.');
  if (dot === -1 || token.indexOf('.', dot + 1) !== -1) {
    return null;
  }
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (sigPart === '' || /[^A-Za-z0-9_-]/.test(sigPart)) {
    return null;
  }
  const actual = Buffer.from(sigPart, 'base64url');
  if (actual.toString('base64url') !== sigPart) {
    return null;
  }
  const expected = createHmac('sha256', secret).update(payloadPart).digest();
  if (expected.length !== actual.length) {
    return null;
  }
  if (!timingSafeEqual(expected, actual)) {
    return null;
  }
  if (payloadPart === '' || /[^A-Za-z0-9_-]/.test(payloadPart)) {
    return null;
  }
  const payloadBuf = Buffer.from(payloadPart, 'base64url');
  if (payloadBuf.toString('base64url') !== payloadPart) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const row = parsed as {
    v?: unknown;
    sub?: unknown;
    email?: unknown;
    iat?: unknown;
    exp?: unknown;
  };
  if (row.v !== 1) {
    return null;
  }
  if (typeof row.sub !== 'string' || row.sub === '') {
    return null;
  }
  if (typeof row.email !== 'string') {
    return null;
  }
  // Same as verifySession in server/session.ts: both timestamps must be numbers.
  if (typeof row.iat !== 'number' || typeof row.exp !== 'number' || row.exp <= Date.now()) {
    return null;
  }
  if (!isEmailAllowed(row.email, process.env.ALLOWED_EMAILS ?? '')) {
    return null;
  }
  return row.sub;
}

// NOTE: Duplicated in server/recipeImport.ts. Vercel's function runtime transpiles
// each api/ entrypoint in isolation and cannot import sibling helper files,
// so the schema must live inline. Keep both copies in sync.
const RECIPE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    description: { type: Type.STRING, description: 'One or two sentences.' },
    servings: { type: Type.NUMBER },
    prepMinutes: { type: Type.NUMBER },
    cookMinutes: { type: Type.NUMBER },
    ingredientSections: {
      type: Type.ARRAY,
      description:
        'Use a single unnamed section unless the recipe clearly has component groups like "Sauce" and "Dough".',
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                quantity: { type: Type.NUMBER, description: 'e.g. 0.5 for ½' },
                unit: {
                  type: Type.STRING,
                  description:
                    'Prefer one of: piece, tsp, tbsp, cup, ml, l, g, kg, oz, lb. Use "piece" for countable items when a unit reads naturally; omit the unit entirely for items counted without one. If none of these fit, use a short lowercase unit.',
                },
                item: { type: Type.STRING, description: 'The ingredient itself' },
                note: { type: Type.STRING, description: 'e.g. "thinly sliced"' },
              },
              required: ['item'],
            },
          },
        },
        required: ['items'],
      },
    },
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { text: { type: Type.STRING } },
        required: ['text'],
      },
    },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '2-4 short lowercase tags like "pasta", "weeknight".',
    },
    notes: { type: Type.STRING, description: 'Tips or variations worth keeping.' },
  },
  required: ['title', 'servings', 'ingredientSections', 'steps', 'tags'],
};

export interface ChatRequestImage {
  /** e.g. "image/jpeg" */
  mediaType: string;
  /** Raw base64, no data-URL prefix. */
  base64: string;
}

export interface ChatRequestMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: ChatRequestImage[];
}

export interface ChatRequestBody {
  messages: ChatRequestMessage[];
  /** The full recipe JSON the user is currently viewing. */
  recipe: unknown;
  /** Where the user is in the cook: current step, checked ingredients, servings. */
  cookingState?: unknown;
}

// NOTE: The request limits and checks below follow server/importRoute.ts
// (MAX_IMPORT_*, IMPORT_IMAGE_TYPES, checkImportImages) and the bounded reader
// follows readBoundedText in server/membership.ts (past the limit it releases
// the body for the dispatcher to drop rather than cancelling it). They are
// copied, not imported, for the same Vercel reason as the session gate above.
// Unlike readBoundedText, the copy rethrows a failed body read as is, not as
// RequestBodyError; on Cloud Run the dispatcher's isRequestAbort
// (scripts/server.ts) keeps a client hang-up mid-upload out of the log.

/**
 * Photos per message. The client sends photos only on the newest message,
 * and import takes at most four of one recipe.
 */
export const MAX_CHAT_IMAGES = 4;
/**
 * Decoded bytes, per photo. The client re-encodes each photo as a JPEG of at
 * most 1280 px on its long edge (encodeImageForChat), a few hundred KB; import
 * allows 3 MB for its larger 2048 px photos.
 */
export const MAX_CHAT_IMAGE_BYTES = 3 * 1024 * 1024;
/**
 * Raw request body, the same as import. Recipe JSON and a text-only history are
 * tens of KB, so nearly all of it is photos. Four photos at the per-photo cap
 * exceed it, as with import.
 */
export const MAX_CHAT_BODY_BYTES = 12 * 1024 * 1024;
/**
 * Message text, summed over the thread. Without it the 12 MB body could be
 * almost all text, enough to fill the model's context in one paid request.
 * The client drops the oldest messages to fit (`MAX_CHAT_HISTORY_CHARS` in
 * src/lib/chatApi.ts mirrors it).
 */
export const MAX_CHAT_TEXT_CHARS = 120_000;
/**
 * `recipe` plus `cookingState` as JSON. A stored recipe is under 200 000 JSON
 * chars (validateRecipePut in server/store.ts), so any real one fits.
 */
export const MAX_CHAT_CONTEXT_CHARS = 210_000;
const CHAT_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ASSISTANT_UNAVAILABLE = 'Assistant is unavailable.';

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

/** The body as text, or null when it is longer than `limit` bytes. */
async function readBoundedBody(req: Request, limit: number): Promise<string | null> {
  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    const len = Number(contentLength);
    if (Number.isFinite(len) && len > limit) {
      return null;
    }
  }
  if (req.body === null) {
    return '';
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        reader.releaseLock();
        return null;
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function parseChatImages(raw: unknown): ChatRequestImage[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CHAT_IMAGES) {
    return null;
  }
  const images: ChatRequestImage[] = [];
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.mediaType !== 'string' || typeof item.base64 !== 'string') {
      return null;
    }
    const mediaType = item.mediaType.trim().toLowerCase();
    if (!CHAT_IMAGE_TYPES.has(mediaType)) {
      return null;
    }
    const base64 = item.base64;
    if (base64 === '' || base64.length % 4 !== 0 || !BASE64.test(base64)) {
      return null;
    }
    if (decodedBytes(base64) > MAX_CHAT_IMAGE_BYTES) {
      return null;
    }
    images.push({ mediaType, base64 });
  }
  return images;
}

/** The request body when its shape is valid, else null. Unknown keys are dropped. */
export function parseChatRequest(raw: unknown): ChatRequestBody | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return null;
  }
  if (!isPlainObject(raw.recipe)) {
    return null;
  }
  const messages: ChatRequestMessage[] = [];
  let textChars = 0;
  for (const item of raw.messages) {
    if (!isPlainObject(item)) {
      return null;
    }
    if (item.role !== 'user' && item.role !== 'assistant') {
      return null;
    }
    if (typeof item.content !== 'string') {
      return null;
    }
    textChars += item.content.length;
    if (textChars > MAX_CHAT_TEXT_CHARS) {
      return null;
    }
    const message: ChatRequestMessage = { role: item.role, content: item.content };
    if (item.images !== undefined) {
      const images = parseChatImages(item.images);
      if (images === null) {
        return null;
      }
      message.images = images;
    }
    messages.push(message);
  }
  const contextChars =
    JSON.stringify(raw.recipe).length + (JSON.stringify(raw.cookingState) ?? '').length;
  if (contextChars > MAX_CHAT_CONTEXT_CHARS) {
    return null;
  }
  return { messages, recipe: raw.recipe, cookingState: raw.cookingState };
}

/**
 * A high estimate of the prompt's tokens, for a stream that ended before it
 * reported usage: one token per character (no script uses more), the
 * update_recipe schema included, and 1 300 per photo.
 */
export function estimatedPromptTokens(system: string, messages: ChatRequestMessage[]): number {
  let chars = system.length + JSON.stringify(RECIPE_SCHEMA).length;
  let photos = 0;
  for (const m of messages) {
    chars += m.content.length;
    photos += m.images?.length ?? 0;
  }
  return chars + photos * 1300;
}

/**
 * A thrown error's class and numeric status, and nothing else. An SDK message
 * can quote the request, and this one carries the whole recipe and the
 * conversation. Mirrors sanitizedError in server/importLog.ts.
 */
function describeThrown(err: unknown): string {
  const rawName = err instanceof Error ? err.name : typeof err;
  const name = /^[A-Za-z]{1,40}$/.test(rawName) ? rawName : 'Error';
  let status: number | undefined;
  if (typeof err === 'object' && err !== null) {
    const raw = (err as { status?: unknown }).status;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599) {
      status = raw;
    }
  }
  return `${name}${status === undefined ? '' : ` (status ${status})`}; message withheld`;
}

// `??` is wrong here: `node --env-file` turns a bare `CHAT_MODEL=` into `''`, which is not nullish.
const MODEL = process.env.CHAT_MODEL || 'gemini-3.8-flash';

// A turn that triggers update_recipe streams a text reply and then the complete recipe JSON —
// the slowest response this app produces, so Vercel's 10s default can kill it.
export const maxDuration = 60;

/**
 * Rules for the member's kitchen profile. The block itself is built on Cloud
 * Run by `kitchenProfilePromptBlock` in `server/kitchenProfile.ts` (this file
 * cannot import it) and arrives through the handler context.
 */
const KITCHEN_PROFILE_RULES = [
  'Allergies and foods marked "never include" in the kitchen profile are hard',
  'constraints: never suggest them, and never add them in update_recipe. When',
  'the recipe contains one and the user asks about cooking it, substituting,',
  'or changing it, say so in your text reply, naming the ingredient and the',
  'allergy, before or instead of proposing a safe swap. Follow the diet and',
  'avoid the dislikes in suggestions and changes unless the user asks',
  'otherwise. Use the equipment and notes as background only: never change',
  'servings or anything else the user did not ask about because of them.',
];

/**
 * For a member who chose Metric in Settings (`docs/plans/measurement-units.md`).
 * The app already shows the recipe's pounds, ounces and °F in metric, so Ask
 * writes new amounts in metric and leaves the stored ones alone.
 */
const METRIC_RULES = [
  'The user cooks in metric. Any new quantity or temperature you write, in',
  'your reply or in update_recipe, uses g, kg, ml, l and °C; teaspoons and',
  'tablespoons are fine for small amounts. Do not convert the quantities the',
  'recipe already has unless the user asks: the app shows them in metric.',
];

function systemPrompt(recipe: unknown, cookingState: unknown, kitchenProfile?: string, units?: 'metric'): string {
  const profile =
    kitchenProfile !== undefined && kitchenProfile !== '' ? ['', kitchenProfile, '', ...KITCHEN_PROFILE_RULES] : [];
  const metric = units === 'metric' ? ['', ...METRIC_RULES] : [];
  return [
    'You are a cooking assistant embedded in a personal recipe app. The user',
    'is viewing (and possibly mid-way through cooking) the recipe below, so',
    'they may have messy hands and limited patience: answer concisely and',
    'practically, like a calm chef talking to a home cook. Refer to steps by',
    'their number. If the user sends a photo, assess it honestly against',
    'where they are in the recipe. Reply in plain text only — no markdown',
    'syntax like ** or #, since the app renders your reply verbatim. Use',
    'simple dashes for lists.',
    '',
    'When the user asks you to modify the recipe (substitutions, scaling',
    'techniques, dietary changes, adding/removing components), call the',
    'update_recipe tool with the COMPLETE updated recipe — every field, not',
    'just the changed parts. Briefly say what you changed in your text reply.',
    'The app shows the user a diff and lets them apply it, so do not ask for',
    'permission first. For pure questions, answer without the tool.',
    ...profile,
    ...metric,
    '',
    'Current recipe (JSON):',
    JSON.stringify(recipe),
    '',
    cookingState ? `Cooking state (JSON): ${JSON.stringify(cookingState)}` : '',
  ].join('\n');
}

function toGeminiContents(messages: ChatRequestMessage[]): Content[] {
  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (m.role === 'user' && m.images && m.images.length > 0) {
      const parts: Part[] = m.images.map((img) => ({
        inlineData: { mimeType: img.mediaType, data: img.base64 },
      }));
      if (m.content) parts.push({ text: m.content });
      return { role, parts };
    }
    return { role, parts: [{ text: m.content }] };
  });
}

/**
 * On Cloud Run, `withChatBudget` (server/llmBudget.ts) passes `onUsage`; it is
 * called once per model call with the stream's last reported usage.
 * `withKitchenProfile` (server/kitchenProfile.ts) passes the member's profile
 * block and their measurement units, read from the store, never from the
 * request body.
 */
export interface ChatContext {
  authorizedSub?: string;
  onUsage?: (model: string, usage: GenerateContentResponseUsageMetadata | undefined) => void;
  kitchenProfile?: string;
  units?: 'metric';
}

export async function POST(req: Request, ctx?: ChatContext): Promise<Response> {
  const authorized =
    typeof ctx?.authorizedSub === 'string' && ctx.authorizedSub !== ''
      ? ctx.authorizedSub
      : sessionSub(req);
  if (authorized === null) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rawBody = await readBoundedBody(req, MAX_CHAT_BODY_BYTES);
  if (rawBody === null) {
    return jsonError('Request too large', 413);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return jsonError('Bad request', 400);
  }
  const body = parseChatRequest(parsedJson);
  if (body === null) {
    return jsonError('Bad request', 400);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    return jsonError(ASSISTANT_UNAVAILABLE, 503);
  }

  const ai = new GoogleGenAI({ apiKey });
  const system = systemPrompt(body.recipe, body.cookingState, ctx?.kitchenProfile, ctx?.units);
  const abort = new AbortController();

  let stream: Awaited<ReturnType<typeof ai.models.generateContentStream>>;
  try {
    stream = await ai.models.generateContentStream({
      model: MODEL,
      contents: toGeminiContents(body.messages),
      config: {
        abortSignal: abort.signal,
        systemInstruction: system,
        maxOutputTokens: 4096,
        tools: [
          {
            functionDeclarations: [
              {
                name: 'update_recipe',
                description:
                  'Propose a modified version of the recipe the user is viewing. ' +
                  'Pass the complete updated recipe.',
                parameters: RECIPE_SCHEMA,
              },
            ],
          },
        ],
      },
    });
  } catch (err) {
    console.error(`Chat model call failed: ${describeThrown(err)}`);
    return jsonError(ASSISTANT_UNAVAILABLE, 502);
  }

  // Plain text streams as-is, then a separator (0x1E), then any proposal JSON, then a
  // final separator that marks a clean end. Fewer than three parts means the stream was cut off.
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      // After the client cancels, the stream is already closed and close()
      // or error() would throw out of this detached task as an unhandled
      // rejection, which ends the process.
      const settle = (finish: () => void) => {
        try {
          finish();
        } catch {
          /* already closed by cancel */
        }
      };
      void (async () => {
        let usage: GenerateContentResponseUsageMetadata | undefined;
        let streamedChars = 0;
        try {
          let proposalArgs: Record<string, unknown> | undefined;
          for await (const chunk of stream) {
            if (chunk.usageMetadata) usage = chunk.usageMetadata;
            if (chunk.text) {
              streamedChars += chunk.text.length;
              controller.enqueue(encoder.encode(chunk.text));
            }
            const update = chunk.functionCalls?.find(
              (call) => call.name === 'update_recipe' && call.args,
            );
            if (update?.args) proposalArgs = update.args;
          }
          const proposal = proposalArgs ? JSON.stringify(proposalArgs) : '';
          controller.enqueue(encoder.encode(`\x1E${proposal}\x1E`));
          controller.close();
        } catch (err) {
          if (abort.signal.aborted) {
            settle(() => controller.close());
            return;
          }
          // The dispatcher in scripts/server.ts logs a body error it sees, so
          // pass on a description, never the SDK's error and its message.
          const failure = new Error(`Chat stream failed: ${describeThrown(err)}`);
          settle(() => controller.error(failure));
        } finally {
          // A stream cut off before any usage chunk is still billed for its
          // prompt and what it already wrote, so it is charged an estimate
          // that errs high.
          ctx?.onUsage?.(
            MODEL,
            usage ?? {
              promptTokenCount: estimatedPromptTokens(system, body.messages),
              candidatesTokenCount: streamedChars,
            },
          );
        }
      })();
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
