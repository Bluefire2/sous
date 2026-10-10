import { Link } from 'react-router-dom';
import { useT } from '../../i18n';
import type { ShoppingListData } from './parse';
import { secondaryBtn } from '../../lib/uiClasses';

function formatQty(quantity: number): string {
  const rounded = Math.round(quantity * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function itemLine(
  item: ShoppingListData['sections'][number]['items'][number],
  optionalLabel: string,
): string {
  const parts: string[] = [];
  if (item.quantity !== undefined) {
    parts.push(formatQty(item.quantity));
  }
  if (item.unit) {
    parts.push(item.unit);
  }
  parts.push(item.item);
  let line = parts.join(' ');
  if (item.note) {
    line += ` (${item.note})`;
  }
  if (item.optional) {
    line += ` · ${optionalLabel}`;
  }
  return line;
}

function buildPlainText(
  data: ShoppingListData,
  recipesHeading: string,
  optionalLabel: string,
): string {
  const lines: string[] = [data.title, ''];
  if (data.recipes.length > 0) {
    lines.push(recipesHeading);
    for (const recipe of data.recipes) {
      lines.push(`- ${recipe.title}`);
    }
    lines.push('');
  }
  for (const section of data.sections) {
    lines.push(section.name);
    for (const item of section.items) {
      lines.push(`- ${itemLine(item, optionalLabel)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export default function ShoppingListCard({
  data,
  cardId,
  checked,
  onToggle,
}: {
  data: ShoppingListData;
  cardId: string;
  checked: Record<string, true> | undefined;
  onToggle: (itemKey: string) => void;
}) {
  const tr = useT();
  const optionalLabel = tr('recipe.optionalIngredient');
  const copyAsText = () => {
    try {
      navigator.clipboard
        .writeText(buildPlainText(data, tr('assistant.recipesHeading'), optionalLabel))
        .catch(() => {
          // ignore clipboard failures
        });
    } catch {
      // ignore clipboard failures
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-ink">{data.title}</h3>
        <button type="button" onClick={copyAsText} className={`shrink-0 px-3 py-1 text-sm ${secondaryBtn}`}>
          {tr('assistant.copyAsText')}
        </button>
      </div>
      {data.recipes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.recipes.map((recipe, index) => (
            <Link
              key={`${recipe.id}-${index}`}
              to={`/recipe/${recipe.id}`}
              className="rounded-full border border-line bg-page px-2.5 py-0.5 text-sm text-ink hover:bg-surface-muted"
            >
              {recipe.title}
            </Link>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-3">
        {data.sections.map((section, index) => (
          <div key={`${section.name}-${index}`}>
            <p className="text-sm font-medium text-ink-muted">{section.name}</p>
            <ul className="mt-1 space-y-1">
              {section.items.map((item) => {
                const isChecked = checked?.[item.key] === true;
                const inputId = `${cardId}-${item.key}`;
                return (
                  <li key={item.key}>
                    <label
                      htmlFor={inputId}
                      className={`flex cursor-pointer items-start gap-2 text-sm ${isChecked ? 'text-ink-muted line-through' : 'text-ink'}`}
                    >
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggle(item.key)}
                        className="mt-0.5 shrink-0"
                      />
                      <span>{itemLine(item, optionalLabel)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
