/**
 * A fake network for `fetchPageHtml` (`PageFetchDeps`): DNS answers from a
 * table, and each URL serves a canned response. Nothing touches a socket.
 */
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { PinnedResponse } from '../server/netGuard.ts';
import type { PageFetchDeps } from '../server/recipeImport.ts';

/** A public address (example.com's) every unlisted host resolves to. */
export const PUBLIC_ADDRESS = '93.184.215.14';

export type FakePage = {
  status?: number;
  headers?: Record<string, string>;
  /** A string or bytes, or a stream for slow or endless bodies. */
  body?: string | Buffer | Readable;
};

export type FakePageFetchOptions = {
  /**
   * Hostname → addresses. An IP literal resolves to itself, as `dns.lookup`
   * does; other unlisted hosts resolve to `PUBLIC_ADDRESS`.
   */
  dns?: Record<string, string[]>;
  /**
   * `url.href` → response. An unlisted URL fails like a refused connection.
   * A function is called for every request instead.
   */
  pages?: Record<string, FakePage> | ((url: URL) => FakePage | Promise<FakePage>);
  timeoutMs?: number;
};

export type FakeRequest = { url: string; address: string; headers: Record<string, string> };

function toLookup(address: string): LookupAddress {
  return { address, family: address.includes(':') ? 6 : 4 };
}

function toStream(body: FakePage['body']): Readable {
  if (body instanceof Readable) return body;
  return Readable.from([Buffer.from(body ?? '')]);
}

export function fakePageFetch(options: FakePageFetchOptions = {}): {
  deps: PageFetchDeps;
  requests: FakeRequest[];
  lookups: string[];
} {
  const requests: FakeRequest[] = [];
  const lookups: string[] = [];
  const deps: PageFetchDeps = {
    timeoutMs: options.timeoutMs ?? 15_000,
    resolve: async (hostname) => {
      lookups.push(hostname);
      const fallback = isIP(hostname) === 0 ? PUBLIC_ADDRESS : hostname;
      return (options.dns?.[hostname] ?? [fallback]).map(toLookup);
    },
    get: async (url, address, init): Promise<PinnedResponse> => {
      requests.push({ url: url.href, address: address.address, headers: init.headers });
      const pages = options.pages ?? {};
      const page = typeof pages === 'function' ? await pages(url) : pages[url.href];
      if (page === undefined) {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      }
      return {
        status: page.status ?? 200,
        headers: Object.fromEntries(
          Object.entries(page.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
        ),
        body: toStream(page.body),
      };
    },
  };
  return { deps, requests, lookups };
}
