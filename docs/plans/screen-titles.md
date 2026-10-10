# Screen titles

## Goal

Every tab, browser history entry, and bookmark said "Sous", because the app
never set a title and `index.html` has a static `<title>Sous</title>`. Give
each screen a title that says what it shows, with React 19's built-in
`<title>` support (a `<title>` rendered anywhere is hoisted into `<head>`).

Constitutions applied: `docs/constitutions/i18n.md` (principles 9 and 16:
every title with UI words is a whole catalog string in all four catalogs)
and `docs/constitutions/client-state.md` (principles 4 and 5: titles read
only values the screen already reads through its subscribed hooks:
`useRecipe`, `useCollections`, `usePublicLink`, and `useT`/`useLocale`; no
new store reads in render).

## Decisions

- **Pattern: "<screen> · Sous".** <screen> is the recipe title or collection
  name for a recipe, a named collection, and the public pages, and the
  screen's heading for fixed screens. The library (home), and any state with
  nothing to name (loading, looking up, not found, a dead public link, the
  error fallback) is just "Sous".

  | Route | Title (en) | Key |
  | --- | --- | --- |
  | `/` | Sous | — |
  | `/collections/:id` | {name} · Sous | `title.named` |
  | `/collections` | Collections · Sous | `title.collections` |
  | `/recipe/:id` | {title} · Sous | `title.named` |
  | `/recipe/new`, `/collections/:id/recipe/new` | New recipe · Sous | `title.newRecipe` |
  | `/recipe/:id/edit` | Edit recipe · Sous | `title.editRecipe` |
  | `/recipe/:id/cooks/new` | Log a cook · Sous | `title.logCook` |
  | `/recipe/:id/cooks/:logId/edit` | Edit cook · Sous | `title.editCook` |
  | `/cooks` | Cooks · Sous | `title.cooks` |
  | `/import`, `/collections/:id/import` | Import recipe · Sous | `title.import` |
  | `/settings` | Settings · Sous | `title.settings` |
  | `/suggest` | Suggest a feature · Sous | `title.suggest` |
  | `/assistant` | Assistant · Sous | `title.assistant` |
  | `/admin` | Invitations · Sous | `title.admin` |
  | `/p/:token` | {collection name or recipe title} · Sous | `title.named` |
  | `/p/:token/r/:recipeId` | {title} · Sous | `title.named` |

- **Catalog text.** Each title is one whole string per language. A fixed
  title is the screen's existing heading string plus " · Sous", in every
  catalog; `src/lib/documentTitle.test.ts` pins that, so the words are ones
  the in-context review already judges on the page. `title.named` is
  `{name} · Sous` everywhere, kept in the catalogs so a language can change
  the order or separator. The brand is the same in every language, so
  `src/i18n/messages.test.ts` ignores it when looking for untranslated
  English (as it already ignored placeholders). No title names the model.
- **User text.** `namedTitle` (`src/lib/documentTitle.ts`) puts a name on one
  line: control and bidi characters dropped (a name cannot reorder
  " · Sous"), whitespace collapsed, at most 120 graphemes with "…"; a blank
  name gives "Sous". The recipe screen uses the title as shown, so a
  translated view titles the tab in the translation.
- **`index.html` keeps its static `<title>Sous</title>`.** Checked in the
  browser: React inserts its `<title>` before the first `<title>` in `<head>`
  and removes it when the screen unmounts, so the screen's title wins
  (`document.title` is the first one) and the static one is the fallback:
  before the script runs, for crawlers, and for a route that renders none.
  The served shell, including the link-preview shell for `/p` pages, is
  unchanged.
- **One `<title>` at a time.** With two, the tab depends on React's insertion
  order, which React does not promise. `src/components/DocumentTitle.tsx` is
  the only place that renders `<title>`. Fixed screens are wrapped by
  `Titled` in `src/App.tsx`, so every state of the screen (loading, not
  found) carries the title; the library, the recipe screen, and the public
  pages render their own `DocumentTitle`. `scripts/invariants.test.ts`
  checks that each route element is one or the other (or a redirect) and that
  nothing else renders `<title>`.
- **Link previews unchanged.** `server/publicPreview.ts` still serves the
  shell's `<title>Sous</title>` with the Open Graph tags; a browser retitles
  the tab once the app runs. Setting the served `<title>` to the same
  "{name} · Sous" is left out: it would add title rewriting to the
  preview code, and `/privacy` describes what previews hold.

## Steps

1. [core] `src/lib/documentTitle.ts` (`APP_TITLE`, `titleName`,
   `namedTitle`) with tests; `title.*` keys in all four catalogs.
2. [ui] `src/components/DocumentTitle.tsx`; `Titled` routes in
   `src/App.tsx`; titles in Library, RecipeView, PublicLink, PublicRecipe,
   and the ErrorBoundary fallback.
3. [core] The invariant check; comments in `index.html` and
   `server/publicPreview.ts`; AGENTS.md (Link previews, Screen titles, this
   row).

## Verification

- `npm run build` and `npm test`; `src/lib/documentTitle.ts` at 100%
  coverage.
- Test mode (emulator, `testing/test-server.ts`, Vite): every route's
  `document.title` read in the browser in English, Ukrainian, Chinese, and
  (import and a collection) Russian, including a live language switch in
  Settings, recipe → variant → back, collection → recipe → back, a missing
  recipe ("Sous"), `/admin` as the owner, and the public collection, its
  recipes, and a recipe link signed out. Each showed the screen's title
  first, with the static "Sous" after it.
- The built app (`--static`): the same titles, and `/p/<token>` still carries
  the og: tags; `CI=1 node testing/smoke.ts` passed and
  `testing/logSweep.ts` found nothing in the server log.
- The in-context translation review (`npm run test:i18n`) captures the page
  and its body text, never the tab, so it cannot see these strings. They
  were checked by hand against each catalog's heading text and the glossary
  instead, and the heading test above keeps them equal.
