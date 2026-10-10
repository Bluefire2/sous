import { describe, expect, it, vi } from 'vitest';
import type { RequireMemberResult } from '../membership.ts';
import { handleMcpGrantsGet, handleMcpGrantsRevokePost, type McpGrantsDependencies } from './grantsHttp.ts';
import type { StoredGrant } from './oauth/store.ts';

const G1 = '11111111-1111-4111-8111-111111111111';

const GRANT: StoredGrant = {
  id: G1,
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  clientHost: 'claude.ai',
  clientName: 'Claude Code',
  scopes: ['recipes:read', 'recipes:write'],
  email: 'member@example.com',
  createdAt: 10,
  lastUsedAt: 20,
};

function deps(access: RequireMemberResult = { kind: 'ok', sub: 'sub-1', email: 'm@example.com', isOwner: false }) {
  const d: McpGrantsDependencies = {
    requireMember: async () => access,
    list: vi.fn(async () => [GRANT]),
    revoke: vi.fn(async (_sub: string, id: string) => (id === G1 ? ('revoked' as const) : ('missing' as const))),
    now: () => 99,
  };
  return d;
}

function post(body: string): Request {
  return new Request('https://sous.example/api/mcp/grants/revoke', { method: 'POST', body });
}

describe('GET /api/mcp/grants', () => {
  it('lists rows without the email or full client URL', async () => {
    const res = await handleMcpGrantsGet(new Request('https://sous.example/api/mcp/grants'), deps());
    expect(await res.json()).toEqual({
      grants: [
        { id: G1, clientHost: 'claude.ai', clientName: 'Claude Code', scopes: ['recipes:read', 'recipes:write'], createdAt: 10, lastUsedAt: 20 },
      ],
    });
  });

  it('is 401 when denied and 503 when unknown', async () => {
    expect((await handleMcpGrantsGet(new Request('https://x/'), deps({ kind: 'denied' }))).status).toBe(401);
    expect((await handleMcpGrantsGet(new Request('https://x/'), deps({ kind: 'unknown' }))).status).toBe(503);
  });
});

describe('POST /api/mcp/grants/revoke', () => {
  it('revokes the caller’s own grant', async () => {
    const d = deps();
    const res = await handleMcpGrantsRevokePost(post(JSON.stringify({ id: G1 })), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revokedId: G1 });
    expect(d.revoke).toHaveBeenCalledWith('sub-1', G1, 99);
  });

  it('is 404 for an unknown or already revoked grant, 400 for a bad id', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect((await handleMcpGrantsRevokePost(post(JSON.stringify({ id: other })), deps())).status).toBe(404);
    expect((await handleMcpGrantsRevokePost(post(JSON.stringify({ id: 'x' })), deps())).status).toBe(400);
    expect((await handleMcpGrantsRevokePost(post('{'), deps())).status).toBe(400);
  });
});
