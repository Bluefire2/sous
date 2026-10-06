import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  DEFAULT_API_PORT,
  DEFAULT_WEB_PORT,
  devPort,
} from './scripts/devPorts.ts';

// `npm run dev -- --port 5273 --api-port 3101` (or SOUS_WEB_PORT /
// SOUS_API_PORT) moves both ends. Vite rejects --api-port, so scripts/dev-web.ts
// strips it and passes it here as SOUS_API_PORT.
const apiTarget = `http://localhost:${devPort(process.argv, '--api-port', 'SOUS_API_PORT', DEFAULT_API_PORT)}`;

export default defineConfig({
  server: {
    port: devPort(process.argv, '--port', 'SOUS_WEB_PORT', DEFAULT_WEB_PORT),
    proxy: {
      // Local stand-in for Vercel functions; see scripts/dev-api-server.ts
      '/api': apiTarget,
      '/invite': apiTarget,
      // Regex key: a plain '/c' prefix would also catch the SPA's /cooks.
      // Bare /c too: scripts/server.ts answers it with the link page.
      '^/c(/|$)': apiTarget,
      // The MCP server: its endpoint, the OAuth pages, and discovery.
      '^/mcp$': apiTarget,
      '^/oauth/': apiTarget,
      '^/\\.well-known/oauth-': apiTarget,
      // Test mode only (testing/test-server.ts); plain dev:api answers 404.
      '^/__test(/|$)': apiTarget,
    },
  },
  plugins: [
    {
      name: 'legal-html',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Same headers scripts/server.ts sends for public collection pages.
          if (req.url === '/p' || req.url?.startsWith('/p/')) {
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Robots-Tag', 'noindex');
          }
          if (req.url === '/privacy' || req.url?.startsWith('/privacy?')) {
            req.url = '/privacy.html';
          } else if (req.url === '/terms' || req.url?.startsWith('/terms?')) {
            req.url = '/terms.html';
          } else if (req.url === '/about' || req.url?.startsWith('/about?')) {
            req.url = '/about.html';
          }
          next();
        });
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/privacy$/,
          /^\/terms$/,
          /^\/about$/,
          // Bare /invite and /c are server pages too (scripts/server.ts).
          /^\/invite(\/|$)/,
          /^\/c(\/|$)/,
          /^\/mcp$/,
          /^\/oauth\//,
          /^\/\.well-known\//,
          // Public collection pages need the server's no-referrer header, so
          // the service worker never answers them from its cached shell.
          /^\/p(\/|$)/,
          // Test mode's sign-in pages (testing/test-server.ts with --static).
          /^\/__test(\/|$)/,
        ],
      },
      manifest: {
        name: 'Sous',
        short_name: 'Sous',
        description: 'Personal recipe book with an AI cooking assistant',
        display: 'standalone',
        start_url: '/',
        theme_color: '#1c1917',
        background_color: '#1c1917',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
});
