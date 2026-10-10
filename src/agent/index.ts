import { lazyScreen } from '../lib/chunkReload';

// The screen is its own chunk (docs/plans/route-code-splitting.md); the entry
// link stays eager, since Library shows it.
export const AssistantScreen = lazyScreen(() => import('./AssistantScreen'));
export { default as AssistantEntryLink } from './AssistantEntryLink';
