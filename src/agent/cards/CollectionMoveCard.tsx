import { useT } from '../../i18n';
import { collectionStore } from '../../lib/collectionStore';
import { primaryBtn } from '../../lib/uiClasses';
import type { MoveApplyStatus } from '../store';
import type { CollectionMoveData } from './parse';
import RecipeMoveRows from './RecipeMoveRows';
import { useCardApply } from './useCardApply';

export default function CollectionMoveCard({
  data,
  cardId,
  apply,
  moveBusy,
}: {
  data: CollectionMoveData;
  cardId: string;
  apply?: MoveApplyStatus;
  moveBusy: boolean;
}) {
  const tr = useT();
  const { applying, applied, movedCount, errorMessage, disabled, onApply } = useCardApply(
    cardId,
    apply,
    moveBusy,
    () =>
      collectionStore.moveRecipes(
        data.recipeIds,
        data.destination.kind === 'unfiled' ? 'default' : data.destination.id,
      ),
  );

  const count = data.total;
  const destName = data.destination.kind === 'collection' ? data.destination.name : undefined;

  const heading =
    data.destination.kind === 'collection'
      ? tr('assistant.moveHeadingToCollection', { count, name: destName ?? '' })
      : tr('assistant.moveHeadingToRecipes', { count });

  let buttonLabel = tr('assistant.move');
  if (applying) {
    buttonLabel = tr('assistant.moving');
  } else if (applied && movedCount !== undefined) {
    buttonLabel =
      data.destination.kind === 'collection'
        ? tr('assistant.moveAppliedToCollection', { count: movedCount, name: destName ?? '' })
        : tr('assistant.moveAppliedToRecipes', { count: movedCount });
  }

  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
      <h3 className="font-semibold text-ink">{heading}</h3>
      <p className="mt-1 text-sm text-ink-muted">{tr('assistant.moveLeaveCurrentCollections')}</p>
      <RecipeMoveRows
        recipeIds={data.recipeIds}
        sources={data.sources}
        preview={data.preview}
        total={data.total}
      />
      {errorMessage !== null && <p className="mt-2 text-sm text-danger">{errorMessage}</p>}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          void onApply();
        }}
        className={`mt-3 px-4 py-2 text-sm disabled:opacity-50 ${primaryBtn}`}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
