import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clientHostOf,
  mcpLogLine,
  mcpOAuthLogLine,
  noteHandledError,
  sanitizedMcpError,
  withMcpOAuthLog,
  type McpOAuthLogEntry,
} from './log.ts';

let logged: string[];
let errors: string[];

beforeEach(() => {
  logged = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function httpError(message: string, status: number): Error {
  return Object.assign(new TypeError(message), { status });
}

describe('log lines', () => {
  it('tag each line with its event and drop undefined fields', () => {
    expect(JSON.parse(mcpLogLine({ sub: 's', tool: 'search_recipes', outcome: 'ok', hits: undefined }))).toEqual({
      event: 'mcp',
      sub: 's',
      tool: 'search_recipes',
      outcome: 'ok',
    });
    expect(JSON.parse(mcpOAuthLogLine({ step: 'token', grantType: 'refresh_token' }))).toEqual({
      event: 'mcp_oauth',
      step: 'token',
      grantType: 'refresh_token',
    });
  });
});

describe('clientHostOf', () => {
  it('is the host of a client_id URL and undefined otherwise', () => {
    expect(clientHostOf('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe('claude.ai');
    expect(clientHostOf('https://user:pass@client.example:8443/meta?x=1')).toBe('client.example');
    expect(clientHostOf('not a url')).toBeUndefined();
    expect(clientHostOf('mailto:someone@example.com')).toBeUndefined();
    expect(clientHostOf(42)).toBeUndefined();
    expect(clientHostOf(undefined)).toBeUndefined();
  });
});

describe('sanitizedMcpError', () => {
  it('keeps the class name and status and withholds the message', () => {
    const error = sanitizedMcpError(httpError('token sous_at_secret for owner@example.com', 503));
    expect(error.message).toBe('MCP request failed: TypeError (status 503); message withheld');
    expect(error.message).not.toContain('sous_at_');
    expect(error.message).not.toContain('@');
  });
});

describe('noteHandledError', () => {
  it('records a numeric status and prints only the class name', () => {
    const entry: { errorStatus?: number } = {};
    noteHandledError(entry, httpError('quota exceeded for owner@example.com', 429));
    expect(entry.errorStatus).toBe(429);
    expect(errors).toEqual(['MCP request failed: TypeError (status 429); message withheld']);
  });

  it('leaves the status out when the error has none', () => {
    const entry: { errorStatus?: number } = {};
    noteHandledError(entry, new Error('boom'));
    expect(entry).toEqual({});
  });
});

describe('withMcpOAuthLog', () => {
  it('writes one line with the status, a default outcome, and the duration', async () => {
    const entry: McpOAuthLogEntry = { step: 'token', clientHost: 'claude.ai' };
    const response = await withMcpOAuthLog(entry, async () => new Response('{}', { status: 200 }));
    expect(response.status).toBe(200);
    expect(logged).toHaveLength(1);
    const line = JSON.parse(logged[0]) as Record<string, unknown>;
    expect(line).toMatchObject({ event: 'mcp_oauth', step: 'token', clientHost: 'claude.ai', status: 200, outcome: 'ok' });
    expect(typeof line.durationMs).toBe('number');
  });

  it('defaults a 4xx to error and keeps an outcome the handler set', async () => {
    const plain: McpOAuthLogEntry = { step: 'revoke' };
    await withMcpOAuthLog(plain, async () => new Response(null, { status: 400 }));
    expect(plain.outcome).toBe('error');

    const named: McpOAuthLogEntry = { step: 'token' };
    await withMcpOAuthLog(named, async () => {
      named.outcome = 'invalid_grant';
      return new Response(null, { status: 400 });
    });
    expect(named.outcome).toBe('invalid_grant');
    expect(logged).toHaveLength(2);
  });

  it('logs a throw as error with its status and rethrows it sanitized', async () => {
    const entry: McpOAuthLogEntry = { step: 'consent' };
    const thrown = withMcpOAuthLog(entry, async () => {
      throw httpError('redirect_uri https://evil.example/cb?code=abc', 502);
    });
    await expect(thrown).rejects.toThrow('MCP request failed: TypeError (status 502); message withheld');
    const line = JSON.parse(logged[0]) as Record<string, unknown>;
    expect(line).toMatchObject({ outcome: 'error', status: 500, errorStatus: 502 });
    expect(logged[0]).not.toContain('evil.example');
  });
});
