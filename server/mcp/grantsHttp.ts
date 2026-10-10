/**
 * Settings → Connected apps: `GET /api/mcp/grants` lists the member's live
 * MCP grants and `POST /api/mcp/grants/revoke { id }` disconnects one. Cookie
 * session and the membership decision, like every other `/api/` route; never
 * a bearer token. A revoked grant's tokens stop working on the next call.
 */
import { errorJson } from '../grantsHttp.ts';
import {
  membershipUnauthorized,
  membershipUnavailable,
  readBoundedText,
  requireMember,
  storeUnavailable,
  type RequireMemberResult,
} from '../membership.ts';
import { isUuid } from '../store.ts';
import { listLiveGrants, revokeGrant, type StoredGrant } from './oauth/store.ts';

const BODY_LIMIT = 1_000;

/** What Settings shows of a grant. Never the client's full URL beyond its host, and never the email. */
export type ConnectedAppRow = {
  id: string;
  clientHost: string;
  clientName?: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt?: number;
};

export function connectedAppRow(grant: StoredGrant): ConnectedAppRow {
  const row: ConnectedAppRow = {
    id: grant.id,
    clientHost: grant.clientHost,
    scopes: [...grant.scopes],
    createdAt: grant.createdAt,
  };
  if (grant.clientName !== undefined) row.clientName = grant.clientName;
  if (grant.lastUsedAt !== undefined) row.lastUsedAt = grant.lastUsedAt;
  return row;
}

export type McpGrantsDependencies = {
  requireMember: (req: Request) => Promise<RequireMemberResult>;
  list: (sub: string) => Promise<StoredGrant[]>;
  revoke: (sub: string, grantId: string, now: number) => Promise<'revoked' | 'missing'>;
  now: () => number;
};

const liveDependencies: McpGrantsDependencies = {
  requireMember,
  list: listLiveGrants,
  revoke: revokeGrant,
  now: () => Date.now(),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function member(req: Request, deps: McpGrantsDependencies): Promise<{ sub: string } | Response> {
  const access = await deps.requireMember(req);
  if (access.kind === 'denied') return membershipUnauthorized();
  if (access.kind === 'unknown') return membershipUnavailable();
  return { sub: access.sub };
}

export async function handleMcpGrantsGet(req: Request, deps: McpGrantsDependencies): Promise<Response> {
  const gate = await member(req, deps);
  if (gate instanceof Response) return gate;
  try {
    return json({ grants: (await deps.list(gate.sub)).map(connectedAppRow) });
  } catch (err) {
    console.error('mcpGrantsGet store error:', err instanceof Error ? err.name : typeof err);
    return storeUnavailable();
  }
}

export async function handleMcpGrantsRevokePost(req: Request, deps: McpGrantsDependencies): Promise<Response> {
  const gate = await member(req, deps);
  if (gate instanceof Response) return gate;
  const raw = await readBoundedText(req, BODY_LIMIT);
  let id: unknown;
  try {
    id = raw === null ? undefined : (JSON.parse(raw) as { id?: unknown } | null)?.id;
  } catch {
    id = undefined;
  }
  if (!isUuid(id)) {
    return errorJson('bad-request', 'Bad request', 400);
  }
  try {
    // An already revoked or unknown grant is 404; the client treats it as gone.
    if ((await deps.revoke(gate.sub, id, deps.now())) === 'missing') {
      return errorJson('not-found', 'Not found', 404);
    }
  } catch (err) {
    console.error('mcpGrantsRevokePost store error:', err instanceof Error ? err.name : typeof err);
    return storeUnavailable();
  }
  return json({ revokedId: id });
}

export const mcpGrantsGet = (req: Request) => handleMcpGrantsGet(req, liveDependencies);
export const mcpGrantsRevokePost = (req: Request) => handleMcpGrantsRevokePost(req, liveDependencies);
