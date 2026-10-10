import { describe, expect, it } from 'vitest';
import { SCOPE_READ, SCOPE_WRITE } from './config.ts';
import {
  grantSatisfies,
  insufficientScope,
  parseScopes,
  readStoredScopes,
  TOOL_SCOPES,
  wwwAuthenticate,
} from './scopes.ts';
import { MCP_TOOLS } from './tools.ts';

const ORIGIN = 'https://sous.kyrylo.lol';

describe('parseScopes', () => {
  it('defaults to read, and write implies read', () => {
    expect(parseScopes(null)).toEqual({ ok: true, scopes: [SCOPE_READ] });
    expect(parseScopes('')).toEqual({ ok: true, scopes: [SCOPE_READ] });
    expect(parseScopes('recipes:write')).toEqual({ ok: true, scopes: [SCOPE_READ, SCOPE_WRITE] });
    expect(parseScopes('recipes:write  recipes:read')).toEqual({ ok: true, scopes: [SCOPE_READ, SCOPE_WRITE] });
  });

  it('refuses an unknown scope rather than dropping it', () => {
    expect(parseScopes('recipes:read offline_access')).toEqual({ ok: false });
    expect(parseScopes('recipes:delete')).toEqual({ ok: false });
  });

  it('reads stored scopes defensively', () => {
    expect(readStoredScopes(['recipes:write', 'bogus', 'recipes:read'])).toEqual([SCOPE_READ, SCOPE_WRITE]);
    expect(readStoredScopes('recipes:read')).toEqual([]);
  });
});

describe('grantSatisfies', () => {
  it('write covers read; read never covers write', () => {
    expect(grantSatisfies([SCOPE_READ], SCOPE_READ)).toBe(true);
    expect(grantSatisfies([SCOPE_WRITE], SCOPE_READ)).toBe(true);
    expect(grantSatisfies([SCOPE_READ], SCOPE_WRITE)).toBe(false);
    expect(grantSatisfies([], SCOPE_READ)).toBe(false);
  });
});

describe('TOOL_SCOPES', () => {
  it('covers every tool, and each spec uses it', () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    for (const tool of MCP_TOOLS) {
      expect(tool.scope).toBe(TOOL_SCOPES[tool.name]);
    }
  });
});

describe('challenges', () => {
  it('the 401 points at the resource metadata and asks for read', () => {
    expect(wwwAuthenticate(ORIGIN, { invalidToken: true })).toBe(
      'Bearer error="invalid_token", resource_metadata="https://sous.kyrylo.lol/.well-known/oauth-protected-resource/mcp", scope="recipes:read"',
    );
    expect(wwwAuthenticate(ORIGIN, { invalidToken: false })).toBe(
      'Bearer resource_metadata="https://sous.kyrylo.lol/.well-known/oauth-protected-resource/mcp", scope="recipes:read"',
    );
  });

  it('the 403 step-up asks for read and write', () => {
    expect(insufficientScope(ORIGIN)).toBe(
      'Bearer error="insufficient_scope", scope="recipes:read recipes:write", resource_metadata="https://sous.kyrylo.lol/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
