import { describe, expect, it } from 'vitest';
import { findLeaks } from './logSweep.ts';

const TOKEN = 'Abc_def-0123456789xyzABCDEFGHIJKLMNOPQRSTUV';

describe('findLeaks', () => {
  it('passes the lines the server is allowed to write', () => {
    const clean = [
      '{"event":"import","sub":"test-member","via":"url","url":"https://example.com/soup","outcome":"ok"}',
      '{"event":"mcp","sub":"test-member","clientHost":"claude.ai","tool":"search_recipes","outcome":"ok"}',
      'agent steps=1 calls=0 resultBytes=0 finish=text recipes=7',
      'Test mode ready on http://localhost:4173',
      'GET /c/join',
      'collectionLinkLanding store error: Error',
    ].join('\n');
    expect(findLeaks(clean)).toEqual([]);
  });

  it('names each kind of leak with its line number', () => {
    const log = [
      'ok line',
      'approval email to member@sous.invalid',
      'bearer sous_at_ABCDEFGH12345678',
      'refresh sous_rt_ABCDEFGH12345678',
      'cookie sous_session=eyJ2IjoxfQ.sig',
      `GET /invite/${TOKEN}`,
      `GET /c/${TOKEN}`,
      `GET /api/public/${TOKEN}/recipes/x`,
      `referer https://sous.example/p/${TOKEN}`,
      '{"event":"import","url":"https://example.com/soup?utm=1"}',
      'approval email to member%40sous.invalid',
      '{"event":"mcp_oauth","redirect":"https://client.example/cb?code=abc"}',
    ].join('\n');
    expect(findLeaks(log)).toEqual([
      { line: 2, name: 'a persona email' },
      { line: 3, name: 'an MCP access or refresh token' },
      { line: 4, name: 'an MCP access or refresh token' },
      { line: 5, name: 'a session cookie' },
      { line: 6, name: 'an invite, collection, or public link token' },
      { line: 7, name: 'an invite, collection, or public link token' },
      { line: 8, name: 'an invite, collection, or public link token' },
      { line: 9, name: 'an invite, collection, or public link token' },
      { line: 10, name: 'a query string in a logged url' },
      { line: 11, name: 'a persona email' },
      { line: 12, name: 'a query string in a logged url' },
    ]);
  });

  it('does not flag the routes that carry no token', () => {
    expect(findLeaks('POST /c/join\nPOST /api/public/join\nGET /invite\nGET /cooks')).toEqual([]);
  });
});
