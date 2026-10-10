import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMULATOR_HOST,
  ENV_TREATMENT,
  TEST_PROJECT_ID,
  TEST_SESSION_SECRET,
  emulatorHost,
  testModeEnv,
  testModeRefusals,
} from './env.ts';
import { OWNER_EMAIL } from './personas.ts';

const OK_ENV = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085' };

describe('testModeRefusals', () => {
  it('allows a loopback emulator with nothing else set', () => {
    expect(testModeRefusals(OK_ENV)).toEqual([]);
    expect(testModeRefusals({ FIRESTORE_EMULATOR_HOST: 'localhost:8085' })).toEqual([]);
    expect(testModeRefusals({ FIRESTORE_EMULATOR_HOST: '[::1]:8085' })).toEqual([]);
  });

  it('allows an unset emulator host, which means the loopback default', () => {
    expect(testModeRefusals({})).toEqual([]);
    expect(testModeRefusals({ FIRESTORE_EMULATOR_HOST: '  ' })).toEqual([]);
  });

  it('refuses an emulator host that is not loopback', () => {
    for (const host of ['example.com:8085', '10.0.0.5:8085', 'localhost.example.com:8085', 'a@localhost:8085']) {
      expect(testModeRefusals({ FIRESTORE_EMULATOR_HOST: host }), host).toHaveLength(1);
    }
  });

  it('refuses on Cloud Run', () => {
    expect(testModeRefusals({ ...OK_ENV, K_SERVICE: 'sous' })).toHaveLength(1);
  });

  it('refuses NODE_ENV=production', () => {
    expect(testModeRefusals({ ...OK_ENV, NODE_ENV: 'production' })).toHaveLength(1);
    expect(testModeRefusals({ ...OK_ENV, NODE_ENV: 'development' })).toEqual([]);
  });

  it('lists every reason at once', () => {
    expect(
      testModeRefusals({ FIRESTORE_EMULATOR_HOST: 'example.com:8085', K_SERVICE: 'sous', NODE_ENV: 'production' }),
    ).toHaveLength(3);
  });
});

describe('emulatorHost', () => {
  it('returns host:port for a loopback address', () => {
    expect(emulatorHost(OK_ENV)).toBe('127.0.0.1:8085');
    expect(emulatorHost({ FIRESTORE_EMULATOR_HOST: 'localhost:9000' })).toBe('localhost:9000');
    expect(emulatorHost({ FIRESTORE_EMULATOR_HOST: 'example.com:8085' })).toBeNull();
  });

  it('defaults to a loopback address when unset', () => {
    expect(DEFAULT_EMULATOR_HOST).toBe('127.0.0.1:8085');
    expect(emulatorHost({})).toBe(DEFAULT_EMULATOR_HOST);
    expect(emulatorHost({ FIRESTORE_EMULATOR_HOST: '' })).toBe(DEFAULT_EMULATOR_HOST);
  });
});

describe('testModeEnv', () => {
  const developerEnv = {
    SESSION_SECRET: 'production-secret',
    ALLOWED_EMAILS: 'someone@example.com',
    GOOGLE_CLOUD_PROJECT: 'cooking-assistant-508423',
    FIRESTORE_DATABASE_ID: 'prod',
    PUBLIC_ORIGIN: 'https://sous.kyrylo.lol',
    PHOTO_BUCKET: 'sous-photos-cooking-assistant-508423',
    RESEND_API_KEY: 're_live',
    MAIL_FROM: 'Sous <a@example.com>',
    OWNER_NOTIFY_EMAIL: 'someone@example.com',
    AUTH_GOOGLE_ID: 'id',
    AUTH_GOOGLE_SECRET: 'secret',
    GEMINI_API_KEY: 'gemini-key',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085',
  };
  const env = testModeEnv(developerEnv, { publicOrigin: 'http://localhost:5173', port: 3001 });

  it('overrides the session secret, owner tier, and project', () => {
    expect(env.SESSION_SECRET).toBe(TEST_SESSION_SECRET);
    expect(env.ALLOWED_EMAILS).toBe(OWNER_EMAIL);
    expect(env.GOOGLE_CLOUD_PROJECT).toBe(TEST_PROJECT_ID);
    expect(env.PUBLIC_ORIGIN).toBe('http://localhost:5173');
    expect(env.PORT).toBe('3001');
  });

  it('clears every cleared variable', () => {
    for (const [name, treatment] of Object.entries(ENV_TREATMENT)) {
      if (treatment === 'cleared') {
        expect(name in env, name).toBe(true);
        expect(env[name], name).toBeUndefined();
      }
    }
  });

  it('passes model settings and the emulator host through', () => {
    expect(env.GEMINI_API_KEY).toBe('gemini-key');
    expect(env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:8085');
    expect(env.CHAT_MODEL).toBeUndefined();
  });

  it('sets the default emulator host when none is given', () => {
    const defaulted = testModeEnv({}, { publicOrigin: 'http://localhost:5173', port: 3001 });
    expect(defaulted.FIRESTORE_EMULATOR_HOST).toBe(DEFAULT_EMULATOR_HOST);
  });

  it('names exactly the variables in ENV_TREATMENT', () => {
    expect(Object.keys(env).sort()).toEqual(Object.keys(ENV_TREATMENT).sort());
  });
});
