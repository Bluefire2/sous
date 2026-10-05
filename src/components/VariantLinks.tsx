import { useId } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useT } from '../i18n';
import { useRecipeVariants } from '../lib/recipeStore';
import { chipClass } from '../lib/uiClasses';

/**
 * The recipe's variant group as equals, the original first and labelled
 * (`docs/plans/recipe-variants.md`). Nothing when the recipe has no other
 * variants. The group hook lives here, not in RecipeView, so another
 * recipe's change re-renders this row and not the whole screen.
 */
export default function VariantLinks({ recipeId }: { recipeId: string }) {
  const t = useT();
  const location = useLocation();
  const labelId = useId();
  const variants = useRecipeVariants(recipeId);
  if (variants.length === 0) return null;
  const originalId = variants[0]?.variantOf ?? variants[0]?.id;

  return (
    <nav aria-labelledby={labelId} className="mt-3">
      <p id={labelId} className="text-sm text-ink-muted">
        {t('recipe.variants')}
      </p>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {variants.map((variant) => {
          const label =
            variant.id === originalId
              ? t('recipe.variantOriginal', { title: variant.title })
              : variant.title;
          return (
            <li key={variant.id} className="min-w-0">
              {variant.id === recipeId ? (
                <span aria-current="page" className={`${chipClass(true)} inline-block break-words`}>
                  {label}
                </span>
              ) : (
                // Keeps where the recipe was opened from, so Back still returns there.
                <Link
                  to={`/recipe/${variant.id}`}
                  state={location.state}
                  className={`${chipClass(false)} inline-block break-words`}
                >
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
