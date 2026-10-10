/**
 * Local stand-in for Vercel functions: serves the handlers in api/ on port
 * 3001 so `npm run dev` works end-to-end without the Vercel CLI. Shares the
 * request listener in `server.ts` with static serving off. Run with:
 *
 *   node --env-file=.env.local scripts/dev-api-server.ts
 *
 * Another port: `npm run dev:api -- --port 3101` (or SOUS_API_PORT), with
 * `npm run dev -- --api-port 3101` so Vite proxies to it. See devPorts.ts.
 *
 * (Requires Node 22.18+ for native TypeScript type stripping.)
 */
import { createServer } from 'node:http';
import { createRequestListener } from './server.ts';
import { DEFAULT_API_PORT, devPort } from './devPorts.ts';

const port = devPort(process.argv, '--port', 'SOUS_API_PORT', DEFAULT_API_PORT);

createServer(createRequestListener({ staticRoot: null })).listen(port, () => {
  console.log(`API dev server listening on http://localhost:${port}`);
});
