import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isJsonContentType,
  resetClientMetadataForTest,
  resolveClientMetadata,
  validateClientMetadata,
  type FetchDocument,
} from './clientMetadata.ts';

const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
const CLAUDE_CODE_DOC = {
  client_id: CLAUDE_CODE,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

describe('validateClientMetadata', () => {
  it("accepts Claude Code's document", () => {
    expect(validateClientMetadata(CLAUDE_CODE_DOC, CLAUDE_CODE)).toEqual({
      ok: true,
      client: { clientId: CLAUDE_CODE, clientName: 'Claude Code', redirectUris: CLAUDE_CODE_DOC.redirect_uris },
    });
  });

  it('rejects a client_id mismatch', () => {
    expect(validateClientMetadata({ ...CLAUDE_CODE_DOC, client_id: 'https://evil.example/doc' }, CLAUDE_CODE)).toEqual({
      ok: false,
      reason: 'bad_document',
    });
  });

  it('rejects a confidential client', () => {
    for (const method of ['client_secret_basic', 'client_secret_post', 'private_key_jwt']) {
      expect(validateClientMetadata({ ...CLAUDE_CODE_DOC, token_endpoint_auth_method: method }, CLAUDE_CODE).ok).toBe(
        false,
      );
    }
  });

  it('rejects missing or unusable redirect URIs, and an over-long name', () => {
    expect(validateClientMetadata({ ...CLAUDE_CODE_DOC, redirect_uris: [] }, CLAUDE_CODE).ok).toBe(false);
    expect(validateClientMetadata({ ...CLAUDE_CODE_DOC, redirect_uris: 'http://localhost/cb' }, CLAUDE_CODE).ok).toBe(
      false,
    );
    expect(validateClientMetadata({ ...CLAUDE_CODE_DOC, redirect_uris: ['http://evil.example/cb'] }, CLAUDE_CODE).ok).toBe(
      false,
    );
    expect(validateClientMetadata({ ...CLAUDE_CODE_DOC, client_name: 'x'.repeat(101) }, CLAUDE_CODE).ok).toBe(false);
    expect(validateClientMetadata([], CLAUDE_CODE).ok).toBe(false);
  });

  it('drops redirect URIs Sous would never use but keeps the rest', () => {
    const result = validateClientMetadata(
      { ...CLAUDE_CODE_DOC, redirect_uris: ['myapp://cb', 'https://app.example/cb'] },
      CLAUDE_CODE,
    );
    expect(result.ok && result.client.redirectUris).toEqual(['https://app.example/cb']);
  });
});

describe('resolveClientMetadata', () => {
  beforeEach(() => {
    resetClientMetadataForTest();
  });

  it('never fetches a malformed client_id', async () => {
    const fetchDocument = vi.fn<FetchDocument>();
    expect(await resolveClientMetadata('http://claude.ai/x', 'sub-1', { now: () => 0, fetchDocument })).toEqual({
      ok: false,
      reason: 'bad_client_id',
    });
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it('caches a good document for 10 minutes', async () => {
    const fetchDocument = vi.fn<FetchDocument>(async () => ({ ok: true, body: CLAUDE_CODE_DOC }));
    let now = 1_000;
    const deps = { now: () => now, fetchDocument };
    expect((await resolveClientMetadata(CLAUDE_CODE, 'sub-1', deps)).ok).toBe(true);
    now += 9 * 60 * 1000;
    expect((await resolveClientMetadata(CLAUDE_CODE, 'sub-1', deps)).ok).toBe(true);
    expect(fetchDocument).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 1000;
    await resolveClientMetadata(CLAUDE_CODE, 'sub-1', deps);
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure, and caps one member at 10 uncached fetches a minute', async () => {
    const fetchDocument = vi.fn<FetchDocument>(async () => ({ ok: false, reason: 'fetch_failed' }));
    const deps = { now: () => 5_000, fetchDocument };
    for (let i = 0; i < 10; i++) {
      expect(await resolveClientMetadata(CLAUDE_CODE, 'sub-1', deps)).toEqual({ ok: false, reason: 'fetch_failed' });
    }
    expect(await resolveClientMetadata(CLAUDE_CODE, 'sub-1', deps)).toEqual({ ok: false, reason: 'rate_limited' });
    // Another member still has their own budget.
    expect(await resolveClientMetadata(CLAUDE_CODE, 'sub-2', deps)).toEqual({ ok: false, reason: 'fetch_failed' });
    expect(fetchDocument).toHaveBeenCalledTimes(11);
  });

  it('caps the instance at 60 uncached fetches a minute across members', async () => {
    const fetchDocument = vi.fn<FetchDocument>(async () => ({ ok: false, reason: 'fetch_failed' }));
    const deps = { now: () => 5_000, fetchDocument };
    for (let i = 0; i < 60; i++) {
      await resolveClientMetadata(CLAUDE_CODE, `sub-${i % 6}`, deps);
    }
    expect(await resolveClientMetadata(CLAUDE_CODE, 'sub-new', deps)).toEqual({ ok: false, reason: 'rate_limited' });
    expect(fetchDocument).toHaveBeenCalledTimes(60);
  });
});

describe('isJsonContentType', () => {
  it('accepts JSON media types only', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/oauth-client+json')).toBe(true);
    expect(isJsonContentType('text/html')).toBe(false);
    expect(isJsonContentType('text/json')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});
