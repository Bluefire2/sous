import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import { disconnectApp, listConnectedApps, mcpServerUrl, parseConnectedApps } from './connectedAppsApi';
import * as session from './session';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  clientHost: 'claude.ai',
  clientName: 'Claude Code',
  scopes: ['recipes:read', 'recipes:write'],
  createdAt: 10,
  lastUsedAt: 20,
};

describe('parseConnectedApps', () => {
  it('reads rows and whether each app can edit', () => {
    expect(parseConnectedApps({ grants: [ROW, { ...ROW, id: 'b', scopes: ['recipes:read'], clientName: '' }] })).toEqual([
      { id: ROW.id, clientHost: 'claude.ai', clientName: 'Claude Code', canEdit: true, createdAt: 10, lastUsedAt: 20 },
      { id: 'b', clientHost: 'claude.ai', canEdit: false, createdAt: 10, lastUsedAt: 20 },
    ]);
  });

  it('drops rows that do not parse and refuses a body that is not a list', () => {
    expect(parseConnectedApps({ grants: [{ id: 1 }, null, { ...ROW, createdAt: 'x' }] })).toEqual([]);
    expect(parseConnectedApps({})).toBeNull();
    expect(parseConnectedApps(null)).toBeNull();
  });
});

describe('listConnectedApps', () => {
  it('fetches the grants with the session cookie', async () => {
    const fetchMock = respond(200, { grants: [ROW] });
    expect((await listConnectedApps())[0]?.clientHost).toBe('claude.ai');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/mcp/grants');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  });

  it('401 invalidates the session; 503 says unavailable', async () => {
    const spy = vi.spyOn(session, 'invalidateSession').mockImplementation(() => {});
    respond(401, {});
    await expect(listConnectedApps()).rejects.toThrow(t('error.sessionExpired'));
    expect(spy).toHaveBeenCalledTimes(1);
    respond(503, {});
    await expect(listConnectedApps()).rejects.toThrow(t('error.connectedAppsUnavailable'));
  });
});

describe('disconnectApp', () => {
  it('posts the id and treats 404 as already gone', async () => {
    const fetchMock = respond(200, { revokedId: ROW.id });
    await disconnectApp(ROW.id);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/mcp/grants/revoke');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ id: ROW.id });
    respond(404, { code: 'not-found' });
    await expect(disconnectApp(ROW.id)).resolves.toBeUndefined();
  });

  it('throws on other failures', async () => {
    respond(503, {});
    await expect(disconnectApp(ROW.id)).rejects.toThrow(t('error.connectedAppsUnavailable'));
  });
});

describe('mcpServerUrl', () => {
  it('is the origin plus /mcp', () => {
    expect(mcpServerUrl('https://sous.kyrylo.lol')).toBe('https://sous.kyrylo.lol/mcp');
  });
});
