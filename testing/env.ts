/**
 * The test server's environment (docs/plans/test-mode.md). This is the only
 * place test mode names an env var. Every variable the app reads is in
 * `ENV_TREATMENT`; scripts/invariants.test.ts fails on one that is not, so a
 * new variable cannot fall through from a developer's `.env.local`.
 *
 * Pure: no I/O, no app imports.
 */
import { OWNER_EMAIL } from './personas.ts';

/**
 * Public on purpose. Only the test server uses it, so a cookie it signs never
 * verifies anywhere else, even when `.env.local` holds production's secret.
 */
export const TEST_SESSION_SECRET = 'sous-test-mode-session-secret-not-for-production';

/** The emulator's `demo-` convention: a `demo-` project reaches no real resource. */
export const TEST_PROJECT_ID = 'demo-sous';

/**
 * Where test mode looks for the emulator when FIRESTORE_EMULATOR_HOST is
 * unset, so `npm run dev:test` needs no env syntax in any shell. Loopback, so
 * the default can only ever reach a local emulator.
 */
export const DEFAULT_EMULATOR_HOST = '127.0.0.1:8085';

export type Treatment = 'set' | 'cleared' | 'passthrough' | 'defaulted';

export const ENV_TREATMENT: Readonly<Record<string, Treatment>> = {
  SESSION_SECRET: 'set',
  ALLOWED_EMAILS: 'set',
  GOOGLE_CLOUD_PROJECT: 'set',
  PUBLIC_ORIGIN: 'set',
  PORT: 'set',
  FIRESTORE_DATABASE_ID: 'cleared',
  PHOTO_BUCKET: 'cleared',
  RESEND_API_KEY: 'cleared',
  MAIL_FROM: 'cleared',
  OWNER_NOTIFY_EMAIL: 'cleared',
  AUTH_GOOGLE_ID: 'cleared',
  AUTH_GOOGLE_SECRET: 'cleared',
  // Not read by app code; cleared so no Google client library finds a real key.
  GOOGLE_APPLICATION_CREDENTIALS: 'cleared',
  GEMINI_API_KEY: 'passthrough',
  CHAT_MODEL: 'passthrough',
  TRANSLATE_MODEL: 'passthrough',
  TRANSLATE_PROVIDER: 'passthrough',
  FIRESTORE_EMULATOR_HOST: 'defaulted',
};

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `host:port` of the emulator: `DEFAULT_EMULATOR_HOST` when unset, or null
 * when the value set is not a loopback address.
 */
export function emulatorHost(env: Env): string | null {
  const raw = env.FIRESTORE_EMULATOR_HOST?.trim();
  if (!raw) {
    return DEFAULT_EMULATOR_HOST;
  }
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.pathname !== '/' || url.username !== '') {
    return null;
  }
  return url.host;
}

/** Every reason test mode must not start, one line each. Empty means it may. */
export function testModeRefusals(env: Env): string[] {
  const refusals: string[] = [];
  if (emulatorHost(env) === null) {
    refusals.push(
      `FIRESTORE_EMULATOR_HOST must be localhost, 127.0.0.1, or [::1] with a port, not ${env.FIRESTORE_EMULATOR_HOST}.`,
    );
  }
  if (env.K_SERVICE !== undefined) {
    refusals.push('K_SERVICE is set: this looks like Cloud Run. Test mode never runs there.');
  }
  if (env.NODE_ENV === 'production') {
    refusals.push('NODE_ENV is production. Test mode never runs in production.');
  }
  return refusals;
}

/**
 * The value of every variable in `ENV_TREATMENT` for test mode. `undefined`
 * means the variable must be deleted from `process.env`.
 */
export function testModeEnv(
  env: Env,
  options: { publicOrigin: string; port: number },
): Record<string, string | undefined> {
  const set: Record<string, string> = {
    SESSION_SECRET: TEST_SESSION_SECRET,
    ALLOWED_EMAILS: OWNER_EMAIL,
    GOOGLE_CLOUD_PROJECT: TEST_PROJECT_ID,
    PUBLIC_ORIGIN: options.publicOrigin,
    PORT: String(options.port),
  };
  const out: Record<string, string | undefined> = {};
  for (const [name, treatment] of Object.entries(ENV_TREATMENT)) {
    if (treatment === 'set') {
      const value = set[name];
      if (value === undefined) {
        throw new Error(`testModeEnv has no value for ${name}`);
      }
      out[name] = value;
    } else if (treatment === 'cleared') {
      out[name] = undefined;
    } else if (treatment === 'defaulted') {
      const host = emulatorHost(env);
      if (host === null) {
        throw new Error(`${name} is not a loopback address; testModeRefusals reports it`);
      }
      out[name] = host;
    } else {
      out[name] = env[name];
    }
  }
  return out;
}
