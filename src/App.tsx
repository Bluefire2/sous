import { Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import DocumentTitle from './components/DocumentTitle';
import ErrorBoundary from './components/ErrorBoundary';
import ScreenLoadBar from './components/ScreenLoadBar';
import SyncToast from './components/SyncToast';
import { useT, type TextKey } from './i18n';
import { lazyScreen } from './lib/chunkReload';
import { entryScreenFor } from './lib/entryScreen';
import { routePaths } from './lib/routePaths';
import { useDelayedFlag } from './lib/useDelayedFlag';
import PublicReturn from './screens/PublicReturn';
import { AssistantScreen } from './agent/index';

// Every screen but PublicReturn (a redirect) loads when its route is first
// opened, Library and RecipeView too: in the entry chunk they were most of
// what a signed-out visitor on /p downloaded and never ran. Navigation runs
// in a transition, so the current screen stays up while the next one loads
// and ScreenLoadBar shows the wait (docs/plans/route-code-splitting.md).
const Library = lazyScreen(() => import('./screens/Library'));
const RecipeView = lazyScreen(() => import('./screens/RecipeView'));
const CollectionsIndex = lazyScreen(() => import('./screens/CollectionsIndex'));
const RecipeEdit = lazyScreen(() => import('./screens/RecipeEdit'));
const CookLogEdit = lazyScreen(() => import('./screens/CookLogEdit'));
const CookJournal = lazyScreen(() => import('./screens/CookJournal'));
const ImportScreen = lazyScreen(() => import('./screens/ImportScreen'));
const Settings = lazyScreen(() => import('./screens/Settings'));
const SuggestFeature = lazyScreen(() => import('./screens/SuggestFeature'));
const Admin = lazyScreen(() => import('./screens/Admin'));
const PublicLink = lazyScreen(() => import('./screens/PublicLink'));
const PublicRecipe = lazyScreen(() => import('./screens/PublicRecipe'));

// Start the first screen's chunk now, while React starts, rather than after
// the first render asks for it. App.tsx is evaluated before main.tsx renders.
const ENTRY_SCREENS = { library: Library, recipe: RecipeView, publicLink: PublicLink, publicRecipe: PublicRecipe };
const entryScreen = entryScreenFor(window.location.pathname);
if (entryScreen !== null) ENTRY_SCREENS[entryScreen].preload();

/**
 * Shown while a screen's chunk loads on a page's first render (or a reload
 * after a deploy): the muted line screens use. It mounts after 400 ms, so a
 * fast load shows and announces nothing before the screen's own loading line.
 * It renders no title: the tab keeps index.html's "Sous" until the screen
 * commits (docs/plans/screen-titles.md).
 */
function RouteFallback() {
  const t = useT();
  if (!useDelayedFlag(true, 400)) return null;
  return (
    <p role="status" className="py-12 text-center text-ink-muted">
      {t('common.loading')}
    </p>
  );
}

/**
 * A screen whose tab title is a fixed name, in every state it shows
 * (`docs/plans/screen-titles.md`). Screens titled by what they show (the
 * library and its collections, a recipe, the public pages) render their own
 * `DocumentTitle`; `scripts/invariants.test.ts` checks that every route is
 * one or the other. Inside the Suspense boundary the title commits with the
 * screen: while a lazy screen loads, the previous screen and its title stay.
 */
function Titled({ titleKey, children }: { titleKey: TextKey; children: ReactNode }) {
  const t = useT();
  return (
    <>
      <DocumentTitle title={t(titleKey)} />
      {children}
    </>
  );
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* One Library instance serves both list paths, so it stays mounted across chip changes. */}
        <Route element={<Library />}>
          <Route path={routePaths.home} element={null} />
          <Route path={routePaths.collection} element={null} />
        </Route>
        <Route
          path={routePaths.collectionsIndex}
          element={<Titled titleKey="title.collections"><CollectionsIndex /></Titled>}
        />
        <Route path={routePaths.collectionsUnknown} element={<Navigate to="/" replace />} />
        <Route
          path={routePaths.collectionImport}
          element={<Titled titleKey="title.import"><ImportScreen /></Titled>}
        />
        <Route
          path={routePaths.collectionNewRecipe}
          element={<Titled titleKey="title.newRecipe"><RecipeEdit /></Titled>}
        />
        <Route
          path={routePaths.newRecipe}
          element={<Titled titleKey="title.newRecipe"><RecipeEdit /></Titled>}
        />
        <Route path="/recipe/:id" element={<RecipeView />} />
        <Route
          path="/recipe/:id/edit"
          element={<Titled titleKey="title.editRecipe"><RecipeEdit /></Titled>}
        />
        <Route
          path="/recipe/:id/cooks/new"
          element={<Titled titleKey="title.logCook"><CookLogEdit /></Titled>}
        />
        <Route
          path="/recipe/:id/cooks/:logId/edit"
          element={<Titled titleKey="title.editCook"><CookLogEdit /></Titled>}
        />
        <Route path="/cooks" element={<Titled titleKey="title.cooks"><CookJournal /></Titled>} />
        <Route
          path={routePaths.import}
          element={<Titled titleKey="title.import"><ImportScreen /></Titled>}
        />
        <Route path="/settings" element={<Titled titleKey="title.settings"><Settings /></Titled>} />
        <Route
          path="/suggest"
          element={<Titled titleKey="title.suggest"><SuggestFeature /></Titled>}
        />
        <Route
          path="/assistant"
          element={<Titled titleKey="title.assistant"><AssistantScreen /></Titled>}
        />
        <Route path="/admin" element={<Titled titleKey="title.admin"><Admin /></Titled>} />
        {/* Public collection links: readable without an account (docs/plans/public-collections.md). */}
        <Route path="/p" element={<PublicReturn />} />
        <Route path="/p/:token" element={<PublicLink />} />
        <Route path="/p/:token/r/:recipeId" element={<PublicRecipe />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ScreenLoadBar />
      <SyncToast />
      <AppRoutes />
    </ErrorBoundary>
  );
}
