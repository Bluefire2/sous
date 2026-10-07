import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME, signSession } from './session.ts';
import { SUPPORTED_LOCALES, type Locale } from './lang.ts';
import { endlessBody } from '../test/endlessBody.ts';
import {
  MAX_STT_BYTES,
  clipRecipeTitle,
  isSttByteCountTooLarge,
  normalizeSttContentType,
  recipeTitleFromHeaders,
  sttLanguageFromHeader,
  sttPost,
  transcriptionPrompt,
} from './stt.ts';

const PROMPT_NAMES: Record<Locale, string> = {
  en: 'English',
  uk: 'Ukrainian',
  ru: 'Russian',
  'zh-Hans': 'Chinese',
};

describe('normalizeSttContentType', () => {
  it('strips codecs and accepts webm', () => {
    expect(normalizeSttContentType('audio/webm;codecs=opus')).toBe('audio/webm');
  });

  it('accepts mp4', () => {
    expect(normalizeSttContentType('audio/mp4')).toBe('audio/mp4');
  });

  it('rejects non-audio types', () => {
    expect(normalizeSttContentType('text/plain')).toBeNull();
    expect(normalizeSttContentType('image/jpeg')).toBeNull();
  });
});

describe('isSttByteCountTooLarge', () => {
  it('allows the cap and rejects above it', () => {
    expect(isSttByteCountTooLarge(MAX_STT_BYTES)).toBe(false);
    expect(isSttByteCountTooLarge(MAX_STT_BYTES + 1)).toBe(true);
  });
});

describe('sttLanguageFromHeader', () => {
  it('treats a missing header as English', () => {
    expect(sttLanguageFromHeader(null)).toBe('en');
    expect(transcriptionPrompt('en', null)).toContain('Language: English.');
  });

  it.each(SUPPORTED_LOCALES)('accepts %s', (locale) => {
    expect(sttLanguageFromHeader(locale)).toBe(locale);
    expect(transcriptionPrompt(locale, null)).toContain(`Language: ${PROMPT_NAMES[locale]}.`);
  });

  it('maps the ua alias to a Ukrainian prompt', () => {
    expect(sttLanguageFromHeader('ua')).toBe('uk');
    expect(transcriptionPrompt('uk', null)).toContain('Language: Ukrainian.');
  });

  it('maps zh-CN to a Chinese prompt', () => {
    expect(sttLanguageFromHeader('zh-CN')).toBe('zh-Hans');
    expect(transcriptionPrompt('zh-Hans', null)).toContain('Language: Chinese.');
  });

  it.each(['fr', 'zh', 'zh-Hant', '!!!', '', '   '])('rejects %j', (header) => {
    expect(sttLanguageFromHeader(header)).toBeUndefined();
  });

  it('reads the header name Fetch lowercased', () => {
    const headers = new Headers({ 'X-Sous-Language': 'uk' });
    expect(sttLanguageFromHeader(headers.get('x-sous-language'))).toBe('uk');
  });
});

describe('transcriptionPrompt', () => {
  it.each(SUPPORTED_LOCALES)('names %s in English', (locale) => {
    const prompt = transcriptionPrompt(locale, null);
    expect(prompt).toBe(
      [
        'Transcribe the speech in this audio to plain text.',
        'Return only the transcript. If there is no speech, return an empty string.',
        'Do not add quotation marks, labels, or commentary.',
        `Language: ${PROMPT_NAMES[locale]}.`,
      ].join('\n'),
    );
  });

  it('adds the recipe title after the language line', () => {
    expect(transcriptionPrompt('ru', 'Борщ')).toBe(
      [
        'Transcribe the speech in this audio to plain text.',
        'Return only the transcript. If there is no speech, return an empty string.',
        'Do not add quotation marks, labels, or commentary.',
        'Language: Russian.',
        'The cook is making: Борщ.',
      ].join('\n'),
    );
  });
});

