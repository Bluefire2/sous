import type { ImportCheck } from '../../server/importWarnings.ts';

// `reconcileImportCheck` lives on the server side so the MCP `update_recipe`
// tool reconciles exactly as `recipeStore.save` does; the server never
// imports `src/`.
export {
  IMPORT_WARNING_CODES,
  compactImportCheck,
  isImportWarningCode,
  readImportWarnings,
  reconcileImportCheck,
  type ImportCheck,
  type ImportWarning,
  type ImportWarningCode,
} from '../../server/importWarnings.ts';

/** The banner shows to someone who can edit, while warnings remain and none were dismissed. */
export function showsImportWarnings(check: ImportCheck | undefined, canEdit: boolean): boolean {
  return canEdit && check !== undefined && check.warnings.length > 0 && check.dismissedAt === undefined;
}
