/**
 * Which addresses the server may connect to when a member hands it a URL,
 * and how to make sure it connects only to the address it checked.
 *
 * Shared by the MCP client metadata fetch (`server/mcp/oauth/clientMetadata.ts`)
 * and website URL import (`fetchPageHtml` in `server/recipeImport.ts`). The
 * pattern is: resolve the host (`resolvePublicAddress`), refuse unless every
 * address is public, then pass `pinnedLookup(address)` as the `lookup` option
 * of `node:http` / `node:https` `request`, so DNS rebinding cannot swap in a
 * private address between the check and the connection. TLS still verifies
 * the certificate against the URL's hostname, and SNI still carries it.
 *
 * Node built-ins only; `isPublicAddress` is pure.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Everything Sous must never connect to on a client's say-so: loopback,
 * private, link-local (including the metadata server at 169.254.169.254),
 * CGNAT, unique local, multicast, unspecified, documentation and other
 * special ranges, and any IPv6 form that embeds an IPv4 address (mapped,
 * NAT64, 6to4, Teredo), since the embedded address could be any of those.
 */
// Two lists: BlockList matches an IPv4 address against IPv4-mapped IPv6
// rules, so `::ffff:0:0/96` in a shared list would block every IPv4 address.
const BLOCKED_V4 = new BlockList();
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !BLOCKED_V4.check(address, 'ipv4');
  }
  if (family === 6) {
    return !BLOCKED_V6.check(address, 'ipv6');
  }
  return false;
}

/** Every address a hostname resolves to. Injected in tests. */
export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

export const resolveHost: ResolveHost = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Resolves the host and checks every address; returns the one to connect to,
 * or null when any address is not public (or there are none). A DNS failure
 * throws. An IP-literal host resolves to itself, so it is checked the same way.
 */
export async function resolvePublicAddress(
  hostname: string,
  resolve: ResolveHost = resolveHost,
): Promise<LookupAddress | null> {
  const addresses = await resolve(hostname);
  if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
    return null;
  }
  return addresses[0]!;
}

/**
 * A `lookup` for `node:http` / `node:https` `request` that answers every
 * query with the one address already checked. Node may ask for every
 * address (`all: true`, for happy eyeballs) or for one.
 */
export function pinnedLookup(address: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  };
}
