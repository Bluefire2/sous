/**
 * `POST /api/feature-request`: a suggestion sent from `/suggest`
 * (`docs/plans/feature-requests.md`). Gated by `withMembership` in
 * `scripts/server.ts`; `sub` comes only from the session.
 *
 * A suggestion is stored in top-level `featureRequests/{id}`, never under
 * `users/{uid}`: it is for the owner and must not sync or back up. `expireAt`
 * drives the one-year Firestore TTL policy. The id is the client's UUID and
 * the write is `create()`, so a resend after a lost response is a no-op. The
 * email address is never stored; when `contactOk` is set, the owner's reader
 * script looks it up from `sub`. The stored fields are documented in
 * `docs/plans/feature-requests.md` (Suggestion schema); keep it in step with
 * `FeatureRequestDoc`.
 *
 * At most `FEATURE_REQUEST_RATE_LIMIT` new suggestions per sub per hour, per
 * container instance. Only a newly created document uses a slot: a store
 * failure or a duplicate gives it back, and once the window is full a resend
 * of a suggestion this sub already stored still gets its 204.
 *
 * One `event: 'feature_request'` log line per request holds the `sub`, where
 * the page was opened from, the text's length, `contactOk`, and the status.
 * Never the text. `/privacy` describes the stored suggestion and this line;
 * change it with them.
 */
import {
  featureRequestText,
  isFeatureRequestFrom,
  type FeatureRequestFrom,
} from './featureRequestShape.ts';
import { sanitizedError } from './importLog.ts';
import { toSupportedLocale } from './lang.ts';
import {
  RequestBodyError,
  readBoundedText,
  storeUnavailable,
  type MembershipHandlerContext,
} from './membership.ts';
import { getStoreFirestore, isAlreadyExists, isUuid } from './store.ts';

export const FEATURE_REQUEST_COLLECTION = 'featureRequests';
export const MAX_FEATURE_REQUEST_BODY_BYTES = 16 * 1024;
export const FEATURE_REQUEST_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const FEATURE_REQUEST_RATE_LIMIT = 5;
export const FEATURE_REQUEST_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface FeatureRequestFields {
  text: string;
  contactOk: boolean;
  from?: FeatureRequestFrom;
  locale?: string;
  standalone?: boolean;
}

export interface FeatureRequestDoc extends FeatureRequestFields {
  v: 1;
  sub: string;
  createdAt: number;
  /** Stored as a Timestamp; the TTL policy deletes the doc after it. */
  expireAt: Date;
}

export type ReadFeatureRequest =
  | { kind: 'ok'; id: string; fields: FeatureRequestFields }
  | { kind: 'bad' };

export interface FeatureRequestDeps {
  create(id: string, doc: FeatureRequestDoc): Promise<void>;
  /** Whether `featureRequests/{id}` exists and was sent by `sub`. */
  sentBy(id: string, sub: string): Promise<boolean>;
  now(): number;
}

interface FeatureRequestLogEntry {
  sub: string;
  from?: FeatureRequestFrom;
  chars?: number;
  contactOk?: boolean;
  status?: number;
  /** A numeric gRPC code from a failed store write. */
  errorCode?: number;
  ms?: number;
}

/** Per container instance: when each sub's slots in the current window were taken. */
const sendTimes = new Map<string, number[]>();

/** Test hook: clears the per-instance rate-limit windows. */
export function resetFeatureRequestRateLimitForTest(): void {
  sendTimes.clear();
}

/** The sub's slots still inside the window, as the live array in `sendTimes`. */
function recentSends(sub: string, now: number): number[] {
  const fresh = (sendTimes.get(sub) ?? []).filter(
    (at) => now - at < FEATURE_REQUEST_RATE_WINDOW_MS,
  );
  sendTimes.set(sub, fresh);
  return fresh;
}

/** Gives back a slot taken at `at` whose write created nothing. */
function releaseSend(sub: string, at: number): void {
  const list = sendTimes.get(sub);
  const index = list?.indexOf(at) ?? -1;
  if (list !== undefined && index >= 0) list.splice(index, 1);
}

function grpcCode(err: unknown): number | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'number' ? code : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The request body as a suggestion, or `bad` for a non-object body, a bad id,
 * or no text. Optional fields that are malformed are dropped. Never yields an
 * `undefined` value (Firestore rejects them).
 */
