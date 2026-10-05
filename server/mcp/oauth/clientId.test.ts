import { describe, expect, it } from 'vitest';
import {
  isLoopbackRedirect,
  parseClientIdUrl,
  redirectUriAllowed,
  redirectUriShapeAllowed,
} from './clientId.ts';

describe('parseClientIdUrl', () => {
  it('accepts the Claude client metadata URLs', () => {
    expect(parseClientIdUrl('https://claude.ai/oauth/claude-code-client-metadata')?.hostname).toBe('claude.ai');
    expect(parseClientIdUrl('https://claude.ai/oauth/mcp-oauth-client-metadata')).not.toBeNull();
  });

  it('rejects http, a root path, a fragment, a query, userinfo, an IP literal, or a non-default port', () => {
    for (const raw of [
      'http://claude.ai/oauth/client',
      'https://claude.ai/',
      'https://claude.ai',
      'https://claude.ai/oauth/client#x',
      'https://claude.ai/oauth/client#',
      'https://claude.ai/oauth/client?x=1',
      'https://user@claude.ai/oauth/client',
      'https://user:pw@claude.ai/oauth/client',
      'https://93.184.216.34/client',
      'https://[2606:2800:220:1::]/client',
      'https://claude.ai:8443/oauth/client',
      'https://localhost/client',
      'https://CLAUDE.ai/oauth/client',
      'not a url',
      `https://claude.ai/${'x'.repeat(600)}`,
      42,
    ]) {
      expect(parseClientIdUrl(raw), String(raw)).toBeNull();
    }
  });
});

describe('redirect URIs', () => {
  const claudeCode = ['http://localhost/callback', 'http://127.0.0.1/callback'];

  it('matches loopback redirects with the port ignored', () => {
    expect(redirectUriAllowed('http://localhost:3118/callback', claudeCode)).toBe(true);
    expect(redirectUriAllowed('http://127.0.0.1:5555/callback', claudeCode)).toBe(true);
    expect(redirectUriAllowed('http://localhost/callback', claudeCode)).toBe(true);
  });

  it('rejects a path, host, query, or scheme change on a loopback redirect', () => {
    expect(redirectUriAllowed('http://localhost:3118/other', claudeCode)).toBe(false);
    expect(redirectUriAllowed('http://localhost:3118/callback?x=1', claudeCode)).toBe(false);
    expect(redirectUriAllowed('https://localhost:3118/callback', claudeCode)).toBe(false);
    expect(redirectUriAllowed('http://[::1]:3118/callback', claudeCode)).toBe(false);
    expect(redirectUriAllowed('http://evil.example/callback', claudeCode)).toBe(false);
  });

  it('is exact for https', () => {
    const hosted = ['https://claude.ai/api/mcp/auth_callback'];
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback', hosted)).toBe(true);
    expect(redirectUriAllowed('https://claude.ai:443/api/mcp/auth_callback', hosted)).toBe(false);
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback/', hosted)).toBe(false);
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback?x', hosted)).toBe(false);
  });

  it('allows https or http loopback in a document, never other http or a fragment', () => {
    expect(redirectUriShapeAllowed('https://app.example/cb')).toBe(true);
    expect(redirectUriShapeAllowed('http://[::1]/cb')).toBe(true);
    expect(redirectUriShapeAllowed('http://app.example/cb')).toBe(false);
    expect(redirectUriShapeAllowed('https://app.example/cb#frag')).toBe(false);
    expect(redirectUriShapeAllowed('myapp://cb')).toBe(false);
    expect(isLoopbackRedirect('http://127.0.0.1:9/cb')).toBe(true);
    expect(isLoopbackRedirect('https://127.0.0.1/cb')).toBe(false);
  });
});
