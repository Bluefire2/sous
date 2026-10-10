/**
 * OAuth scopes for `/mcp` and the `WWW-Authenticate` challenges that ask for
 * them. Pure.
 *
 * `recipes:read` covers the read tools; `recipes:write` the create, edit and
 * move tools, and implies read. A request with no `scope` means read. Unknown
 * scopes are refused (`invalid_scope`), never dropped.
 */
import { resourceMetadataUrl, SCOPE_READ, SCOPE_WRITE, SUPPORTED_SCOPES, type McpScope } from './config.ts';

/** The scope each tool needs. `server/mcp/tools.ts` takes each spec's scope from here. */
export const TOOL_SCOPES = {
  search_recipes: SCOPE_READ,
  get_recipes: SCOPE_READ,
  list_collections: SCOPE_READ,
  create_recipe: SCOPE_WRITE,
  update_recipe: SCOPE_WRITE,
  move_recipes: SCOPE_WRITE,
} as const satisfies Record<string, McpScope>;

export type McpToolName = keyof typeof TOOL_SCOPES;

function isSupportedScope(value: string): value is McpScope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(value);
}

/** Space-separated scopes in canonical order, with write implying read. */
export function parseScopes(raw: string | null | undefined): { ok: true; scopes: McpScope[] } | { ok: false } {
  const words = (raw ?? '').split(' ').filter((word) => word !== '');
  if (words.length === 0) {
    return { ok: true, scopes: [SCOPE_READ] };
  }
  const wanted = new Set<McpScope>();
  for (const word of words) {
    if (!isSupportedScope(word)) {
      return { ok: false };
    }
    wanted.add(word);
  }
  if (wanted.has(SCOPE_WRITE)) {
    wanted.add(SCOPE_READ);
  }
  return { ok: true, scopes: SUPPORTED_SCOPES.filter((scope) => wanted.has(scope)) };
}

/** Stored scopes as read back from Firestore: known ones only, canonical order. */
export function readStoredScopes(raw: unknown): McpScope[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return SUPPORTED_SCOPES.filter((scope) => raw.includes(scope));
}

export function grantSatisfies(granted: readonly string[], required: McpScope): boolean {
  if (granted.includes(required)) {
    return true;
  }
  return required === SCOPE_READ && granted.includes(SCOPE_WRITE);
}

export function scopeString(scopes: readonly string[]): string {
  return scopes.join(' ');
}

/**
 * The 401 challenge. With `invalid_token` for a token that was presented and
 * refused; without an error code when the request had none (RFC 6750 §3.1).
 * Either way it points at the resource metadata, which is what starts an MCP
 * client's sign-in.
 */
export function wwwAuthenticate(origin: string, options: { invalidToken: boolean }): string {
  const parts = [];
  if (options.invalidToken) {
    parts.push('error="invalid_token"');
  }
  parts.push(`resource_metadata="${resourceMetadataUrl(origin)}"`);
  parts.push(`scope="${SCOPE_READ}"`);
  return `Bearer ${parts.join(', ')}`;
}

/** The 403 step-up: a write tool called with a read-only token. */
export function insufficientScope(origin: string): string {
  return (
    'Bearer error="insufficient_scope", ' +
    `scope="${scopeString([SCOPE_READ, SCOPE_WRITE])}", ` +
    `resource_metadata="${resourceMetadataUrl(origin)}"`
  );
}
