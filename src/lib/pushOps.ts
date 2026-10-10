export type PushOp =
  | {
      kind: 'recipe.put';
      payload: import('./types').Recipe;
      /**
       * Someone else's recipe, saved by an editor. The server finds the owner
       * and role from the session's shares and never creates the row in this
       * account's tree.
       */
      shared?: true;
    }
  | { kind: 'recipe.delete'; payload: { id: string; updatedAt: number } }
  | { kind: 'chat.put'; payload: import('./types').ChatMessage }
  | { kind: 'chat.clearForRecipe'; payload: { recipeId: string; at: number } }
  | {
      kind: 'cookState.put';
      payload: import('./types').CookStateRow & { updatedAt: number };
    }
  | { kind: 'photo.delete'; payload: { id: string; updatedAt: number } }
  | { kind: 'collection.put'; payload: import('./types').Collection }
  | { kind: 'collection.delete'; payload: { id: string; updatedAt: number } }
  | { kind: 'cookLog.put'; payload: import('./types').CookLog }
  | { kind: 'cookLog.delete'; payload: { id: string; updatedAt: number } };

export const MAX_PUSH_OPS = 50;
