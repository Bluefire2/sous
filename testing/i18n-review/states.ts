/**
 * How the review reaches each state in docs/i18n-review/screens.json, in test
 * mode (docs/plans/i18n-review-ci.md, States). The manifest's `setup` text is
 * the description for people and for the judge; this file is the script.
 * states.test.ts keeps the two in step: every manifest id has an entry here.
 */
import type { Page } from 'playwright';
import type { FIXTURE_IDS } from '../fixtures.ts';
import type { PersonaName } from '../personas.ts';
import type { Lang, MessageKey } from './catalog.ts';
import type { MockName } from './mocks.ts';

export interface CaptureContext {
  lang: Lang;
  /** The catalog label for `key` in `lang`. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  /** Any form of `key` in `lang`, params unfilled, for waiting on text. */
  p: (key: MessageKey) => RegExp;
  ids: typeof FIXTURE_IDS;
  /** The token of member's public Weeknights link. */
  publicToken: string;
  /** The token of member's Overnight oats recipe link. */
  publicRecipeToken: string;
  /** The id of `capped`'s copy saved from that link. */
  savedCopyId: string;
}

export interface Capturable {
  persona: PersonaName | 'signedOut';
  path: string | ((ctx: CaptureContext) => string);
  /** Steps after the page loads: open a sheet, check a box. Never a write unless the state needs one. */
  reach?: (page: Page, ctx: CaptureContext) => Promise<void>;
  mocks?: MockName[];
  /**
   * For a state that fades on a timer (a toast): browser timers run until
   * `reach` returns, then stop. Other states only freeze the date.
   */
  pauseClock?: true;
}

