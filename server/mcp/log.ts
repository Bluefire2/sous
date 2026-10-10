/**
 * Structured log lines for the MCP server: one `event: 'mcp'` line per
 * `/mcp` request and one `event: 'mcp_oauth'` line per authorize, consent,
 * token, or revoke step. Cloud Logging parses a JSON line on stdout as
 * `jsonPayload`.
 *
 * Logged: the account `sub`, the client's host (the host of its `client_id`
 * URL), the JSON-RPC method and tool name, the outcome, the HTTP status,
 * counts, and timing. Never logged: tool arguments, recipe text, tokens,
 * codes, `state`, the email, the full `redirect_uri`, or an error message
 * (an SDK message can quote the request). `/privacy` and `/terms` describe
 * these lines; change them with it.
 */
import { sanitizedError, thrownStatus } from '../importLog.ts';

export type McpLogOutcome =
  | 'ok'
  | 'invalid'
  | 'conflict'
  | 'not_found'
  | 'not_allowed'
  | 'rate_limited'
  | 'insufficient_scope'
  | 'unauthorized'
  | 'unavailable'
  | 'error';

export interface McpLogEntry {
  sub?: string;
  clientHost?: string;
  /** The JSON-RPC method, or `batch` for an array of messages. */
  method?: string;
  tool?: string;
  outcome?: McpLogOutcome;
  status?: number;
  hits?: number;
  recipes?: number;
  /** A numeric HTTP status on a thrown error, when it has one. */
  errorStatus?: number;
  durationMs?: number;
}

export type McpOAuthStep = 'authorize' | 'consent' | 'token' | 'revoke';

export interface McpOAuthLogEntry {
  step: McpOAuthStep;
  clientHost?: string;
  /** A short machine word: `ok`, `denied`, `invalid_grant`, `reused`, … */
  outcome?: string;
  grantType?: 'authorization_code' | 'refresh_token' | 'other';
  status?: number;
  errorStatus?: number;
  durationMs?: number;
}

export function mcpLogLine(entry: McpLogEntry): string {
  return JSON.stringify({ event: 'mcp', ...entry });
}

export function mcpOAuthLogLine(entry: McpOAuthLogEntry): string {
  return JSON.stringify({ event: 'mcp_oauth', ...entry });
}

/** Class name and numeric status only; see `sanitizedError` in `server/importLog.ts`. */
export function sanitizedMcpError(err: unknown): Error {
  return sanitizedError('MCP request failed', err);
}

/**
 * For a throw a handler answers itself (a store blip it turns into a 503):
 * the class name and status go to stderr and the status onto the log line.
 */
export function noteHandledError(entry: { errorStatus?: number }, err: unknown): void {
  const status = thrownStatus(err);
  if (status !== undefined) entry.errorStatus = status;
  console.error(sanitizedMcpError(err).message);
}

/** The host of a `client_id` URL, for logs and the consent page. Undefined when it is not a URL. */
export function clientHostOf(clientId: unknown): string | undefined {
  if (typeof clientId !== 'string') return undefined;
  try {
    return new URL(clientId).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `handle`, then writes one `mcp_oauth` line with its status and
 * duration. A throw is logged as `error` and rethrown as `sanitizedMcpError`,
 * because the dispatcher in `scripts/server.ts` `console.error`s whatever
 * escapes.
 */
export async function withMcpOAuthLog(
  entry: McpOAuthLogEntry,
  handle: () => Promise<Response>,
): Promise<Response> {
  const started = Date.now();
  try {
    const response = await handle();
    entry.status = response.status;
    entry.outcome ??= response.status < 400 ? 'ok' : 'error';
    return response;
  } catch (err) {
    entry.outcome = 'error';
    const status = thrownStatus(err);
    if (status !== undefined) entry.errorStatus = status;
    entry.status = 500;
    throw sanitizedMcpError(err);
  } finally {
    entry.durationMs = Date.now() - started;
    console.log(mcpOAuthLogLine(entry));
  }
}
