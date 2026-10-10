import { useT, type MessageKey, type TranslateParams } from '../i18n';
import type { ImportWarning } from '../lib/importCheck';
import type { IngredientSection } from '../lib/types';

type Translate = (key: MessageKey, params?: TranslateParams) => string;

/**
 * The sentence for one warning. `UNGROUNDED_INGREDIENT` names the ingredient
 * now at its position, so an edit or a translation shows the current name;
 * `null` when that position is gone.
 */
export function importWarningText(
  warning: ImportWarning,
  sections: readonly IngredientSection[],
  t: Translate,
): string | null {
  if (warning.code === 'UNGROUNDED_INGREDIENT') {
    if (warning.at === undefined) return null;
    const item = sections[warning.at[0]]?.items[warning.at[1]]?.item;
    return item === undefined ? null : t('importWarning.UNGROUNDED_INGREDIENT', { item });
  }
  return t(`importWarning.${warning.code}`);
}

/** The warnings as a list of sentences. `sections` supplies ingredient names. */
export default function ImportWarningList({
  warnings,
  sections,
  className,
}: {
  warnings: readonly ImportWarning[];
  sections: readonly IngredientSection[];
  className?: string;
}) {
  const t = useT();
  const lines = warnings
    .map((warning) => importWarningText(warning, sections, t))
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return (
    <ul className={`flex list-disc flex-col gap-1 pl-5 ${className ?? ''}`}>
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}
