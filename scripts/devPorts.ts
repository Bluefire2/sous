/**
 * Dev ports chosen on the command line so several checkouts can run side by
 * side: `npm run dev:api -- --port 3101`, `npm run dev -- --port 5273
 * --api-port 3101`, `npm run click:library -- --port 5273`. Each also reads an
 * environment variable (SOUS_API_PORT, SOUS_WEB_PORT) when the flag is absent,
 * and falls back to today's ports. Used by dev-api-server.ts,
 * library-click-through.ts, and vite.config.ts (which Vite bundles).
 */

export const DEFAULT_API_PORT = 3001;
export const DEFAULT_WEB_PORT = 5173;

/** The value of `--name 1234` or `--name=1234` in argv, if present. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // A bare flag at the end of argv has no value: '' makes devPort throw, not fall back.
    if (arg === name) return argv[i + 1] ?? '';
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

/** Flag, then environment variable, then the default; anything else throws. */
export function devPort(
  argv: readonly string[],
  flag: string,
  envName: string,
  fallback: number,
): number {
  const fromFlag = flagValue(argv, flag);
  const raw = (fromFlag ?? process.env[envName] ?? '').trim();
  if (raw === '') {
    if (fromFlag !== undefined) throw new Error(`${flag} needs a port number`);
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${fromFlag !== undefined ? flag : envName} must be a port number, got "${raw}"`);
  }
  return port;
}
