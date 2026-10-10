import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import DocumentTitle from './components/DocumentTitle';
import ErrorBoundary from './components/ErrorBoundary';
import SyncToast from './components/SyncToast';
import { useT, type TextKey } from './i18n';
import { routePaths } from './lib/routePaths';
import CollectionsIndex from './screens/CollectionsIndex';
import Library from './screens/Library';
import RecipeView from './screens/RecipeView';
import RecipeEdit from './screens/RecipeEdit';
import CookLogEdit from './screens/CookLogEdit';
import CookJournal from './screens/CookJournal';
import ImportScreen from './screens/ImportScreen';
import Settings from './screens/Settings';
import SuggestFeature from './screens/SuggestFeature';
import Admin from './screens/Admin';
import PublicLink from './screens/PublicLink';
import PublicRecipe from './screens/PublicRecipe';
import PublicReturn from './screens/PublicReturn';
import { AssistantScreen } from './agent/index';

/**
 * A screen whose tab title is a fixed name, in every state it shows
 * (`docs/plans/screen-titles.md`). Screens titled by what they show (the
 * library and its collections, a recipe, the public pages) render their own
 * `DocumentTitle`; `scripts/invariants.test.ts` checks that every route is
 * one or the other.
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
