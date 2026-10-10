import type { TextKey, TranslateParams } from '../i18n';

/**
 * Browser tab titles (`docs/plans/screen-titles.md`). A screen's title is
 * "<screen> · Sous", where <screen> is a recipe title or collection name, or
 * a fixed screen name from the `title.*` catalog keys. Screens with nothing
 * more specific to say (the library, a loading or missing recipe) are just
 * the app's name, which is also the static `<title>` in `index.html`.
 */
export const APP_TITLE = 'Sous';

/** Graphemes kept from a name; a tab shows far fewer, history and bookmarks a few more. */
export const TITLE_NAME_MAX = 120;

/** Bidi controls: ALM, LRM, RLM, LRE-RLO, LRI-PDI. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/**
 * A recipe title or collection name as one line for a tab title: control and
 * bidi characters dropped (so a name cannot reorder " · Sous" around it),
 * whitespace collapsed, cut to `TITLE_NAME_MAX` graphemes with `…`.
 * Undefined when nothing is left.
 */
export function titleName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const flat = raw
    .replace(BIDI_CONTROLS, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat === '') {
    return undefined;
  }
  const parts: string[] = [];
  for (const { segment } of graphemes.segment(flat)) {
    parts.push(segment);
    if (parts.length > TITLE_NAME_MAX) {
      return `${parts.slice(0, TITLE_NAME_MAX - 1).join('').trimEnd()}…`;
    }
  }
  return flat;
}

type Translate = (key: TextKey, params?: TranslateParams) => string;

/** "<name> · Sous" in the UI language, or just "Sous" when the name is blank or missing. */
export function namedTitle(t: Translate, raw: unknown): string {
  const name = titleName(raw);
  return name === undefined ? APP_TITLE : t('title.named', { name });
}
