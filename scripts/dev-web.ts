/**
 * `npm run dev`: Vite, plus an `--api-port` flag that Vite's own CLI rejects.
 * `npm run dev -- --port 5273 --api-port 3101` serves the web app on 5273 and
 * proxies to the API on 3101 (start that with `npm run dev:api -- --port
 * 3101`). Everything else is passed to Vite unchanged. The port reaches
 * vite.config.ts as SOUS_API_PORT; see devPorts.ts.
 */
import { DEFAULT_API_PORT, devPort } from './devPorts.ts';

const args = process.argv.slice(2);
const kept: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--api-port') i++;
  else if (!args[i].startsWith('--api-port=')) kept.push(args[i]);
}

process.env.SOUS_API_PORT = String(
  devPort(process.argv, '--api-port', 'SOUS_API_PORT', DEFAULT_API_PORT),
);

// Run Vite's CLI in this process, as `vite` would, minus the flag it rejects.
process.argv = [process.argv[0], process.argv[1], ...kept];
await import(new URL('./bin/vite.js', import.meta.resolve('vite/package.json')).href);