describe('recipeTitleFromHeaders', () => {
  it('round-trips a Cyrillic title', () => {
    const title = 'Борщ з пампушками';
    expect(recipeTitleFromHeaders(encodedTitle(title))).toBe(title);
  });

  it('round-trips a Chinese title', () => {
    const title = '宫保鸡丁';
    expect(recipeTitleFromHeaders(encodedTitle(title))).toBe(title);
  });

  it('drops the title when percent-encoding is malformed', () => {
    const headers = new Headers({
      'x-recipe-title': '%E0%A4%A',
      'x-recipe-title-encoding': 'uri',
    });
    expect(recipeTitleFromHeaders(headers)).toBeNull();
  });

  it('uses a raw ASCII title when the encoding marker is absent', () => {
    const headers = new Headers({ 'x-recipe-title': 'Gumbo' });
    expect(recipeTitleFromHeaders(headers)).toBe('Gumbo');
  });

  it('decodes before clipping', () => {
    const headers = new Headers({
      'x-recipe-title': 'Soup%0AStew',
      'x-recipe-title-encoding': 'uri',
    });
    expect(recipeTitleFromHeaders(headers)).toBe('SoupStew');
  });
});

function encodedTitle(title: string): Headers {
  return new Headers({
    'x-recipe-title': encodeURIComponent(title),
    'x-recipe-title-encoding': 'uri',
  });
}

describe('clipRecipeTitle', () => {
  it('strips C0 controls and clips to 200 scalars', () => {
    expect(clipRecipeTitle('Soup\nStew')).toBe('SoupStew');
    const long = 'a'.repeat(250);
    expect(clipRecipeTitle(long).length).toBe(200);
  });

  it('trims leftover whitespace', () => {
    expect(clipRecipeTitle('  Gumbo  ')).toBe('Gumbo');
  });
});

describe('sttPost error codes', () => {
  const prev = {
    secret: process.env.SESSION_SECRET,
    allowed: process.env.ALLOWED_EMAILS,
    gemini: process.env.GEMINI_API_KEY,
  };

  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-for-session-hmac';
    process.env.ALLOWED_EMAILS = 'allowed@example.com';
  });

  afterEach(() => {
    restoreEnv('SESSION_SECRET', prev.secret);
    restoreEnv('ALLOWED_EMAILS', prev.allowed);
    restoreEnv('GEMINI_API_KEY', prev.gemini);
  });

  function ownerPost(headers: Record<string, string> = {}): Request {
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, Date.now());
    return new Request('http://localhost/api/stt', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, ...headers },
    });
  }

  it('returns stt-unavailable when the assistant key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    const response = await sttPost(ownerPost());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Assistant is unavailable.',
      code: 'stt-unavailable',
    });
  });

  it('returns stt-bad-request when the audio type is missing', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const response = await sttPost(ownerPost());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Bad request',
      code: 'stt-bad-request',
    });
  });

  it.each(['fr', '%%%', ''])('returns stt-bad-language for %j', async (language) => {
    process.env.GEMINI_API_KEY = 'test-key';
    const response = await sttPost(ownerPost({ 'x-sous-language': language }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'That language is not supported.',
      code: 'stt-bad-language',
    });
  });

  it('returns stt-too-long past the cap without Content-Length, and leaves the rest unread', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const endless = endlessBody();
    const token = signSession({ sub: 'sub-1', email: 'allowed@example.com' }, Date.now());
    const response = await sttPost(
      new Request('http://localhost/api/stt', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, 'content-type': 'audio/webm' },
        body: endless.body,
        duplex: 'half',
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'stt-too-long' });
    // The dispatcher drops the rest; cancelling would abort the request under the 413.
    expect(endless.cancelled()).toBe(false);
    expect(endless.read()).toBeLessThan(MAX_STT_BYTES + 256 * 1024);
  });

  it('accepts X-Sous-Language when Fetch lowercases the name', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const response = await sttPost(ownerPost({ 'X-Sous-Language': 'not-a-language' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'That language is not supported.',
      code: 'stt-bad-language',
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
