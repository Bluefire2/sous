import { useT } from '../../i18n';
import { useRecipes } from '../../lib/recipeStore';
import { dispatch, getAgentSnapshot, type MoveApplyStatus } from '../store';

function cardOnThread(cardId: string): boolean {
  return getAgentSnapshot().messages.some((m) => m.cards?.some((c) => c.id === cardId));
}

/**
 * Apply state for a card that writes the library on confirm. One card
 * applies at a time (`moveBusy`); the result is recorded only while the card
 * is still on the thread.
 */
export function useCardApply(
  cardId: string,
  apply: MoveApplyStatus | undefined,
  moveBusy: boolean,
  run: () => Promise<{ moved: number }>,
) {
  const tr = useT();
  const libraryReady = useRecipes() !== undefined;

  const applying = apply?.phase === 'applying';
  const applied = apply?.phase === 'applied';
  const movedCount = apply?.phase === 'applied' ? apply.moved : undefined;
  const errorMessage = apply?.phase === 'error' ? apply.message : null;
  const otherMoveBusy = moveBusy && !applying;
  const disabled = !libraryReady || applying || applied || otherMoveBusy;

  const onApply = async () => {
    if (!libraryReady || getAgentSnapshot().moveBusy) {
      return;
    }
    dispatch({ type: 'beginMoveApply', cardId });
    try {
      const result = await run();
      if (cardOnThread(cardId)) {
        dispatch({
          type: 'finishMoveApply',
          cardId,
          status: { phase: 'applied', moved: result.moved },
        });
      }
    } catch (err) {
      if (cardOnThread(cardId)) {
        const message = err instanceof Error ? err.message : tr('error.collectionSave');
        dispatch({
          type: 'finishMoveApply',
          cardId,
          status: { phase: 'error', message },
        });
      }
    } finally {
      dispatch({ type: 'endMoveBusy' });
    }
  };

  return { applying, applied, movedCount, errorMessage, disabled, onApply };
}
