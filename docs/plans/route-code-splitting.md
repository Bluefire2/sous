# Route-level code splitting

## Goal

`src/App.tsx` imported every screen statically, so `npm run build` produced
one 874 KB JavaScript file (241 KB gzipped) that every visitor downloaded
before anything rendered. A signed-out visitor on a public link (`/p/<token>`)
downloaded Library, the recipe screen with Ask, Admin, the assistant, Import,
Settings and the cook journal, and ran none of them. Load each screen when its
route first opens, recover from a chunk that a deploy removed, and keep the
installed PWA working.

Constitutions applied: `docs/constitutions/client-state.md` (no library
store, hook or snapshot changes; the one new module-level store, screen loads
in flight, follows principle 3: `useSyncExternalStore`, a subscribe function,
and a getter that returns a boolean) and `docs/constitutions/i18n.md` (no new
text: the fallback and the pending bar's label reuse `common.loading`, and
the chunk-failure error reuses the existing ErrorBoundary copy).

## Decisions

### Measured sizes

Measured with `npx vite build --manifest`: a route's first load is the entry
chunk, the route's chunk, and everything they import statically (Vite
preloads those in parallel with the chunk), gzip level 9. CSS is separate:
the main stylesheet went from 77.3 KB (14.5 KB gzip) to 65.9 KB (12.1 KB), and
Import's cooking animations (11.8 KB, 2.6 KB gzip) load with Import.

