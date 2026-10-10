import { t } from '../i18n';
import { serverError } from './errorText';
import { invalidateSession } from './session';

/** An AI app the member connected through the MCP server (`docs/plans/mcp-server.md`). */
export interface ConnectedApp {
  id: string;
  /** The host of the app's client ID URL: what Sous can vouch for. */
  clientHost: string;
  /** The app's own name for itself, shown quoted; never checked. */
  clientName?: string;
  canEdit: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The list from `GET /api/mcp/grants`, or null when the body is not one. Rows that do not parse are dropped. */
export function parseConnectedApps(data: unknown): ConnectedApp[] | null {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { grants?: unknown }).grants)) {
    return null;
  }
  const apps: ConnectedApp[] = [];
  for (const raw of (data as { grants: unknown[] }).grants) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.clientHost !== 'string' || !isFiniteNumber(row.createdAt)) {
      continue;
    }
    const scopes = Array.isArray(row.scopes) ? row.scopes : [];
    const app: ConnectedApp = {
      id: row.id,
      clientHost: row.clientHost,
      canEdit: scopes.includes('recipes:write'),
      createdAt: row.createdAt,
    };
    if (typeof row.clientName === 'string' && row.clientName !== '') app.clientName = row.clientName;
    if (isFiniteNumber(row.lastUsedAt)) app.lastUsedAt = row.lastUsedAt;
    apps.push(app);
  }
  return apps;
}

/** The address to add in an AI app. */
export function mcpServerUrl(origin: string): string {
  return `${origin}/mcp`;
}

async function throwConnectedAppsError(response: Response): Promise<never> {
  if (response.status === 401) {
    invalidateSession();
    throw new Error(t('error.sessionExpired'));
  }
  if (response.status === 503) {
    throw new Error(t('error.connectedAppsUnavailable'));
  }
  const data = (await response.json().catch(() => null)) as unknown;
  throw serverError(data, 'error.requestFailed', { status: response.status });
}

export async function listConnectedApps(): Promise<ConnectedApp[]> {
  const response = await fetch('/api/mcp/grants', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    await throwConnectedAppsError(response);
  }
  const apps = parseConnectedApps(await response.json().catch(() => null));
  if (apps === null) {
    throw new Error(t('error.requestFailed', { status: response.status }));
  }
  return apps;
}

/** Disconnects one app. A 404 means it is already gone, which is what was asked. */
export async function disconnectApp(id: string): Promise<void> {
  const response = await fetch('/api/mcp/grants/revoke', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (response.ok || response.status === 404) {
    return;
  }
  await throwConnectedAppsError(response);
}
