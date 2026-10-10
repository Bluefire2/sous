import type { ReactNode } from 'react';
import { t } from '../../i18n';
import type { AgentWireCard } from '../protocol';
import type { MoveApplyStatus } from '../store';
import CollectionCreateCard from './CollectionCreateCard';
import CollectionMoveCard from './CollectionMoveCard';
import { parseCollectionCreate, parseCollectionMove, parseShoppingList } from './parse';
import ShoppingListCard from './ShoppingListCard';

export type CardRenderContext = {
  checked: Record<string, Record<string, true>>;
  onToggle: (cardId: string, itemKey: string) => void;
  applies: Record<string, MoveApplyStatus>;
  moveBusy: boolean;
};

type RegistryEntry = {
  render: (card: AgentWireCard, ctx: CardRenderContext) => ReactNode;
};

function cardFallback(): ReactNode {
  return (
    <p className="mt-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink-muted">
      {t('assistant.cardUnavailable')}
    </p>
  );
}

function defineCard<T>(
  parse: (v: number, data: unknown) => T | undefined,
  render: (data: T, card: AgentWireCard, ctx: CardRenderContext) => ReactNode,
): RegistryEntry {
  return {
    render(card, ctx) {
      const data = parse(card.v, card.data);
      if (data === undefined) {
        return cardFallback();
      }
      return render(data, card, ctx);
    },
  };
}

const registry: Record<string, RegistryEntry> = {
  shopping_list: defineCard(parseShoppingList, (data, card, ctx) => (
    <ShoppingListCard
      data={data}
      cardId={card.id}
      checked={ctx.checked[card.id]}
      onToggle={(itemKey) => ctx.onToggle(card.id, itemKey)}
    />
  )),
  collection_move: defineCard(parseCollectionMove, (data, card, ctx) => (
    <CollectionMoveCard
      data={data}
      cardId={card.id}
      apply={ctx.applies[card.id]}
      moveBusy={ctx.moveBusy}
    />
  )),
  collection_create: defineCard(parseCollectionCreate, (data, card, ctx) => (
    <CollectionCreateCard
      data={data}
      cardId={card.id}
      apply={ctx.applies[card.id]}
      moveBusy={ctx.moveBusy}
    />
  )),
};

export function renderAgentCard(card: AgentWireCard, ctx: CardRenderContext): ReactNode {
  try {
    const entry = registry[card.type];
    if (!entry) {
      return cardFallback();
    }
    return entry.render(card, ctx);
  } catch {
    return cardFallback();
  }
}
