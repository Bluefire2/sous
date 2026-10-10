import { useT } from '../../i18n';
import { collectionStore } from '../../lib/collectionStore';
import { primaryBtn } from '../../lib/uiClasses';
import type { MoveApplyStatus } from '../store';
import type { CollectionCreateData } from './parse';
import RecipeMoveRows from './RecipeMoveRows';
import { useCardApply } from './useCardApply';

export default function CollectionCreateCard({
  data,
  cardId,
  apply,
  moveBusy,
}: {
  data: CollectionCreateData;
  cardId: string;
  apply?: MoveApplyStatus;
  moveBusy: boolean;
}) {
  const tr = useT();
  const { applying, applied, movedCount, errorMessage, disabled, onApply } = useCardApply(
    cardId,
    apply,
    moveBusy,
    () => collectionStore.createWithRecipes(data.name, data.recipeIds),
  );

  const count = data.total;
  const hasRecipes = count > 0;
  const leavesCollections = data.sources.some((source) => source.from.kind === 'collection');

  const heading = hasRecipes
    ? tr('assistant.createHeading', { count, name: data.name })
    : tr('assistant.createHeadingEmpty', { name: data.name });

  let buttonLabel = tr('assistant.create');
  if (applying) {
    buttonLabel = tr('assistant.creating');
  } else if (applied && movedCount !== undefined) {
    buttonLabel =
      movedCount > 0
        ? tr('assistant.createApplied', { count: movedCount, name: data.name })
        : tr('assistant.createAppliedEmpty', { name: data.name });
  }

  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
      <h3 className="font-semibold text-ink">{heading}</h3>
      {leavesCollections && (
        <p className="mt-1 text-sm text-ink-muted">{tr('assistant.moveLeaveCurrentCollections')}</p>
      )}
      {hasRecipes && (
        <RecipeMoveRows
          recipeIds={data.recipeIds}
          sources={data.sources}
          preview={data.preview}
          total={data.total}
        />
      )}
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
