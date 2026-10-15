// The rules live on the server side so a put is compacted the same way on
// both ends; the server never imports `src/`.
export {
  MAX_DONE_STEPS,
  MAX_LANES,
  MAX_LANE_CHARS,
  compactLane,
  compactSteps,
} from '../../server/recipeSteps.ts';
export type { CompactStep } from '../../server/recipeSteps.ts';
