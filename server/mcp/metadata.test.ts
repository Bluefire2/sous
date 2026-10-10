import { describe, expect, it } from 'vitest';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.ts';

const ORIGIN = 'https://sous.kyrylo.lol';

describe('protectedResourceMetadata', () => {
  it('names /mcp as the resource and Sous as its authorization server', () => {
    expect(protectedResourceMetadata(ORIGIN)).toEqual({
      resource: 'https://sous.kyrylo.lol/mcp',
      authorization_servers: ['https://sous.kyrylo.lol'],
      scopes_supported: ['recipes:read', 'recipes:write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Sous',
    });
  });
});

describe('authorizationServerMetadata', () => {
  const doc = authorizationServerMetadata(ORIGIN);

  it('turns on CIMD for Claude: the flag and a public-client auth method', () => {
    expect(doc.client_id_metadata_document_supported).toBe(true);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('requires S256 and advertises iss in the authorization response', () => {
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('has no registration endpoint and no offline_access', () => {
    expect(doc).not.toHaveProperty('registration_endpoint');
    expect(doc.scopes_supported).toEqual(['recipes:read', 'recipes:write']);
  });

  it('lists the endpoints under the issuer', () => {
    expect(doc).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });
});
