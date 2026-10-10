import { describe, expect, it } from 'vitest';
import { isPublicAddress, pinnedLookup, resolvePublicAddress, type ResolveHost } from './netGuard.ts';

describe('isPublicAddress', () => {
  it('accepts ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '160.79.104.10', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('rejects every private and special range', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '100.127.255.254',
      '127.0.0.1',
      '127.255.255.255',
      '169.254.169.254',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a00:1',
      '2002:a00:1::',
      '2001::1',
      '2001:db8::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
      'not-an-ip',
      '',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('keeps addresses just outside a range public', () => {
    expect(isPublicAddress('172.32.0.1')).toBe(true);
    expect(isPublicAddress('100.128.0.1')).toBe(true);
    expect(isPublicAddress('11.0.0.1')).toBe(true);
  });
});

describe('resolvePublicAddress', () => {
  const resolving =
    (...addresses: string[]): ResolveHost =>
    async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('returns the first address when every address is public', async () => {
    expect(await resolvePublicAddress('example.com', resolving('93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'))).toEqual({
      address: '93.184.215.14',
      family: 4,
    });
  });

  it('refuses a name with any private address, or none', async () => {
    expect(await resolvePublicAddress('example.com', resolving('93.184.215.14', '10.0.0.1'))).toBeNull();
    expect(await resolvePublicAddress('localhost', resolving('127.0.0.1', '::1'))).toBeNull();
    expect(await resolvePublicAddress('example.com', resolving())).toBeNull();
  });

  it('lets a DNS failure throw', async () => {
    const failing: ResolveHost = () => Promise.reject(new Error('ENOTFOUND'));
    await expect(resolvePublicAddress('nowhere.invalid', failing)).rejects.toThrow('ENOTFOUND');
  });
});

describe('pinnedLookup', () => {
  const address = { address: '93.184.215.14', family: 4 };

  it('answers a single-address query with the pinned address', () => {
    const calls: unknown[][] = [];
    pinnedLookup(address)('rebinding.example', {}, (...args: unknown[]) => calls.push(args));
    expect(calls).toEqual([[null, '93.184.215.14', 4]]);
  });

  it('answers an all-addresses query with only the pinned address', () => {
    const calls: unknown[][] = [];
    pinnedLookup(address)('rebinding.example', { all: true }, (...args: unknown[]) => calls.push(args));
    expect(calls).toEqual([[null, [address]]]);
  });
});
