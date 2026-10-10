/**
 * The authorization endpoint and the consent step, following the `/c/<token>`
 * → `/c/join` pattern (`server/collectionLinksHttp.ts`):
 *
 * - `GET /oauth/authorize` checks the request's syntax only, stores it in the
 *   signed `sous_mcp_authz` hop cookie (Path=/oauth), and 303s to
 *   `/oauth/consent`. It never fetches anything and never redirects to the
 *   client.
 * - `GET /oauth/consent` signs a signed-out visitor in and shows a non-member
 *   the invitation-only page. For a member it fetches the client's metadata
 *   document, verifies `redirect_uri` against it, and renders the consent
 *   form. Only now may an error go back to the client as `error=`.
 * - `POST /oauth/consent` (same-origin, nonce from the hop cookie) records
 *   Allow or Deny and 303s to the client with `code` or `error`, plus `state`
 *   and `iss`.
 *
 * Errors before the redirect URI is verified render a plain page.
 */
import { invitationOnlyPage, unavailablePageHtml } from '../../access.ts';
import { sameOriginPost } from '../../collectionLinksHttp.ts';
import { isSecureOrigin, publicOrigin } from '../../env.ts';
import { readBoundedText, visitorMembership, type VisitorMembership } from '../../membership.ts';
import {
  clearedMcpAuthzCookie,
  mcpAuthzCookie,
  MCP_AUTHZ_COOKIE_NAME,
  randomToken,
  readCookie,
  signAccessRequestTx,
  signMcpAuthzTx,
  verifyMcpAuthzTx,
  type McpAuthzTx,
  type McpAuthzTxPayload,
} from '../../session.ts';
import { CONSENT_PATH, MAX_STATE_CHARS, resourceUrl } from '../config.ts';
import { clientHostOf, noteHandledError, withMcpOAuthLog, type McpOAuthLogEntry } from '../log.ts';
import { parseScopes, readStoredScopes } from '../scopes.ts';
import { isLoopbackRedirect, parseClientIdUrl, redirectUriAllowed, redirectUriShapeAllowed } from './clientId.ts';
import {
  liveClientMetadataDependencies,
  resolveClientMetadata,
  type ClientMetadata,
  type ClientMetadataResult,
} from './clientMetadata.ts';
import { consentErrorPageHtml, consentPageHtml, type ConsentErrorReason } from './consentPage.ts';
import { isS256Challenge } from './pkce.ts';
import { createGrantWithCode } from './store.ts';

const BODY_LIMIT = 2_000;

/** Errors an authorization request can carry to the client once its redirect URI is verified. */
export type AuthorizeRequestError =
  | 'unsupported_response_type'
  | 'invalid_request'
  | 'invalid_scope'
  | 'invalid_target';

/** Parameters that must appear at most once (RFC 6749 §3.1). */
const SINGLE_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'resource',
] as const;

export type ParsedAuthorizeRequest =
  | { kind: 'page'; reason: 'bad_client_id' | 'bad_redirect_uri' | 'bad_request' }
  | { kind: 'ok'; tx: Omit<McpAuthzTx, 'nonce'> };

/**
 * The syntax check at `/oauth/authorize`. A bad `client_id` or `redirect_uri`
 * (or a parameter sent twice, or an over-long `state`) can only be shown as a
 * page; anything else rides in the hop cookie as `error` until the redirect
 * URI is verified. Pure.
 */
export function parseAuthorizeRequest(params: URLSearchParams, origin: string): ParsedAuthorizeRequest {
  if (SINGLE_PARAMS.some((name) => params.getAll(name).length > 1)) {
    return { kind: 'page', reason: 'bad_request' };
  }
  const clientId = params.get('client_id');
  if (parseClientIdUrl(clientId) === null || clientId === null) {
    return { kind: 'page', reason: 'bad_client_id' };
  }
  const redirectUri = params.get('redirect_uri');
  if (!redirectUriShapeAllowed(redirectUri)) {
    return { kind: 'page', reason: 'bad_redirect_uri' };
  }
  const state = params.get('state') ?? undefined;
  if (state !== undefined && state.length > MAX_STATE_CHARS) {
    return { kind: 'page', reason: 'bad_request' };
  }
  const challenge = params.get('code_challenge');
  const scopes = parseScopes(params.get('scope'));
  const resource = params.get('resource');
  let error: AuthorizeRequestError | undefined;
  if (params.get('response_type') !== 'code') {
    error = 'unsupported_response_type';
  } else if (params.get('code_challenge_method') !== 'S256' || !isS256Challenge(challenge)) {
    error = 'invalid_request';
  } else if (!scopes.ok) {
    error = 'invalid_scope';
  } else if (resource !== null && resource !== resourceUrl(origin)) {
    error = 'invalid_target';
  }
  const tx: Omit<McpAuthzTx, 'nonce'> = {
    clientId,
    redirectUri,
    codeChallenge: error === undefined && challenge !== null ? challenge : '',
    scopes: error === undefined && scopes.ok ? scopes.scopes : [],
  };
  if (state !== undefined) tx.state = state;
  if (error !== undefined) tx.error = error;
  return { kind: 'ok', tx };
}

