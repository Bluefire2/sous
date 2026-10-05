/**
 * Client ID Metadata Documents: an MCP client's `client_id` is an https URL
 * whose JSON names the client and lists its redirect URIs. Sous fetches it
 * only once a member is signed in on the consent page, so anonymous traffic
 * cannot make it fetch arbitrary URLs.
 *
 * The fetch is SSRF-safe: every address the name resolves to must be public
 * (`isPublicAddress`), the connection is pinned to the address that passed
 * (so DNS rebinding cannot swap it; both from `server/netGuard.ts`),
 * redirects are not followed, and the time, size, and type are capped. Results are cached per URL in memory, and
 * uncached fetches are rate-limited per instance.
 */
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import { pinnedLookup, resolvePublicAddress } from '../../netGuard.ts';
import { admitTranslateCall } from '../../recipeTranslation.ts';
import {
  CLIENT_METADATA_CACHE_MS,
  CLIENT_METADATA_FETCHES_PER_MEMBER_PER_MINUTE,
  CLIENT_METADATA_FETCHES_PER_MINUTE,
  CLIENT_METADATA_MAX_BYTES,
  CLIENT_METADATA_TIMEOUT_MS,
  MAX_CLIENT_NAME_CHARS,
} from '../config.ts';
import { parseClientIdUrl, redirectUriShapeAllowed } from './clientId.ts';

export type ClientMetadata = {
  clientId: string;
  /** Self-asserted by the document; shown quoted, never trusted. */
  clientName?: string;
  redirectUris: string[];
};

export type ClientMetadataFailure =
  | 'bad_client_id'
  | 'unsafe_address'
  | 'fetch_failed'
  | 'bad_document'
  | 'rate_limited';

export type ClientMetadataResult =
  | { ok: true; client: ClientMetadata }
  | { ok: false; reason: ClientMetadataFailure };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The document's own `client_id` must equal the URL it came from; it must
 * list at least one usable redirect URI; and it must be a public client.
 * Redirect URIs Sous would never use (custom schemes, plain http to a
 * non-loopback host) are dropped rather than failing the document.
 */
export function validateClientMetadata(doc: unknown, clientId: string): ClientMetadataResult {
  if (!isPlainObject(doc) || doc.client_id !== clientId) {
    return { ok: false, reason: 'bad_document' };
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
    return { ok: false, reason: 'bad_document' };
  }
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
    return { ok: false, reason: 'bad_document' };
  }
  if (!doc.redirect_uris.every((uri) => typeof uri === 'string')) {
    return { ok: false, reason: 'bad_document' };
  }
  const redirectUris = (doc.redirect_uris as string[]).filter(redirectUriShapeAllowed);
  if (redirectUris.length === 0) {
    return { ok: false, reason: 'bad_document' };
  }
  const client: ClientMetadata = { clientId, redirectUris };
  if (doc.client_name !== undefined) {
    if (typeof doc.client_name !== 'string' || doc.client_name.length > MAX_CLIENT_NAME_CHARS) {
      return { ok: false, reason: 'bad_document' };
    }
    const name = doc.client_name.trim();
    if (name !== '') client.clientName = name;
  }
  return { ok: true, client };
}

export type FetchDocument = (url: URL) => Promise<{ ok: true; body: unknown } | { ok: false; reason: ClientMetadataFailure }>;

export type ClientMetadataDependencies = {
  now: () => number;
  fetchDocument: FetchDocument;
};

type CacheEntry = { expires: number; client: ClientMetadata };

const cache = new Map<string, CacheEntry>();
const CACHE_MAX_SIZE = 200;
/** One bucket per member, and one (`'all'`) for the instance. */
const fetchBuckets = new Map<string, number[]>();

/** Test hook: clears the per-instance cache and fetch rate. */
export function resetClientMetadataForTest(): void {
  cache.clear();
  fetchBuckets.clear();
}

export async function resolveClientMetadata(
  clientId: string,
  /** The signed-in member asking, whose fetch budget an uncached fetch spends. */
  sub: string,
  deps: ClientMetadataDependencies,
): Promise<ClientMetadataResult> {
  const url = parseClientIdUrl(clientId);
  if (url === null) {
    return { ok: false, reason: 'bad_client_id' };
  }
  const now = deps.now();
  const cached = cache.get(clientId);
  if (cached !== undefined && cached.expires > now) {
    return { ok: true, client: cached.client };
  }
  if (
    !admitTranslateCall(fetchBuckets, `member:${sub}`, now, CLIENT_METADATA_FETCHES_PER_MEMBER_PER_MINUTE, 60_000) ||
    !admitTranslateCall(fetchBuckets, 'all', now, CLIENT_METADATA_FETCHES_PER_MINUTE, 60_000)
  ) {
    return { ok: false, reason: 'rate_limited' };
  }
  const fetched = await deps.fetchDocument(url);
  if (!fetched.ok) {
    return fetched;
  }
  const result = validateClientMetadata(fetched.body, clientId);
  if (result.ok) {
    if (cache.size >= CACHE_MAX_SIZE) cache.clear();
    cache.set(clientId, { expires: now + CLIENT_METADATA_CACHE_MS, client: result.client });
  }
  return result;
}

/** Media type `application/json`, or a `+json` suffix, with any parameters. */
export function isJsonContentType(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const type = raw.split(';')[0]!.trim().toLowerCase();
  return type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type);
}

/** The live fetch: pinned to a checked address, no redirects, 3 s, 5 KB, JSON only. */
export const fetchClientMetadataDocument: FetchDocument = async (url) => {
  let pinned: LookupAddress | null;
  try {
    pinned = await resolvePublicAddress(url.hostname);
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }
  if (pinned === null) {
    return { ok: false, reason: 'unsafe_address' };
  }
  const address = pinned;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Awaited<ReturnType<FetchDocument>>) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'Sous-MCP/1 (client metadata)' },
        // Connect only to the address checked above.
        lookup: pinnedLookup(address),
        signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS),
      },
      (res) => {
        if (res.statusCode !== 200 || !isJsonContentType(res.headers['content-type'])) {
          res.resume();
          finish({ ok: false, reason: 'fetch_failed' });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > CLIENT_METADATA_MAX_BYTES) {
            req.destroy();
            finish({ ok: false, reason: 'fetch_failed' });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
          } catch {
            finish({ ok: false, reason: 'bad_document' });
          }
        });
        res.on('error', () => finish({ ok: false, reason: 'fetch_failed' }));
      },
    );
    req.on('error', () => finish({ ok: false, reason: 'fetch_failed' }));
    req.end();
  });
};

export const liveClientMetadataDependencies: ClientMetadataDependencies = {
  now: () => Date.now(),
  fetchDocument: fetchClientMetadataDocument,
};