export function readFeatureRequest(body: unknown): ReadFeatureRequest {
  if (!isPlainObject(body) || !isUuid(body.id) || typeof body.text !== 'string') {
    return { kind: 'bad' };
  }
  const text = featureRequestText(body.text);
  if (text === '') return { kind: 'bad' };
  const fields: FeatureRequestFields = { text, contactOk: body.contactOk === true };
  if (isFeatureRequestFrom(body.from)) fields.from = body.from;
  const locale = toSupportedLocale(body.locale);
  if (locale !== undefined) fields.locale = locale;
  if (typeof body.standalone === 'boolean') fields.standalone = body.standalone;
  return { kind: 'ok', id: body.id, fields };
}

function defaultDeps(): FeatureRequestDeps {
  return {
    create: (id, doc) =>
      getStoreFirestore()
        .collection(FEATURE_REQUEST_COLLECTION)
        .doc(id)
        .create(doc)
        .then(() => {}),
    sentBy: async (id, sub) => {
      const snapshot = await getStoreFirestore().collection(FEATURE_REQUEST_COLLECTION).doc(id).get();
      return snapshot.exists && snapshot.get('sub') === sub;
    },
    now: Date.now,
  };
}

function fail(code: string, error: string, status: number): Response {
  return Response.json({ error, code }, { status });
}

export async function featureRequestPost(
  req: Request,
  ctx: MembershipHandlerContext,
  deps?: FeatureRequestDeps,
): Promise<Response> {
  // `withMembership` has already decided access; the sub only names the
  // sender and the log line. Read once (membership.test.ts counts it).
  const sub = ctx.authorizedSub;
  const entry: FeatureRequestLogEntry = { sub };
  const started = Date.now();
  try {
    const response = await handleFeatureRequest(req, sub, entry, deps ?? defaultDeps());
    entry.status = response.status;
    return response;
  } catch (err) {
    // The dispatcher in `scripts/server.ts` logs whatever escapes as an error,
    // and a message can quote the request (the suggestion's text).
    entry.status = 500;
    throw sanitizedError('Feature request failed', err);
  } finally {
    entry.ms = Date.now() - started;
    console.log(JSON.stringify({ event: 'feature_request', ...entry }));
  }
}

/** `featureRequestPost` without the log line; it records what happened on `entry`. */
async function handleFeatureRequest(
  req: Request,
  sub: string,
  entry: FeatureRequestLogEntry,
  deps: FeatureRequestDeps,
): Promise<Response> {
  let raw: string | null;
  try {
    raw = await readBoundedText(req, MAX_FEATURE_REQUEST_BODY_BYTES);
  } catch (err) {
    // The client went away mid-upload; nobody reads this answer.
    if (err instanceof RequestBodyError) return fail('feature-request-bad-request', 'Bad request', 400);
    throw err;
  }
  if (raw === null) return fail('feature-request-too-large', 'Too large', 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail('feature-request-bad-request', 'Bad request', 400);
  }
  const parsed = readFeatureRequest(body);
  if (parsed.kind === 'bad') return fail('feature-request-bad-request', 'Bad request', 400);

  const { fields } = parsed;
  if (fields.from !== undefined) entry.from = fields.from;
  entry.chars = fields.text.length;
  entry.contactOk = fields.contactOk;

  const now = deps.now();
  const recent = recentSends(sub, now);
  if (recent.length >= FEATURE_REQUEST_RATE_LIMIT) {
    // A full window must not turn a resend after a lost response into a
    // failure: if this sub already stored this id, it was sent.
    try {
      if (await deps.sentBy(parsed.id, sub)) return new Response(null, { status: 204 });
    } catch (err) {
      const code = grpcCode(err);
      if (code !== undefined) entry.errorCode = code;
      return storeUnavailable();
    }
    return fail('feature-request-rate-limited', 'Too many suggestions', 429);
  }

  // `fields` first, so nothing in the body can override the session's `sub`.
  const doc: FeatureRequestDoc = {
    ...fields,
    v: 1,
    sub,
    createdAt: now,
    expireAt: new Date(now + FEATURE_REQUEST_RETENTION_MS),
  };
  // Take the slot before the write so parallel sends cannot overshoot the
  // cap, and give it back unless a new document was created.
  recent.push(now);
  try {
    await deps.create(parsed.id, doc);
  } catch (err) {
    releaseSend(sub, now);
    if (isAlreadyExists(err)) return new Response(null, { status: 204 });
    const code = grpcCode(err);
    if (code !== undefined) entry.errorCode = code;
    return storeUnavailable();
  }
  return new Response(null, { status: 204 });
}