/** The client redirect: `code` or `error`, with `state` and `iss` (RFC 9207). Keeps the URI's own query. */
export function clientRedirectUrl(
  redirectUri: string,
  result: { code: string } | { error: string },
  state: string | undefined,
  issuer: string,
): string {
  const url = new URL(redirectUri);
  if ('code' in result) {
    url.searchParams.set('code', result.code);
  } else {
    url.searchParams.set('error', result.error);
  }
  if (state !== undefined) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}

export type AuthorizeDependencies = {
  now: () => number;
  secure: () => boolean;
  origin: () => string;
  nonce: () => string;
  identity: (req: Request) => Promise<VisitorMembership>;
  resolveClient: (clientId: string, sub: string) => Promise<ClientMetadataResult>;
  createGrant: typeof createGrantWithCode;
};

const liveDependencies: AuthorizeDependencies = {
  now: () => Date.now(),
  secure: isSecureOrigin,
  origin: publicOrigin,
  nonce: () => randomToken(16),
  identity: visitorMembership,
  resolveClient: (clientId, sub) => resolveClientMetadata(clientId, sub, liveClientMetadataDependencies),
  createGrant: createGrantWithCode,
};

function pageResponse(
  status: number,
  options: { body?: string; location?: string; cookies?: string[] } = {},
): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    // Not `no-referrer`: that sends the consent form's POST with `Origin:
    // null`, which `sameOriginPost` refuses.
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  if (options.body !== undefined) headers.set('Content-Type', 'text/html; charset=utf-8');
  if (options.location !== undefined) headers.set('Location', options.location);
  for (const cookie of options.cookies ?? []) headers.append('Set-Cookie', cookie);
  return new Response(options.body ?? null, { status, headers });
}

function errorPage(reason: ConsentErrorReason, status: number, cookies: string[] = []): Response {
  return pageResponse(status, { body: consentErrorPageHtml(reason), cookies });
}

/** The same 403 the Google callback shows a non-member. Writes nothing. */
function invitationOnly(identity: { sub: string; email: string }, now: number): Response {
  let requestToken: string | null = null;
  try {
    requestToken = signAccessRequestTx({ sub: identity.sub, email: identity.email }, now);
  } catch {
    // The page renders without the request form.
  }
  return pageResponse(403, { body: invitationOnlyPage({ email: identity.email }, requestToken) });
}

/** GET /oauth/authorize. Syntax only; no I/O. */
export async function handleAuthorizeGet(req: Request, deps: AuthorizeDependencies): Promise<Response> {
  const entry: McpOAuthLogEntry = { step: 'authorize' };
  return withMcpOAuthLog(entry, async () => {
    const parsed = parseAuthorizeRequest(new URL(req.url).searchParams, deps.origin());
    if (parsed.kind === 'page') {
      entry.outcome = parsed.reason;
      return errorPage('bad_request', 400);
    }
    entry.clientHost = clientHostOf(parsed.tx.clientId);
    entry.outcome = parsed.tx.error ?? 'ok';
    const hop = signMcpAuthzTx({ ...parsed.tx, nonce: deps.nonce() }, deps.now());
    return pageResponse(303, {
      location: CONSENT_PATH,
      cookies: [mcpAuthzCookie(hop, { secure: deps.secure() })],
    });
  });
}

type ConsentContext =
  | { kind: 'response'; response: Response }
  | {
      kind: 'member';
      tx: McpAuthzTxPayload;
      client: ClientMetadata;
      sub: string;
      email: string;
    };

/**
 * Shared by GET and POST: hop cookie → member → client metadata → redirect
 * URI verified. Only a member whose request names a verified redirect URI
 * gets past it.
 */
async function consentContext(
  req: Request,
  deps: AuthorizeDependencies,
  entry: McpOAuthLogEntry,
  onSignedOut: () => Response,
): Promise<ConsentContext> {
  const presented = readCookie(req, MCP_AUTHZ_COOKIE_NAME);
  const tx = presented === null ? null : verifyMcpAuthzTx(presented, deps.now());
  if (tx === null) {
    entry.outcome = 'expired';
    const cookies = presented === null ? [] : [clearedMcpAuthzCookie({ secure: deps.secure() })];
    return { kind: 'response', response: errorPage('expired', 400, cookies) };
  }
  entry.clientHost = clientHostOf(tx.clientId);
  const identity = await deps.identity(req);
  if (identity.kind === 'signedOut') {
    entry.outcome = 'signed_out';
    return { kind: 'response', response: onSignedOut() };
  }
  if (identity.kind === 'unknown') {
    entry.outcome = 'unavailable';
    return { kind: 'response', response: pageResponse(503, { body: unavailablePageHtml() }) };
  }
  if (identity.kind === 'denied') {
    entry.outcome = 'denied';
    return { kind: 'response', response: invitationOnly(identity, deps.now()) };
  }
  // Only now, with a member session, does Sous fetch a URL the client chose.
  const resolved = await deps.resolveClient(tx.clientId, identity.sub);
  if (!resolved.ok) {
    entry.outcome = `client_${resolved.reason}`;
    return {
      kind: 'response',
      response:
        resolved.reason === 'rate_limited'
          ? errorPage('rate_limited', 503)
          : errorPage('client_unverified', 400),
    };
  }
  if (!redirectUriAllowed(tx.redirectUri, resolved.client.redirectUris)) {
    entry.outcome = 'redirect_mismatch';
    return { kind: 'response', response: errorPage('redirect_mismatch', 400) };
  }
  return { kind: 'member', tx, client: resolved.client, sub: identity.sub, email: identity.email };
}

