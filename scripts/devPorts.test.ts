import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_PORT, devPort } from './devPorts.ts';

const port = (argv: string[]) => devPort(argv, '--port', 'SOUS_API_PORT', DEFAULT_API_PORT);

beforeEach(() => {
  // A developer may export these (AGENTS.md, How to run it); empty means unset.
  vi.stubEnv('SOUS_API_PORT', '');
  vi.stubEnv('SOUS_WEB_PORT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('devPort', () => {
  it('reads --port N and --port=N', () => {
    expect(port(['node', 'x.ts', '--port', '3101'])).toBe(3101);
    expect(port(['node', 'x.ts', '--port=3102'])).toBe(3102);
  });

  it('prefers the flag, then the environment variable, then the default', () => {
    vi.stubEnv('SOUS_API_PORT', '3200');
    expect(port(['--port', '3101'])).toBe(3101);
    expect(port([])).toBe(3200);
    vi.stubEnv('SOUS_API_PORT', ' ');
    expect(port([])).toBe(DEFAULT_API_PORT);
  });

  it('does not read a flag that only starts with the name', () => {
    expect(port(['--port-other', '9999'])).toBe(DEFAULT_API_PORT);
    expect(devPort(['--api-port', '3101'], '--port', 'SOUS_WEB_PORT', 5173)).toBe(5173);
  });

  it('throws on a flag with no value, naming the flag', () => {
    expect(() => port(['--port'])).toThrow('--port needs a port number');
    expect(() => port(['--port='])).toThrow('--port needs a port number');
  });

  it('throws on a value that is not a port, naming where it came from', () => {
    for (const bad of ['0', '65536', '70000', 'abc', '3101.5', '-1']) {
      expect(() => port(['--port', bad]), bad).toThrow(`--port must be a port number, got "${bad}"`);
    }
    vi.stubEnv('SOUS_API_PORT', 'eighty');
    expect(() => port([])).toThrow('SOUS_API_PORT must be a port number, got "eighty"');
  });

  it('accepts the edges of the port range', () => {
    expect(port(['--port', '1'])).toBe(1);
    expect(port(['--port', '65535'])).toBe(65535);
  });
});
