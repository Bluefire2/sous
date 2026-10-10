import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { useRecipes } from '../../lib/recipeStore';
import type { CollectionMoveFrom } from './parse';

type PreviewRow = { id: string; title: string; from: CollectionMoveFrom };

function fromLabel(from: CollectionMoveFrom, tr: ReturnType<typeof useT>): string {
  if (from.kind === 'unfiled') {
    return tr('library.recipes');
  }
  return from.name;
}

/**
 * The recipe rows a move or create card files: each title with the
 * collection it leaves, collapsed to the preview until expanded. Titles come
 * from the live library, falling back to the card's preview.
 */
export default function RecipeMoveRows({
  recipeIds,
  sources,
  preview,
  total,
}: {
  recipeIds: string[];
  sources: { id: string; from: CollectionMoveFrom }[];
  preview: PreviewRow[];
  total: number;
}) {
  const tr = useT();
  const recipes = useRecipes();
  const [expanded, setExpanded] = useState(false);

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const recipe of recipes ?? []) {
      map.set(recipe.id, recipe.title);
    }
    return map;
  }, [recipes]);

  const fromById = useMemo(() => {
    const map = new Map<string, CollectionMoveFrom>();
    for (const source of sources) {
      map.set(source.id, source.from);
    }
    return map;
  }, [sources]);

  const previewById = useMemo(() => {
    const map = new Map<string, PreviewRow>();
    for (const row of preview) {
      map.set(row.id, row);
    }
    return map;
  }, [preview]);

  const rows = expanded ? recipeIds : preview.map((row) => row.id);
  const moreCount = total - preview.length;

  return (
    <>
      <ul className="mt-2 space-y-1">
        {rows.map((recipeId) => {
          const row = previewById.get(recipeId);
          const from = fromById.get(recipeId) ?? row?.from;
          const title = titleById.get(recipeId) ?? row?.title ?? recipeId;
          return (
            <li key={recipeId} className="flex justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-ink">{title}</span>
              <span className="shrink-0 text-ink-muted">
                {from ? fromLabel(from, tr) : tr('library.recipes')}
              </span>
            </li>
          );
        })}
      </ul>
      {!expanded && moreCount > 0 && (
        <p className="mt-1 text-sm text-ink-muted">
          {tr('assistant.moveAndMore', { count: moreCount })}
        </p>
      )}
      {recipeIds.length > preview.length && (
        <button
          type="button"
          className="mt-2 text-sm text-accent hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? tr('assistant.moveShowLess') : tr('assistant.moveShowAll')}
        </button>
      )}
    </>
  );
}
