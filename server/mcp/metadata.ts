/**
 * The two discovery documents: Protected Resource Metadata for `/mcp` (RFC
 * 9728) and Authorization Server Metadata (RFC 8414). Claude uses Client ID
 * Metadata Documents only when the second has both
 * `client_id_metadata_document_supported: true` and `"none"` in
 * `token_endpoint_auth_methods_supported`; there is no dynamic client
 * registration, so no `registration_endpoint`.
 */
import { publicOrigin } from '../env.ts';
import {
  AUTHORIZE_PATH,
  resourceUrl,
  REVOKE_PATH,
  SUPPORTED_SCOPES,
  TOKEN_PATH,
} from './config.ts';

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Sous',
  };
}

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    revocation_endpoint: `${origin}${REVOKE_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...SUPPORTED_SCOPES],
  };
}

function metadataResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      // Public documents; a browser-based MCP client may read them cross-origin.
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** GET `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`. */
export async function protectedResourceMetadataGet(_req: Request): Promise<Response> {
  return metadataResponse(protectedResourceMetadata(publicOrigin()));
}

/** GET `/.well-known/oauth-authorization-server`. */
export async function authorizationServerMetadataGet(_req: Request): Promise<Response> {
  return metadataResponse(authorizationServerMetadata(publicOrigin()));
}