| First load (JS, gzip) | Before | Library and RecipeView eager | Shipped (all lazy) |
| --- | --- | --- | --- |
| `/` | 240.7 KB | 209.9 KB | 201.3 KB |
| `/recipe/:id` | 240.7 KB | 209.9 KB | 191.8 KB |
| `/p/:token` (also loads PublicRecipe's shared parts) | 240.7 KB | 214.5 KB | 175.5 KB |
| `/p/:token/r/:id` | 240.7 KB | 209.9 KB | 172.4 KB |
| `/` then a recipe (both loaded) | 240.7 KB | 209.9 KB | 218.5 KB |

The entry chunk alone is now 153.0 KB gzip (521 KB raw), down from 240.7 KB.
The build no longer warns about a chunk over 500 KB.

### What is split

- **Every screen except PublicReturn** is `lazyScreen(() => import(...))` in
  `App.tsx`. PublicReturn is a few lines of redirect.
- **Library and RecipeView are lazy too**, against the first instinct to keep
  them eager. Eager, they were most of what `/p` downloaded and never ran
  (39.5 KB gzip of the 214.5 KB). Lazy, `/` and `/recipe/:id` also get
  smaller, since each loads only its own screen. The cost is one extra round
  trip on a cold first visit to a member page (entry, then the screen chunk),
  made shorter by the preload below. For an installed PWA the chunks come
  from the service worker's precache, so that round trip is local; a
  first-time public visitor, who has no cache, is the one who gains most.
- **The first screen's chunk starts before render.** `App.tsx` matches
  `window.location.pathname` (`entryScreenFor` in `src/lib/entryScreen.ts`)
  and calls `preload()` on Library, RecipeView, PublicLink or PublicRecipe
  while the module is evaluated, before `main.tsx` renders. `lazyScreen`
  memoises its load, so `React.lazy` reuses the promise already started.
  Other routes are rarer first screens and load on render as before.
- **The assistant** stays behind its public entry point:
  `src/agent/index.ts` now exports `AssistantScreen` as a lazy component, so
  the wiring in `App.tsx` is still the one route line and
  `AssistantEntryLink` stays eager (Library shows it). Nothing outside
  `src/agent/` imports agent internals.
- Rolldown chooses the shared chunks itself (about 40 small files). No manual
  chunk configuration: the numbers above did not need it, and manual chunks
  would have to be kept in step with imports.
- Not in scope: the four UI catalogs (about 215 KB of source, in the entry
  chunk) and React itself. Loading catalogs per locale is an i18n change with
  its own constitution questions.

### Loading UI

- One `Suspense` around `Routes`, with `RouteFallback`: the muted
  `common.loading` line screens already use. It mounts after 0.4 s
  (`useDelayedFlag`, a timer, not an opacity fade), so a fast load shows and
  announces nothing before the screen's own loading line. Only the first
  render of a page shows it.
- Navigation does not show the fallback: React Router runs location updates
  in `startTransition`, so the current screen stays up until the next one's
  chunk arrives. Without a cue, a tap on a slow network looks ignored, so
  `ScreenLoadBar` (`src/components/ScreenLoadBar.tsx`) shows a 2 px bar
  sweeping along the top while any screen chunk is loading, after 200 ms. It
  reads a count of loads in flight that `lazyScreen` keeps
  (`useScreenLoadPending`), not the router: BrowserRouter exposes no pending
  state. It is a `progressbar` labelled `common.loading`; with reduced motion
  it is a still full-width bar.

### Chunk-load failure after a deploy

`src/lib/chunkReload.ts`. A tab opened before a deploy asks for hashed chunk
names the new build no longer has (the server answers 404 for a missing
`/assets/*` file, and the new service worker's precache drops the old ones).

- `lazyScreen` wraps `React.lazy`. When the import fails with a chunk-load
  error (Chrome, Firefox and Safari wording, and Vite's "Unable to preload
  CSS"), it reloads the page once and leaves Suspense showing its fallback.
- The guard is `sous.chunkReloadAt` in this tab's sessionStorage: a reload in
  the last 5 minutes (or a time in the future) blocks another, and the error
  goes to `ErrorBoundary` instead, which shows the browser's message and
  Back to library. A screen that loads clears the mark, so a later deploy in
  the same tab can reload again. If storage is unavailable or the write
  fails, it does not reload, since nothing would stop a loop.
- Offline (`navigator.onLine === false`) it never reloads: a visitor who lost
  the network before the service worker cached the chunks would be reloaded
  onto the browser's offline page. The ErrorBoundary shows instead, and
  nothing is recorded, so the first failure back online still reloads.
- Firefox and Safari word a module that downloads but throws while it is
  evaluated the same way as one that fails to download, so a bug in a screen's
  top-level code can cost one wasted reload before the ErrorBoundary.
- Accepted: the guard can be re-armed by the user. A screen that loads clears
  the mark, so a user who keeps opening a missing screen after visiting a
  working one gets one reload per attempt, never a loop on its own.
- No `vite:preloadError` listener: Vite's preload helper rethrows that error
  into the same `import()` unless a listener cancels it, so `lazyScreen`
  already sees it. A global listener would also reload for preloads outside a
  route, which have no error boundary to fall back to.

### PWA and server

- `vite-plugin-pwa` precaches all 44 files in `dist/assets` (52 entries in
  all); the `navigateFallbackDenylist` in `dist/sw.js` is unchanged.
- `scripts/server.ts` serves the chunks from `/assets/` with the existing
  `immutable` caching and answers 404 for a missing one (its name has a dot,
  so there is no SPA fallback for it).
- `dist/index.html` still has exactly one `</head>`; Vite adds
  `modulepreload` links for the entry's shared chunks inside it.
  `server/publicPreview.ts` still injects its tags.

## Steps

1. [core] `src/lib/chunkReload.ts` (`isChunkLoadError`,
   `shouldReloadForChunkError`, `loadWithChunkReload`, the screen-load store,
   `lazyScreen` with `preload`) and `src/lib/chunkReload.test.ts`. Done.
2. [core] `src/lib/entryScreen.ts` and its test. Done.
3. [ui] `src/App.tsx`: lazy screens, the entry preload, one `Suspense`,
   `RouteFallback`; `src/lib/useDelayedFlag.ts`;
   `src/components/ScreenLoadBar.tsx`; `src/index.css`:
   `animate-screen-load`. Done.
4. [ui] `src/agent/index.ts`: `AssistantScreen` lazy behind the module's
   entry point. Done.

## Verification

- `npm run build` and `npm test` pass; `scripts/invariants.test.ts` is
  unchanged (public screens import the same modules; dynamic `import()` in
  `App.tsx` is outside them).
- Coverage: `src/lib/entryScreen.ts` fully; `src/lib/chunkReload.ts` all
  logic, leaving the browser `window` environment and the one-line
  `useScreenLoadPending` hook; `useDelayedFlag` is a React hook. Those are
  checked in the browser.
- Review fixes, in test mode through a local proxy that delays four screen
  chunks by 1.5 s: on a cold `/`, the Library chunk was requested 25 ms after
  the entry chunk arrived, before first paint. Opening Settings kept Library
  up, showed the bar from about 220 ms until Settings rendered at 1.5 s, and
  never showed the fallback. A cold `/admin` had no `role="status"` element
  for the first 400 ms, then "Loading…" until Admin rendered. With
  `navigator.onLine` stubbed false and the Suggest chunk deleted, opening
  Suggest showed the ErrorBoundary with no reload and no mark. Online, with
  the Collections chunk deleted, it reloaded once, then showed the
  ErrorBoundary and stayed there.
- Test mode on the built output (`testing/test-server.ts --static`, emulator):
  as `member`, Library, a recipe, edit, Import, Settings, the assistant, the
  cook journal, Collections, Suggest and Log a cook each fetched only their
  own chunks on first navigation and rendered; as `owner`, `/admin` loaded
  directly; signed out, a public collection and one of its recipes loaded
  without the Library or RecipeView chunks. No console errors except the
  service worker registration, which the browser pane refuses (`sw.js`
  itself is served with 200).
- Stale chunk: with the app open, every asset was renamed (to bypass the
  browser's HTTP cache, as a deploy does) and the Settings chunk deleted.
  Opening Settings reloaded once, then showed the error boundary and stayed
  there. With every asset renamed again and nothing deleted (a normal
  deploy), opening Settings reloaded once, loaded the new chunk, and cleared
  the mark.
- `CI=1 node testing/smoke.ts` and `node testing/logSweep.ts` on the test
  server's log pass. A public link's shell still carries its preview tags.
- Not verified: the service worker in a real browser (offline shell from the
  precache), and the reload against a real Cloud Run deploy.
