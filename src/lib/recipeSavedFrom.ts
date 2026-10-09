// The rule lives on the server side so a put is compacted the same way on
// both ends; the server never imports `src/`.
export {
  compactSavedFrom,
  savedFromName,
  type SavedFrom,
} from '../../server/recipeSavedFrom.ts';
