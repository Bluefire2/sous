/**
 * The browser tab title for the screen that renders it (`docs/plans/screen-titles.md`).
 * React 19 hoists `<title>` into `<head>`, inserting it before the static
 * `<title>Sous</title>` from `index.html`, so it wins (a document's title is
 * its first `<title>`), and removes it when the screen unmounts, which leaves
 * the static "Sous". One screen renders this at a time: two at once leave
 * the choice to React's insertion order, which React does not promise.
 * Nothing else in `src/` renders a `<title>` (`scripts/invariants.test.ts`).
 *
 * `title` is one finished string from the catalogs or `namedTitle`: React
 * wants a single text child, never parts joined in JSX.
 */
export default function DocumentTitle({ title }: { title: string }) {
  return <title>{title}</title>;
}
