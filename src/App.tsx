import { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary';
import SyncToast from './components/SyncToast';
import { useT } from './i18n';
import { lazyScreen } from './lib/chunkReload';
import { routePaths } from './lib/routePaths';
import PublicReturn from './screens/PublicReturn';
import { AssistantScreen } from './agent/index';

// Every screen but PublicReturn (a redirect) loads when its route is first
// opened, Library and RecipeView too: in the entry chunk they were most of
// what a signed-out visitor on /p downloaded and never ran. Navigation runs
// in a transition, so the current screen stays up while the next one loads
// (docs/plans/route-code-splitting.md).
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

/**
 * Shown while a screen's chunk loads (first load, or a reload after a
 * deploy): the muted line screens use, faded in late so a fast load shows
 * nothing before the screen's own loading line.
 */
function RouteFallback() {
  const t = useT();
  return (
    <p role="status" className="animate-route-fallback py-12 text-center text-ink-muted">
      {t('common.loading')}
    </p>
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
        <Route path={routePaths.collectionsIndex} element={<CollectionsIndex />} />
        <Route path={routePaths.collectionsUnknown} element={<Navigate to="/" replace />} />
        <Route path={routePaths.collectionImport} element={<ImportScreen />} />
        <Route
          path={routePaths.collectionNewRecipe}
          element={<RecipeEdit />}
        />
        <Route path={routePaths.newRecipe} element={<RecipeEdit />} />
        <Route path="/recipe/:id" element={<RecipeView />} />
        <Route path="/recipe/:id/edit" element={<RecipeEdit />} />
        <Route path="/recipe/:id/cooks/new" element={<CookLogEdit />} />
        <Route path="/recipe/:id/cooks/:logId/edit" element={<CookLogEdit />} />
        <Route path="/cooks" element={<CookJournal />} />
        <Route path={routePaths.import} element={<ImportScreen />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/suggest" element={<SuggestFeature />} />
        <Route path="/assistant" element={<AssistantScreen />} />
        <Route path="/admin" element={<Admin />} />
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
      <SyncToast />
      <AppRoutes />
    </ErrorBoundary>
  );
}