/** Why a state is not captured. Every manifest state is scripted unless one of these applies. */
export const SKIP_REASONS = ['needs stored photos', 'needs a real Google sign-in'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type StateEntry = Capturable | { skip: SkipReason };

export function isSkipped(entry: StateEntry): entry is { skip: SkipReason } {
  return 'skip' in entry;
}

async function clickButton(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
}

/** A 64×64 PNG for the photo picker, so no file is checked in. */
async function photoFile(page: Page): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const buffer = Buffer.from(
    (await page.evaluate(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const g = canvas.getContext('2d');
      g.fillStyle = '#c47a3a';
      g.fillRect(0, 0, 64, 64);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`)) as string,
    'base64',
  );
  return { name: 'note.png', mimeType: 'image/png', buffer };
}

async function extractClean(page: Page, ctx: CaptureContext): Promise<void> {
  await page.locator('textarea').fill('https://example.com/spring-pea-soup');
  await clickButton(page, ctx.t('import.extractRecipe'));
  await page.getByRole('button', { name: ctx.t('common.save'), exact: true }).first().waitFor();
}

async function selectAllInCollection(page: Page, ctx: CaptureContext): Promise<void> {
  await clickButton(page, ctx.t('library.select'));
  await page.getByRole('checkbox', { name: ctx.t('library.selectRecipe', { title: 'Lemon garlic roast chicken' }) }).check();
  await page.getByLabel(ctx.t('library.selectAll'), { exact: true }).check();
}

const weeknights = (ctx: CaptureContext) => `/collections/${ctx.ids.member.weeknights}`;
const baking = (ctx: CaptureContext) => `/collections/${ctx.ids.member.baking}`;
/** A recipe whose language label differs from the UI language, so its translate chip shows. */
const labelledRecipe = (ctx: CaptureContext) =>
  `/recipe/${ctx.lang === 'uk' ? ctx.ids.member.eggTarts : ctx.ids.member.borscht}`;

async function openInviteAndCreate(page: Page, ctx: CaptureContext): Promise<void> {
  await clickButton(page, ctx.t('library.inviteLink'));
  await page.getByRole('dialog').getByRole('button', { name: ctx.t('admin.createLink'), exact: true }).click();
}

async function extractUrl(page: Page, ctx: CaptureContext, url = 'https://example.com/spring-pea-soup'): Promise<void> {
  await page.locator('textarea').fill(url);
  await clickButton(page, ctx.t('import.extractRecipe'));
}

async function extractText(page: Page, ctx: CaptureContext, text: string): Promise<void> {
  await page.locator('textarea').fill(text);
  await clickButton(page, ctx.t('import.extractRecipe'));
}

/** Opens the feedback card's note field and its "What's included" list. */
async function openFeedbackDetails(page: Page, ctx: CaptureContext): Promise<void> {
  await page.getByText(ctx.t('importFeedback.heading'), { exact: true }).first().waitFor();
  await clickButton(page, ctx.t('importFeedback.addNote'));
  await page.getByText(ctx.t('importFeedback.included'), { exact: true }).first().click();
}

const TOMATO_SOUP_TEXT = 'Tomato soup\n6 tomatoes\n1 onion\nsalt';
const GUMBO_BRIEF = 'shrimp gumbo in a pressure cooker for six';

/** Create mode: type the brief and press Generate recipe. The mode switch is already on Create. */
async function writeRecipe(page: Page, ctx: CaptureContext, brief: string): Promise<void> {
  await page.locator('textarea').fill(brief);
  await clickButton(page, ctx.t('import.generateRecipe'));
}

/** A bulk run of three links: one clean, one with a warning, one that fails. */
async function runBulk(page: Page, ctx: CaptureContext): Promise<void> {
  await page.getByRole('checkbox', { name: ctx.t('import.bulk') }).check();
  await page
    .locator('textarea')
    .fill(['https://example.com/pea-soup', 'https://example.com/check', 'https://example.com/broken'].join('\n'));
  await clickButton(page, ctx.t('import.extractRecipes'));
  await page.getByRole('dialog').getByRole('button', { name: ctx.t('saveSheet.noCollection') }).click();
  await page.getByRole('button', { name: ctx.t('common.backToLibrary'), exact: true }).waitFor();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The translate chip, labelled ("Ukrainian · Translate") or not. */
async function tapTranslate(page: Page, ctx: CaptureContext): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`${escapeRegExp(ctx.t('recipe.translate'))}$`) }).click();
}

async function openShare(page: Page, ctx: CaptureContext): Promise<void> {
  await clickButton(page, ctx.t('common.share'));
  await page.getByRole('dialog').waitFor();
}

/** Sends one message on /assistant; the reply comes from an `agent…` mock. */
async function ask(page: Page, ctx: CaptureContext, question: string): Promise<void> {
  await page.getByPlaceholder(ctx.t('assistant.placeholder')).fill(question);
  await clickButton(page, ctx.t('assistant.send'));
}

export const STATES: Record<string, StateEntry> = {
  'library-empty': { persona: 'empty', path: '/' },
  'library-collections-empty': { persona: 'empty', path: '/' },
  'collections-index': { persona: 'member', path: '/collections' },
  'library-populated': { persona: 'member', path: '/' },
  'library-collection-menu': {
    persona: 'member',
    path: weeknights,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.collectionActions', { name: 'Weeknights' }));
      await page.locator('[aria-expanded="true"]').waitFor();
    },
  },
  'library-select': { persona: 'member', path: weeknights, reach: selectAllInCollection },
  'library-move-many': {
    persona: 'member',
    path: weeknights,
    reach: async (page, ctx) => {
      await selectAllInCollection(page, ctx);
      await clickButton(page, ctx.t('library.moveSelected'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'library-invite-confirm': {
    persona: 'member',
    path: '/',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.inviteLink'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'library-invite-copied': {
    persona: 'member',
    path: '/',
    mocks: ['inviteCreated', 'clipboardWorks'],
    pauseClock: true,
    reach: async (page, ctx) => {
      await openInviteAndCreate(page, ctx);
      await page.getByText(ctx.t('library.inviteCopied'), { exact: true }).waitFor();
    },
  },
  'library-invite-copy-failed': {
    persona: 'member',
    path: '/',
    mocks: ['inviteCreated', 'clipboardFails'],
    pauseClock: true,
    reach: async (page, ctx) => {
      await openInviteAndCreate(page, ctx);
      await page.getByText(ctx.t('library.inviteCopyFailed'), { exact: true }).waitFor();
    },
  },
  'library-invite-quota': {
    persona: 'member',
    path: '/',
    mocks: ['inviteLimit'],
    reach: async (page, ctx) => {
      await openInviteAndCreate(page, ctx);
      await page.getByRole('alert').getByText(ctx.p('error.memberInviteLimit')).waitFor();
    },
  },
  settings: { persona: 'member', path: '/settings' },
  'settings-cooking-changed': {
    persona: 'member',
    path: '/settings',
    reach: async (page, ctx) => {
      // Device settings: localStorage in this browser context only, no request.
      await page.getByLabel(ctx.t('settings.keepScreenAwake'), { exact: true }).uncheck();
      await clickButton(page, ctx.t('settings.textSizeLarge'));
      await page
        .getByRole('button', { name: ctx.t('settings.textSizeLarge'), exact: true, pressed: true })
        .waitFor();
    },
  },
  suggest: {
    persona: 'member',
    path: '/suggest',
    reach: async (page, ctx) => {
      await page.getByText(ctx.t('suggest.included'), { exact: true }).click();
    },
  },
  'suggest-sent': {
    persona: 'member',
    path: '/suggest',
    mocks: ['suggestionAccepted'],
    reach: async (page, ctx) => {
      await page.getByLabel(ctx.t('suggest.label'), { exact: true }).fill('A timer for each step');
      await clickButton(page, ctx.t('suggest.send'));
      await page.getByText(ctx.t('suggest.sent'), { exact: true }).waitFor();
    },
  },
  'suggest-signed-out': { persona: 'signedOut', path: '/suggest' },
  'settings-invite-link': {
    persona: 'member',
    path: '/settings',
    mocks: ['inviteCreated'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('admin.createLink'));
      await page.getByLabel(ctx.t('admin.newInviteLink'), { exact: true }).waitFor();
    },
  },
  'settings-connected-apps-empty': { persona: 'empty', path: '/settings' },
  'settings-connected-apps-list': { persona: 'member', path: '/settings' },
  'settings-connected-apps-disconnect-error': {
    persona: 'member',
    path: '/settings',
    mocks: ['disconnectFails'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('settings.connectedAppsDisconnect'));
      await page.getByText(ctx.p('settings.connectedAppsDisconnectError')).waitFor();
    },
  },
  'settings-kitchen-profile': {
    persona: 'member',
    path: '/settings',
    mocks: ['kitchenProfileSaved'],
    reach: async (page, ctx) => {
      await page.getByRole('heading', { name: ctx.t('settings.kitchenTitle') }).scrollIntoViewIfNeeded();
      await clickButton(page, ctx.t('common.save'));
      await page.getByText(ctx.t('settings.kitchenSaved'), { exact: true }).waitFor();
    },
  },
  'settings-kitchen-profile-save-error': {
    persona: 'member',
    path: '/settings',
    mocks: ['kitchenProfileSaveFails'],
    reach: async (page, ctx) => {
      await page.getByRole('heading', { name: ctx.t('settings.kitchenTitle') }).scrollIntoViewIfNeeded();
      await clickButton(page, ctx.t('common.save'));
      await page.getByText(ctx.t('settings.kitchenSaveError'), { exact: true }).waitFor();
    },
  },
  'settings-measurements': {
    persona: 'member',
    path: '/settings',
    reach: async (page, ctx) => {
      await page.getByRole('heading', { name: ctx.t('settings.measurements') }).scrollIntoViewIfNeeded();
    },
  },
  'settings-measurements-save-error': {
    persona: 'member',
    path: '/settings',
    mocks: ['preferencesSaveFails'],
    reach: async (page, ctx) => {
      await page.getByRole('heading', { name: ctx.t('settings.measurements') }).scrollIntoViewIfNeeded();
      await clickButton(page, ctx.t('settings.unitsAsWritten'));
      await page.getByText(ctx.t('settings.measurementsSaveFailed'), { exact: true }).waitFor();
    },
  },
  admin: { persona: 'owner', path: '/admin' },
  'library-add-sheet': {
    persona: 'member',
    path: '/',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.addRecipe'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'library-language-menu': {
    persona: 'member',
    path: '/',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.languageMenu'));
      await page.locator('[aria-expanded="true"]').waitFor();
    },
  },
  // Weeknights holds the roast chicken, the one recipe with logged cooks.
  'library-sort-menu': {
    persona: 'member',
    path: weeknights,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.sortMenu', { order: ctx.t('library.sortUpdated') }));
      await page.locator('[aria-expanded="true"]').waitFor();
    },
  },
  'library-show-more': {
    persona: 'member',
    path: '/',
    mocks: ['longLibrary'],
    reach: async (page, ctx) => {
      const more = page.getByRole('button', { name: ctx.p('library.showMore') });
      await more.scrollIntoViewIfNeeded();
      await page.getByText(ctx.p('library.shownOfTotal')).waitFor();
    },
  },
  'import-idle': { persona: 'member', path: '/import' },
  'import-photos': {
    persona: 'member',
    path: '/import',
    reach: async (page) => {
      await page.locator('input[type="file"]').first().setInputFiles(await photoFile(page));
      await page.locator('img').first().waitFor();
    },
  },
  'import-bulk': {
    persona: 'member',
    path: '/import',
    reach: async (page, ctx) => {
      // The label holds the hint too, so the name only starts with "Bulk import".
      await page.getByRole('checkbox', { name: ctx.t('import.bulk') }).check();
    },
  },
  'import-create-idle': {
    persona: 'member',
    path: '/import',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await page.getByRole('checkbox', { name: ctx.t('import.searchWeb') }).waitFor();
    },
  },
  'import-create-preview': {
    persona: 'member',
    path: '/import',
    mocks: ['importGenerated'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await page.getByRole('checkbox', { name: ctx.t('import.searchWeb') }).check();
      await writeRecipe(page, ctx, GUMBO_BRIEF);
      await page.getByText(ctx.t('import.sources'), { exact: true }).first().waitFor();
    },
  },
  'import-create-profile-unavailable': {
    persona: 'member',
    path: '/import',
    mocks: ['importBriefProfileUnavailable'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await writeRecipe(page, ctx, 'pad thai for two');
      await page.getByText(ctx.t('error.importProfileUnavailable'), { exact: true }).waitFor();
    },
  },
  'import-create-no-recipe': {
    persona: 'member',
    path: '/import',
    mocks: ['importBriefNoRecipe'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await writeRecipe(page, ctx, 'what is the weather tomorrow');
      await page.getByText(ctx.t('error.importNoRecipeBrief'), { exact: true }).waitFor();
      // The "What's included" list names the idea; open it so that line is judged.
      await openFeedbackDetails(page, ctx);
    },
  },
  'import-create-writing': {
    persona: 'member',
    path: '/import',
    mocks: ['importHangs'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await writeRecipe(page, ctx, GUMBO_BRIEF);
      await page.getByText(ctx.t('import.generatingHint'), { exact: true }).waitFor();
    },
  },
  'import-create-too-long': {
    persona: 'member',
    path: '/import',
    mocks: ['importBriefTooLong'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await writeRecipe(page, ctx, GUMBO_BRIEF);
      await page.getByText(ctx.t('error.importBriefTooLong'), { exact: true }).waitFor();
    },
  },
  'import-create-rate-limited': {
    persona: 'member',
    path: '/import',
    mocks: ['importSearchRateLimited'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await page.getByRole('checkbox', { name: ctx.t('import.searchWeb') }).check();
      await writeRecipe(page, ctx, GUMBO_BRIEF);
      await page.getByText(ctx.t('error.importSearchRateLimited'), { exact: true }).waitFor();
    },
  },
  'import-llm-budget': {
    persona: 'member',
    path: '/import',
    mocks: ['llmBudgetExceeded'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await writeRecipe(page, ctx, GUMBO_BRIEF);
      await page.getByText(ctx.t('error.llmBudgetExceeded'), { exact: true }).waitFor();
    },
  },
  'import-create-failed': {
    persona: 'member',
    path: '/import',
    mocks: ['importGenerateFailed'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.modeCreate'));
      await writeRecipe(page, ctx, GUMBO_BRIEF);
      await page.getByText(ctx.t('error.importGenerateFailed'), { exact: true }).waitFor();
      await page.getByText(ctx.t('importFeedback.heading'), { exact: true }).first().waitFor();
    },
  },
  'import-preview': { persona: 'member', path: '/import', mocks: ['importClean'], reach: extractClean },
  'import-preview-guessed-language': {
    persona: 'member',
    path: '/import',
    mocks: ['importEnglish'],
    reach: async (page, ctx) => {
      await extractUrl(page, ctx);
      await page.getByText(ctx.p('import.looksLike')).waitFor();
    },
  },
  'import-preview-translate-on': {
    persona: 'member',
    path: '/import',
    mocks: ['importItalian'],
    reach: async (page, ctx) => {
      await extractUrl(page, ctx);
      await page.getByRole('checkbox', { name: ctx.t('import.translateInto'), checked: true }).waitFor();
    },
  },
  'import-preview-translate-failed': {
    persona: 'member',
    path: '/import',
    mocks: ['importTranslateFailed'],
    reach: async (page, ctx) => {
      await extractUrl(page, ctx);
      await page.getByText(ctx.t('import.translateFailedNotice'), { exact: true }).waitFor();
    },
  },
  'import-preview-pasted-hint': {
    persona: 'member',
    path: '/import',
    mocks: ['importItalian'],
    reach: async (page, ctx) => {
      await extractText(page, ctx, 'Zuppa di piselli\n500 g di piselli\n1 cipolla\nCuocere 20 minuti e frullare.');
      await page.getByText(ctx.t('import.pastedOriginalNotKept'), { exact: true }).waitFor();
    },
  },
  'import-bulk-translate': {
    persona: 'member',
    path: '/import',
    reach: async (page, ctx) => {
      // The label holds the hint too, so the name only starts with "Bulk import".
      await page.getByRole('checkbox', { name: ctx.t('import.bulk') }).check();
    },
  },
  'import-preview-warnings': {
    persona: 'member',
    path: '/import',
    mocks: ['importWarnings'],
    reach: async (page, ctx) => {
      await extractText(page, ctx, TOMATO_SOUP_TEXT);
      await page.getByText(ctx.t('importWarning.previewHeading'), { exact: true }).waitFor();
    },
  },
  'import-error-model-failed': {
    persona: 'member',
    path: '/import',
    mocks: ['importModelFailed'],
    reach: async (page, ctx) => {
      await extractUrl(page, ctx);
      await page.getByText(ctx.t('error.importModelFailed'), { exact: true }).waitFor();
    },
  },
  'import-bulk-summary': {
    persona: 'member',
    path: '/import',
    // Saves go to a mocked push, so the member's library stays as seeded.
    mocks: ['importBulk', 'pushAccepted'],
    reach: runBulk,
  },
  'import-failed-feedback': {
    persona: 'member',
    path: '/import',
    mocks: ['importNoRecipe'],
    reach: async (page, ctx) => {
      await extractUrl(page, ctx, 'https://example.com/');
      await openFeedbackDetails(page, ctx);
    },
  },
  'import-preview-feedback': {
    persona: 'member',
    path: '/import',
    mocks: ['importWarnings'],
    reach: async (page, ctx) => {
      await extractText(page, ctx, 'Pancakes\n\nIngredients:\n- 2 eggs\n- 1 cup flour\n- 1 cup milk');
      await openFeedbackDetails(page, ctx);
    },
  },
  'import-preview-rating': {
    persona: 'member',
    path: '/import',
    mocks: ['importClean'],
    // The rating row itself is in import-preview; this is the card after thumbs down.
    reach: async (page, ctx) => {
      await extractClean(page, ctx);
      await clickButton(page, ctx.t('importFeedback.ratingDown'));
      await page.getByText(ctx.t('importFeedback.heading'), { exact: true }).waitFor();
    },
  },
  'import-bulk-feedback': {
    persona: 'member',
    path: '/import',
    mocks: ['importBulk', 'pushAccepted'],
    reach: async (page, ctx) => {
      await runBulk(page, ctx);
      // The failed row's; the row with a warning has one too, above it.
      await page.getByRole('button', { name: ctx.t('importFeedback.reportRow'), exact: true }).last().click();
      await page.getByText(ctx.t('importFeedback.heading'), { exact: true }).waitFor();
    },
  },
  'recipe-view-translate-labelled': {
    persona: 'member',
    // A recipe whose language label differs from the UI language.
    path: (ctx) => `/recipe/${ctx.lang === 'uk' ? ctx.ids.member.eggTarts : ctx.ids.member.borscht}`,
  },
  'recipe-view-translate-unlabelled': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.overnightOats}` },
  'recipe-view-translate-loading': {
    persona: 'member',
    path: labelledRecipe,
    mocks: ['translateHangs'],
    reach: async (page, ctx) => {
      await tapTranslate(page, ctx);
      await page.getByRole('button', { name: ctx.t('recipe.translating'), exact: true }).waitFor();
    },
  },
  'recipe-view-translate-translated': {
    persona: 'member',
    path: labelledRecipe,
    mocks: ['translateOk'],
    reach: async (page, ctx) => {
      await tapTranslate(page, ctx);
      await page.getByRole('button', { name: ctx.p('recipe.translatedFrom') }).waitFor();
    },
  },
  'recipe-view-translate-error': {
    persona: 'member',
    path: labelledRecipe,
    mocks: ['translateFails'],
    reach: async (page, ctx) => {
      await tapTranslate(page, ctx);
      await page.getByRole('button', { name: ctx.t('recipe.translateRetry'), exact: true }).waitFor();
    },
  },
  'recipe-view-translate-already': {
    persona: 'member',
    // No language label, so the chip reads "Translate" in every UI language.
    path: (ctx) => `/recipe/${ctx.ids.member.overnightOats}`,
    mocks: ['translateAlready'],
    reach: async (page, ctx) => {
      await tapTranslate(page, ctx);
      await page.getByText(ctx.p('recipe.alreadyInLanguage')).waitFor();
    },
  },
  'recipe-view': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}` },
  'recipe-view-large-text': {
    persona: 'member',
    path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}`,
    reach: async (page, ctx) => {
      // The text size is read from localStorage, so set it and load the recipe again.
      await page.evaluate(`localStorage.setItem('cook.recipeTextSize', 'large')`);
      await page.reload();
      await page.getByRole('heading', { name: ctx.t('common.steps'), exact: true }).waitFor();
    },
  },
  'recipe-view-import-warnings': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.bananaBread}` },
  'recipe-view-variants': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.herbRoastChicken}` },
  'recipe-view-import-retry-sheet': {
    persona: 'member',
    path: (ctx) => `/recipe/${ctx.ids.member.bananaBread}`,
    mocks: ['importWarnings'],
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('importWarning.retry'));
      await page.getByRole('dialog').getByText(ctx.t('importWarning.replaceTitle'), { exact: true }).waitFor();
    },
  },
  'recipe-view-cook': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.roastChicken}` },
  'recipe-view-your-cooks': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.roastChicken}` },
  // The member reads in metric, and the roast chicken is written in pounds and °F.
  'recipe-view-metric': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.roastChicken}` },
  'recipe-view-share-copied': {
    persona: 'member',
    path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}`,
    mocks: ['shareUnavailable', 'clipboardWorks'],
    pauseClock: true,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await page.getByText(ctx.t('recipe.textCopied'), { exact: true }).waitFor();
    },
  },
  'recipe-view-share-copy-failed': {
    persona: 'member',
    path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}`,
    mocks: ['shareUnavailable', 'clipboardFails'],
    pauseClock: true,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await page.getByText(ctx.t('recipe.textCopyFailed'), { exact: true }).waitFor();
    },
  },
  'recipe-edit': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}/edit` },
  'recipe-edit-lang-hint': {
    persona: 'member',
    path: labelledRecipe,
    // The hint comes from the translate response's detection, held in memory,
    // so the edit form is reached by the Edit link, not a reload.
    mocks: ['translateDetectsRussian'],
    reach: async (page, ctx) => {
      await Promise.all([page.waitForResponse('**/api/translate'), tapTranslate(page, ctx)]);
      await page.getByRole('link', { name: ctx.t('common.edit'), exact: true }).click();
      await page.getByText(ctx.p('form.looksLikeLanguage')).waitFor();
    },
  },
  'recipe-new': { persona: 'member', path: '/recipe/new' },
  'recipe-chat': {
    persona: 'member',
    // Has a seeded question and answer.
    path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}`,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('recipe.ask'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'share-collection-sheet': {
    persona: 'member',
    path: baking,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'share-collection-sheet-links': {
    persona: 'member',
    path: baking,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await clickButton(page, ctx.t('share.byLink'));
    },
  },
  'share-collection-sheet-offline': {
    persona: 'member',
    path: baking,
    reach: async (page, ctx) => {
      await page.context().setOffline(true);
      await openShare(page, ctx);
      const dialog = page.getByRole('dialog');
      await dialog.getByText(ctx.t('error.sharingOffline'), { exact: true }).waitFor();
      await dialog.locator('input[type="email"]').fill('someone@example.invalid');
      await dialog.getByRole('button', { name: ctx.t('common.share'), exact: true }).click();
      await dialog.getByText(ctx.t('error.sharingOffline'), { exact: true }).nth(1).waitFor();
    },
  },
  'share-collection-sheet-links-offline': {
    persona: 'member',
    path: baking,
    reach: async (page, ctx) => {
      await page.context().setOffline(true);
      await openShare(page, ctx);
      await clickButton(page, ctx.t('share.byLink'));
      await page.getByRole('dialog').getByText(ctx.t('error.sharingOffline'), { exact: true }).waitFor();
    },
  },
  'share-collection-sheet-link-minted': {
    persona: 'member',
    path: baking,
    // The link is mocked: a fixed URL, and nothing left live in the emulator.
    mocks: ['collectionLink', 'clipboardWorks'],
    reach: async (page, ctx) => {
      await openShare(page, ctx);
      await clickButton(page, ctx.t('share.byLink'));
      await clickButton(page, ctx.t('share.copyLink'));
      await page.getByRole('dialog').locator('input[readonly]').waitFor();
    },
  },
  'import-from-collection': { persona: 'member', path: (ctx) => `${weeknights(ctx)}/import` },
  'import-destination-sheet': {
    persona: 'member',
    path: '/import',
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('import.chooseDestination'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'save-to-collection-sheet': {
    persona: 'member',
    path: '/import',
    mocks: ['importClean'],
    reach: async (page, ctx) => {
      await extractClean(page, ctx);
      await clickButton(page, ctx.t('common.save'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'sync-toast': {
    persona: 'member',
    path: '/settings',
    pauseClock: true,
    reach: async (page, ctx) => {
      // Only the Refresh fails; the page loaded normally.
      await page.route('**/api/sync/pull**', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
      );
      await clickButton(page, ctx.t('common.refresh'));
      await page.getByText(ctx.t('sync.refreshFailed'), { exact: true }).waitFor();
    },
  },
  'library-shared-banner': { persona: 'viewer', path: weeknights },
  'library-leave-sheet': {
    persona: 'viewer',
    path: weeknights,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('library.leave'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'recipe-edit-shared-editor': { persona: 'viewer', path: (ctx) => `/recipe/${ctx.ids.owner.shakshuka}/edit` },
  'recipe-view-shared': { persona: 'viewer', path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}` },
  'recipe-view-shared-editor': { persona: 'viewer', path: (ctx) => `/recipe/${ctx.ids.owner.shakshuka}` },
  'recipe-chat-shared': {
    persona: 'viewer',
    // Member's recipe through Weeknights (viewer); the seed left a proposal on it.
    path: (ctx) => `/recipe/${ctx.ids.member.tomatoPasta}`,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('recipe.ask'));
      await page.getByRole('button', { name: ctx.t('chat.saveAsNewRecipe'), exact: true }).waitFor();
    },
  },
  'recipe-chat-shared-editor': {
    persona: 'viewer',
    // Owner's recipe through Owner's picks (editor); the seed left a proposal on it.
    path: (ctx) => `/recipe/${ctx.ids.owner.shakshuka}`,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('recipe.ask'));
      await page.getByRole('button', { name: ctx.t('chat.apply'), exact: true }).waitFor();
    },
  },
  'cooks-empty': { persona: 'empty', path: '/cooks' },
  'cooks-populated': { persona: 'member', path: '/cooks' },
  'cook-log-new': { persona: 'member', path: (ctx) => `/recipe/${ctx.ids.member.roastChicken}/cooks/new` },
  'cook-log-edit-delete': {
    persona: 'member',
    path: (ctx) => `/recipe/${ctx.ids.member.roastChicken}/cooks/${ctx.ids.member.cookLogRecent}/edit`,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('cookLog.deleteCook'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'assistant-signed-out': { persona: 'signedOut', path: '/assistant' },
  'assistant-empty': { persona: 'member', path: '/assistant' },
  'assistant-stopped': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentStreaming'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'What can I cook tonight?');
      await clickButton(page, ctx.t('assistant.stop'));
      // Inside the reply's bubble, after its text.
      await page.getByText(new RegExp(`${escapeRegExp(ctx.t('assistant.stopped'))}$`)).waitFor();
    },
  },
  'assistant-llm-budget': {
    persona: 'member',
    path: '/assistant',
    mocks: ['llmBudgetExceeded'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'What can I cook tonight?');
      await page.getByText(ctx.t('error.llmBudgetExceeded')).first().waitFor();
    },
  },
  'assistant-shopping-list': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentShoppingList'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'Make a shopping list for the pasta and the roast chicken.');
      await page.getByText('Shopping list', { exact: true }).waitFor();
      await page.getByRole('button', { name: ctx.t('assistant.send'), exact: true }).waitFor();
    },
  },
  'assistant-collection-move': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentMove'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'Move a couple of recipes into Weeknights.');
      await page.getByRole('button', { name: ctx.t('assistant.move'), exact: true }).waitFor();
    },
  },
  'assistant-collection-move-applied': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentMove', 'pushAccepted'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'Move a couple of recipes into Weeknights.');
      await clickButton(page, ctx.t('assistant.move'));
      await page.getByText(ctx.p('assistant.moveAppliedToCollection')).waitFor();
    },
  },
  'assistant-collection-create': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentCreate'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'Make a Desserts collection for the sweet things.');
      await page.getByRole('button', { name: ctx.t('assistant.create'), exact: true }).waitFor();
    },
  },
  'assistant-collection-create-applied': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentCreate', 'pushAccepted'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'Make a Desserts collection for the sweet things.');
      await clickButton(page, ctx.t('assistant.create'));
      await page.getByText(ctx.p('assistant.createApplied')).waitFor();
    },
  },
  'assistant-collection-create-error': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentCreate', 'pushFails'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'Make a Desserts collection for the sweet things.');
      await clickButton(page, ctx.t('assistant.create'));
      await page.getByText(ctx.t('error.collectionSave'), { exact: true }).waitFor();
    },
  },
  'assistant-collection-move-error': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentMove', 'pushFails'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'Move a couple of recipes into Weeknights.');
      await clickButton(page, ctx.t('assistant.move'));
      await page.getByText(ctx.t('error.collectionSave'), { exact: true }).waitFor();
    },
  },
  'assistant-couldnt-answer': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentUnavailable'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'What can I cook tonight?');
      await page.getByText(ctx.t('assistant.couldntAnswer'), { exact: true }).waitFor();
    },
  },
  'assistant-tool-chip': {
    persona: 'member',
    path: '/assistant',
    mocks: ['agentSearching'],
    reach: async (page, ctx) => {
      await ask(page, ctx, 'What can I cook tonight?');
      await page.getByText(ctx.t('assistant.searching'), { exact: true }).waitFor();
    },
  },
  'share-collection-sheet-public': {
    persona: 'member',
    path: weeknights,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await clickButton(page, ctx.t('share.byPublic'));
      await page.getByText(ctx.t('share.publicLinkLabel'), { exact: true }).waitFor();
    },
  },
  'public-collection': { persona: 'signedOut', path: (ctx) => `/p/${ctx.publicToken}` },
  'public-collection-locked-sheet': {
    persona: 'signedOut',
    path: (ctx) => `/p/${ctx.publicToken}`,
    reach: async (page) => {
      // The locked chat bubble is aria-disabled by design but opens the sheet;
      // Playwright treats aria-disabled as not clickable, so force the click.
      await page.locator('button[aria-disabled="true"]').first().click({ force: true });
      await page.getByRole('dialog').waitFor();
    },
  },
  'public-collection-member': { persona: 'empty', path: (ctx) => `/p/${ctx.publicToken}` },
  'public-recipe': { persona: 'signedOut', path: (ctx) => `/p/${ctx.publicToken}/r/${ctx.ids.member.borscht}` },
  'public-link-missing': { persona: 'signedOut', path: `/p/${'a'.repeat(43)}` },
  'share-recipe-sheet': {
    persona: 'member',
    path: (ctx) => `/recipe/${ctx.ids.member.overnightOats}`,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await page.getByRole('dialog').waitFor();
    },
  },
  'share-recipe-sheet-link': {
    persona: 'member',
    path: (ctx) => `/recipe/${ctx.ids.member.overnightOats}`,
    reach: async (page, ctx) => {
      await clickButton(page, ctx.t('common.share'));
      await clickButton(page, ctx.t('shareRecipe.byLink'));
      await page.getByText(ctx.t('shareRecipe.linkLabel'), { exact: true }).waitFor();
    },
  },
  'public-shared-recipe': { persona: 'signedOut', path: (ctx) => `/p/${ctx.publicRecipeToken}` },
  'public-shared-recipe-member': { persona: 'empty', path: (ctx) => `/p/${ctx.publicRecipeToken}` },
  'public-shared-recipe-locked-sheet': {
    persona: 'empty',
    path: (ctx) => `/p/${ctx.publicRecipeToken}`,
    reach: async (page) => {
      // aria-disabled by design, as on the collection page; force the click.
      await page.locator('button[aria-disabled="true"]').last().click({ force: true });
      await page.getByRole('dialog').waitFor();
    },
  },
  'recipe-saved-from': { persona: 'capped', path: (ctx) => `/recipe/${ctx.savedCopyId}` },
};
