import { GoogleGenAI } from '@google/genai';
import { admitLlm, llmRefusal, meteredAi } from './llmBudget.ts';
import { DEFAULT_LOCALE, toSupportedLocale, type Locale } from './lang.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  requireMember,
} from './membership.ts';

export const MAX_STT_BYTES = 1_048_576;

const STT_MIME = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

const TITLE_MAX_CHARS = 200;

/** English names for the transcription prompt. `zh-Hans` stays "Chinese". */
const STT_LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  uk: 'Ukrainian',
  ru: 'Russian',
  'zh-Hans': 'Chinese',
};

const STT_BAD_LANGUAGE = 'That language is not supported.';

export function normalizeSttContentType(raw: string): string | null {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!STT_MIME.has(base)) {
    return null;
  }
  return base;
}

export function isSttByteCountTooLarge(byteCount: number): boolean {
  return byteCount > MAX_STT_BYTES;
}

export function clipRecipeTitle(raw: string): string {
  const scalars = [...raw].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  return scalars.slice(0, TITLE_MAX_CHARS).join('').trim();
}

/**
 * UI language for `/api/stt`. A missing header is English (old clients).
 * Any other value goes through `normalizeLang` (via `toSupportedLocale`) and
 * must be `en`, `uk`, `ru`, or `zh-Hans`. `undefined` is a bad header.
 */
export function sttLanguageFromHeader(raw: string | null): Locale | undefined {
  if (raw === null) {
    return DEFAULT_LOCALE;
  }
  return toSupportedLocale(raw);
}

/**
 * Recipe title from `x-recipe-title`. When `x-recipe-title-encoding` is
 * `uri`, the value is percent-decoded first. A decode failure means no
 * title. Without the marker the raw value is used (old clients), then clipped.
 */
export function recipeTitleFromHeaders(headers: Headers): string | null {
  const raw = headers.get('x-recipe-title');
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const encoding = headers.get('x-recipe-title-encoding')?.trim().toLowerCase();
  let text = raw;
  if (encoding === 'uri') {
    try {
      text = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return clipRecipeTitle(text) || null;
}

function jsonError(code: string, error: string, status: number): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function parseContentLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function stripTranscript(raw: string): string {
  let text = raw.trim().replace(/\s*\n+\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (text.length >= 2) {
    const start = text[0];
    const end = text[text.length - 1];
    if ((start === '"' && end === '"') || (start === '\u201C' && end === '\u201D')) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

export function transcriptionPrompt(locale: Locale, title: string | null): string {
  const lines = [
    'Transcribe the speech in this audio to plain text.',
    'Return only the transcript. If there is no speech, return an empty string.',
    'Do not add quotation marks, labels, or commentary.',
    `Language: ${STT_LANGUAGE_NAMES[locale]}.`,
  ];
  if (title) {
    lines.push(`The cook is making: ${title}.`);
  }
  return lines.join('\n');
}

async function readCappedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'missing' }
  | { kind: 'empty' }
  | { kind: 'too-large' }
> {
  if (body === null) {
    return { kind: 'missing' };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      // Released, not cancelled: the dispatcher drops the rest so the 413
      // reaches the client (see readBoundedText in membership.ts).
      reader.releaseLock();
      return { kind: 'too-large' };
    }
    chunks.push(value);
  }
  if (total === 0) {
    return { kind: 'empty' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', bytes };
}

export async function sttPost(req: Request): Promise<Response> {
  const access = await requireMember(req);
  if (access.kind === 'denied') {
    return membershipUnauthorized();
  }
  if (access.kind === 'unknown') {
    return membershipUnavailable();
  }

  const locale = sttLanguageFromHeader(req.headers.get('x-sous-language'));
  if (locale === undefined) {
    return jsonError('stt-bad-language', STT_BAD_LANGUAGE, 400);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') {
    return jsonError('stt-unavailable', 'Assistant is unavailable.', 503);
  }

  const contentTypeRaw = req.headers.get('content-type');
  if (contentTypeRaw === null) {
    return jsonError('stt-bad-request', 'Bad request', 400);
  }
  const mimeType = normalizeSttContentType(contentTypeRaw);
  if (mimeType === null) {
    return jsonError('stt-bad-request', 'Bad request', 400);
  }

  const contentLength = parseContentLength(req);
  if (contentLength !== null && isSttByteCountTooLarge(contentLength)) {
    return jsonError('stt-too-long', 'Recording too long — try a shorter question.', 413);
  }

  const body = await readCappedBytes(req.body, MAX_STT_BYTES);
  if (body.kind === 'too-large') {
    return jsonError('stt-too-long', 'Recording too long — try a shorter question.', 413);
  }
  if (body.kind !== 'ok') {
    return jsonError('stt-bad-request', 'Bad request', 400);
  }

  const title = recipeTitleFromHeaders(req.headers);

  const admission = await admitLlm(access.sub, 'stt');
  if (admission.kind !== 'ok') {
    return llmRefusal(admission);
  }
  const model = process.env.CHAT_MODEL || 'gemini-3.8-flash';
  const ai = meteredAi(new GoogleGenAI({ apiKey }), admission.meter);
  try {
    const result = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: Buffer.from(body.bytes).toString('base64'),
              },
            },
            { text: transcriptionPrompt(locale, title) },
          ],
        },
      ],
      config: {
        maxOutputTokens: 512,
        temperature: 0,
      },
    });
    const raw = result.text;
    if (typeof raw !== 'string') {
      return jsonError('stt-failed', 'Dictation failed — try again.', 502);
    }
    console.log(`stt bytes=${body.bytes.byteLength} mime=${mimeType}`);
    return new Response(JSON.stringify({ text: stripTranscript(raw) }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return jsonError('stt-failed', 'Dictation failed — try again.', 502);
  } finally {
    admission.meter.release();
  }
}
