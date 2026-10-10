/**
 * Public entry points of the MCP server for `scripts/server.ts`
 * (`docs/plans/mcp-server.md`). `matchMcpRoute` covers the paths outside
 * `/api/`: discovery, the OAuth endpoints, and `/mcp` itself. The Settings
 * routes are ordinary `/api/` routes.
 */
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  CONSENT_PATH,
  MCP_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
} from './config.ts';
import { authorizationServerMetadataGet, protectedResourceMetadataGet } from './metadata.ts';
import { oauthAuthorizeGet, oauthConsentGet, oauthConsentPost } from './oauth/authorize.ts';
import { oauthRevokePost, oauthTokenPost } from './oauth/token.ts';
import { mcpPost } from './route.ts';

export { mcpGrantsGet, mcpGrantsRevokePost } from './grantsHttp.ts';

type Handler = (req: Request) => Promise<Response>;

const ROUTES: Record<string, Partial<Record<'GET' | 'POST', Handler>>> = {
  [PROTECTED_RESOURCE_METADATA_PATH]: { GET: protectedResourceMetadataGet },
  [`${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`]: { GET: protectedResourceMetadataGet },
  [AUTHORIZATION_SERVER_METADATA_PATH]: { GET: authorizationServerMetadataGet },
  [AUTHORIZE_PATH]: { GET: oauthAuthorizeGet },
  [CONSENT_PATH]: { GET: oauthConsentGet, POST: oauthConsentPost },
  [TOKEN_PATH]: { POST: oauthTokenPost },
  [REVOKE_PATH]: { POST: oauthRevokePost },
  // Stateless and JSON-only: no SSE stream to GET and no session to DELETE.
  [MCP_PATH]: { POST: mcpPost },
};

/** Whether a path belongs to the MCP server at all, so the SPA fallback never answers it. */
export function isMcpPath(pathname: string): boolean {
  return (
    pathname === MCP_PATH ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/.well-known/oauth-')
  );
}

/** The handler for an MCP path, `wrongMethod` (405), or null for a path that is not ours. */
export function matchMcpRoute(pathname: string, method: string): Handler | 'wrongMethod' | 'notFound' | null {
  if (!isMcpPath(pathname)) {
    return null;
  }
  const route = ROUTES[pathname];
  if (route === undefined) {
    return 'notFound';
  }
  const handler = route[method === 'HEAD' ? 'GET' : (method as 'GET' | 'POST')];
  return handler ?? 'wrongMethod';
}
