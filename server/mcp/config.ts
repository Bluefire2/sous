/**
 * Constants for the public MCP server and its OAuth authorization server
 * (`docs/plans/mcp-server.md`). Code constants, never env vars: changing one
 * is a reviewed change.
 */

/** The protected resource. Its full URL is the OAuth `resource` (RFC 8707). */
export const MCP_PATH = '/mcp';

export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const CONSENT_PATH = '/oauth/consent';
export const TOKEN_PATH = '/oauth/token';
export const REVOKE_PATH = '/oauth/revoke';

export function resourceUrl(origin: string): string {
  return `${origin}${MCP_PATH}`;
}

/** Protected Resource Metadata for `/mcp`: the path-suffixed form (RFC 9728 §3.1). */
export function resourceMetadataUrl(origin: string): string {
  return `${origin}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`;
}

export const SCOPE_READ = 'recipes:read';
export const SCOPE_WRITE = 'recipes:write';
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;
export type McpScope = (typeof SUPPORTED_SCOPES)[number];

export const ACCESS_TOKEN_PREFIX = 'sous_at_';
export const REFRESH_TOKEN_PREFIX = 'sous_rt_';

export const AUTH_CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A rotated refresh token presented again within this window is a concurrent refresh, not theft. */
export const REFRESH_REUSE_GRACE_MS = 30_000;
/** `lastUsedAt` on a grant is written at most this often. */
export const GRANT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Per container instance, per `sub` and grant. */
export const MCP_READ_RATE_LIMIT = 300;
export const MCP_WRITE_RATE_LIMIT = 60;
export const MCP_RATE_WINDOW_MS = 60 * 60 * 1000;

/** The library a read tool loads, as the agent loads it. */
export const MCP_LIBRARY_LIMITS = {
  maxDocs: 2000,
  maxBytes: 8_000_000,
  maxIndexEntries: 500,
  maxIndexChars: 40_000,
} as const;

/** A JSON-RPC body. A full recipe is under the 200 000-character cap, so this leaves room. */
export const MCP_BODY_LIMIT = 400_000;

/** `state` in an authorization request. */
export const MAX_STATE_CHARS = 512;
/**
 * `client_id` and `redirect_uri`. Both ride in the signed hop cookie with
 * `state`, which must stay under the browser's 4 KB cookie limit.
 */
export const MAX_CLIENT_ID_CHARS = 512;
export const MAX_REDIRECT_URI_CHARS = 1024;
/** `client_name` from a client metadata document. */
export const MAX_CLIENT_NAME_CHARS = 100;

export const CLIENT_METADATA_TIMEOUT_MS = 3_000;
export const CLIENT_METADATA_MAX_BYTES = 5 * 1024;
export const CLIENT_METADATA_CACHE_MS = 10 * 60 * 1000;
/**
 * Uncached client metadata fetches, per container instance: each member has
 * their own budget, under an instance-wide ceiling one member cannot reach
 * alone, so nobody can use up everyone else's consent fetches.
 */
export const CLIENT_METADATA_FETCHES_PER_MEMBER_PER_MINUTE = 10;
export const CLIENT_METADATA_FETCHES_PER_MINUTE = 60;
/**
 * Store lookups by `/oauth/token` and `/oauth/revoke`, per container instance,
 * all callers together (they are unauthenticated, so there is no member to
 * key on). A handful of members refresh about once an hour each; this only
 * bounds junk traffic, at most four instances' worth.
 */
export const OAUTH_TOKEN_LOOKUPS_PER_MINUTE = 120;