function redirectToClient(
  deps: AuthorizeDependencies,
  tx: McpAuthzTxPayload,
  result: { code: string } | { error: string },
): Response {
  return pageResponse(303, {
    location: clientRedirectUrl(tx.redirectUri, result, tx.state, deps.origin()),
    cookies: [clearedMcpAuthzCookie({ secure: deps.secure() })],
  });
}

function signInRedirect(): Response {
  return pageResponse(303, { location: `/api/auth/start?returnTo=${encodeURIComponent(CONSENT_PATH)}` });
}

/** GET /oauth/consent. Renders; never writes. */
export async function handleConsentGet(req: Request, deps: AuthorizeDependencies): Promise<Response> {
  const entry: McpOAuthLogEntry = { step: 'consent' };
  return withMcpOAuthLog(entry, async () => {
    const context = await consentContext(req, deps, entry, signInRedirect);
    if (context.kind === 'response') return context.response;
    const { tx } = context;
    if (tx.error !== undefined) {
      entry.outcome = tx.error;
      return redirectToClient(deps, tx, { error: tx.error });
    }
    entry.outcome = 'shown';
    const page = consentPageHtml({
      clientHost: new URL(tx.clientId).hostname,
      clientName: context.client.clientName,
      scopes: readStoredScopes(tx.scopes),
      redirectHost: new URL(tx.redirectUri).host,
      loopback: isLoopbackRedirect(tx.redirectUri),
      email: context.email,
      nonce: tx.nonce,
    });
    return pageResponse(200, { body: page });
  });
}

/** POST /oauth/consent. The only step that writes. */
export async function handleConsentPost(req: Request, deps: AuthorizeDependencies): Promise<Response> {
  const entry: McpOAuthLogEntry = { step: 'consent' };
  return withMcpOAuthLog(entry, async () => {
    if (!sameOriginPost(req, deps.origin())) {
      // 403 and no Set-Cookie: a cross-site POST must not touch the hop cookie.
      entry.outcome = 'forbidden';
      return errorPage('forbidden', 403);
    }
    const contentType = req.headers.get('content-type');
    if (contentType === null || !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      entry.outcome = 'bad_request';
      return errorPage('bad_request', 415);
    }
    const text = await readBoundedText(req, BODY_LIMIT);
    const form = text === null ? null : new URLSearchParams(text);
    // A session that ended between the page and the click starts over in the app.
    const context = await consentContext(req, deps, entry, () => errorPage('expired', 400));
    if (context.kind === 'response') return context.response;
    const { tx } = context;
    if (form === null || form.get('nonce') !== tx.nonce) {
      entry.outcome = 'forbidden';
      return errorPage('forbidden', 403);
    }
    if (tx.error !== undefined) {
      entry.outcome = tx.error;
      return redirectToClient(deps, tx, { error: tx.error });
    }
    const decision = form.get('decision');
    if (decision === 'deny') {
      entry.outcome = 'access_denied';
      return redirectToClient(deps, tx, { error: 'access_denied' });
    }
    if (decision !== 'allow') {
      entry.outcome = 'bad_request';
      return errorPage('bad_request', 400);
    }
    let code: string;
    try {
      ({ code } = await deps.createGrant(
        {
          sub: context.sub,
          email: context.email,
          clientId: tx.clientId,
          clientHost: new URL(tx.clientId).hostname,
          clientName: context.client.clientName,
          scopes: readStoredScopes(tx.scopes),
          redirectUri: tx.redirectUri,
          codeChallenge: tx.codeChallenge,
        },
        deps.now(),
      ));
    } catch (err) {
      noteHandledError(entry, err);
      entry.outcome = 'unavailable';
      return pageResponse(503, { body: unavailablePageHtml() });
    }
    entry.outcome = 'allowed';
    return redirectToClient(deps, tx, { code });
  });
}

export const oauthAuthorizeGet = (req: Request) => handleAuthorizeGet(req, liveDependencies);
export const oauthConsentGet = (req: Request) => handleConsentGet(req, liveDependencies);
export const oauthConsentPost = (req: Request) => handleConsentPost(req, liveDependencies);
