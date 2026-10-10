/**
 * The MCP client the test-mode seed connects, and the tokens that connection
 * produced. The seed redeems the authorization code over `POST /oauth/token`
 * and remembers the pair here; `/__test/personas` hands it to `testing/smoke.ts`.
 * A `--keep` start did not seed, so there is nothing to remember.
 *
 * The raw tokens exist only in this process. They are never logged.
 */

/** A public https client id. The token endpoint checks its shape and does not fetch it. */
export const SEEDED_MCP_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

export const SEEDED_MCP_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

/** PKCE S256 verifier: 43–128 unreserved characters. Not a secret; test mode only. */
export const SEEDED_MCP_CODE_VERIFIER = 'sous-test-mode-pkce-verifier-0123456789abcd';

export type SeededMcpTokens = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
};

let seeded: SeededMcpTokens | null = null;

export function rememberSeededMcpTokens(tokens: SeededMcpTokens): void {
  seeded = tokens;
}

export function seededMcpTokens(): SeededMcpTokens | null {
  return seeded;
}
