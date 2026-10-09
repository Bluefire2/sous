/**
 * Responses for model-backed routes and for outcomes a review must not cause
 * for real, served through Playwright so captures are deterministic and the
 * test server needs no Gemini key (docs/plans/i18n-review-ci.md, Decisions).
 * Each mock answers the same way every time. Shapes follow the client parsers
 * they feed (`src/lib/importApi.ts`, `translateApi.ts`, `inviteApi.ts`,
 * `remote.ts`, `src/agent/api.ts` and `cards/parse.ts`): a mock the parser
 * rejects shows an error, and the state's `reach`, which waits for the text it
 * expects, fails the capture.
 */
import type { BrowserContext, Route } from 'playwright';
import type { CollectionCreateData, CollectionMoveData, ShoppingListData } from '../../src/agent/cards/parse.ts';
import type { RecipeDraft } from '../../src/lib/types.ts';
import { FIXTURE_IDS, memberLibrary } from '../fixtures.ts';
import type { Lang } from './catalog.ts';

export interface MockEnv {
  /** The browser's frozen time, so mocked dates read the same every run. */
  now: number;
  baseUrl: string;
  /** The UI language being captured. */
  lang: Lang;
}

type Mock = (context: BrowserContext, env: MockEnv) => Promise<void>;

const DAY = 24 * 60 * 60 * 1000;

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** The body the page posted, or an empty object. */
function posted(route: Route): Record<string, unknown> {
  try {
    return (route.request().postDataJSON() as Record<string, unknown> | null) ?? {};
  } catch {
    return {};
  }
}

const PEA_SOUP = {
  title: 'Spring pea soup',
  servings: 4,
  prepMinutes: 10,
  cookMinutes: 20,
  tags: ['soup'],
  ingredientSections: [
    {
      items: [
        { quantity: 500, unit: 'g', item: 'frozen peas' },
        { quantity: 1, item: 'onion', note: 'chopped' },
        { quantity: 750, unit: 'ml', item: 'vegetable stock' },
      ],
    },
  ],
  steps: [
    { text: 'Soften the onion in a little butter.' },
    { text: 'Add the peas and stock and simmer for 5 minutes.' },
    { text: 'Blend until smooth and season.' },
  ],
} satisfies RecipeDraft;

/** Ingredients and no method: the import check's MISSING_INSTRUCTIONS. */
const TOMATO_SOUP_NO_STEPS = {
  title: 'Tomato soup',
  servings: 2,
  tags: [],
  ingredientSections: [
    { items: [{ quantity: 6, item: 'tomatoes' }, { quantity: 1, item: 'onion' }, { item: 'salt' }] },
  ],
  steps: [],
} satisfies RecipeDraft;

type ImportOutcome = { status: number; body: unknown };

/**
 * `POST /api/import` as the server answers it. `lang` is the extraction's
 * language: `'ui'` means the language the page asked to translate into, so
 * the preview shows no translate checkbox. A language other than the
 * target comes back with a translation, as the server translates at import;
 * recipe text is not judged, so the translation reuses the original's text.
 */
function importOutcome(
  request: Record<string, unknown>,
  options: { lang: string | 'ui'; recipe?: RecipeDraft; warnings?: unknown[]; translationFailed?: true },
): ImportOutcome {
  const target = typeof request.translateTo === 'string' ? request.translateTo : undefined;
  const lang = options.lang === 'ui' ? (target ?? 'en') : options.lang;
  const base = options.recipe ?? PEA_SOUP;
  const recipe = { ...base, lang, ...(typeof request.url === 'string' ? { sourceUrl: request.url } : {}) };
  const body: Record<string, unknown> = { recipe };
  if (options.warnings !== undefined) body.warnings = options.warnings;
  if (target !== undefined && target !== lang) {
    if (options.translationFailed) {
      body.translationFailed = true;
    } else {
      body.translation = { lang: target, recipe: { ...base, lang: target } };
    }
  }
  return { status: 200, body };
}

function importMock(answer: (request: Record<string, unknown>) => ImportOutcome): Mock {
  return async (context) => {
    await context.route('**/api/import', (route) => {
      const { status, body } = answer(posted(route));
      return json(route, status, body);
    });
  };
}

const MISSING_INSTRUCTIONS = [{ code: 'MISSING_INSTRUCTIONS' }];
const NO_RECIPE = { status: 422, body: { error: 'No recipe found on that page.', code: 'import-no-recipe' } };

/** `POST /api/translate` for a saved recipe: the same text back, with a detected language. */
function translateMock(detected: (request: Record<string, unknown>) => string): Mock {
  return async (context) => {
    await context.route('**/api/translate', (route) => {
      const request = posted(route);
      return json(route, 200, { recipe: request.recipe, detectedLang: detected(request) });
    });
  };
}

const INVITE_URL_PATH = `/invite/${'i'.repeat(43)}`;

/**
 * `/api/agent` streams NDJSON events. Playwright's `route.fulfill` sends a
 * whole body at once, and the in-progress states need a stream that stays
 * open, so this patches `fetch` in the page instead. A held stream ends only
 * when the page aborts it (Stop).
 */
function agentStream(events: (lang: Lang) => unknown[], hold = false): Mock {
  return async (context, env) => {
    await context.addInitScript({
      content: `(() => {
        const events = ${JSON.stringify(events(env.lang))};
        const hold = ${hold};
        const realFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (!new URL(url, location.href).pathname.endsWith('/api/agent')) return realFetch(input, init);
          const signal = init && init.signal;
          if (signal && signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              for (const event of events) controller.enqueue(encoder.encode(JSON.stringify(event) + '\\n'));
              if (!hold) controller.close();
              if (signal) signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
            },
          });
          return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
        };
      })();`,
    });
  };
}

const member = memberLibrary(0);
const titleOf = (id: string) => member.recipes.find((r) => r.id === id)?.title ?? id;
/** Where a member recipe is filed, as a card's `from` names it. */
function fromOf(id: string): { kind: 'collection'; name: string } | { kind: 'unfiled' } {
  const collection = member.collections.find((c) => c.recipeIds.includes(id));
  return collection === undefined ? { kind: 'unfiled' } : { kind: 'collection', name: collection.name };
}
function cardRows(ids: string[]) {
  return {
    recipeIds: ids,
    sources: ids.map((id) => ({ id, from: fromOf(id) })),
    preview: ids.map((id) => ({ id, title: titleOf(id), from: fromOf(id) })),
    total: ids.length,
  };
}

const weeknights = member.collections.find((c) => c.id === FIXTURE_IDS.member.weeknights)!;
/** Two member recipes not already in Weeknights, so the move moves both. */
const toMove = member.recipes.map((r) => r.id).filter((id) => !weeknights.recipeIds.includes(id)).slice(0, 2);
const toFile = [FIXTURE_IDS.member.eggTarts, FIXTURE_IDS.member.bananaBread];

const MOVE_CARD = {
  type: 'collection_move',
  v: 1,
  id: 'card-move',
  data: {
    destination: { kind: 'collection', id: weeknights.id, name: weeknights.name },
    ...cardRows(toMove),
  } satisfies CollectionMoveData,
};
const CREATE_CARD = {
  type: 'collection_create',
  v: 1,
  id: 'card-create',
  data: { name: 'Desserts', ...cardRows(toFile) } satisfies CollectionCreateData,
};
const pasta = member.recipes.find((r) => r.id === FIXTURE_IDS.member.tomatoPasta)!;
const chicken = member.recipes.find((r) => r.id === FIXTURE_IDS.member.roastChicken)!;
const SHOPPING_CARD = {
  type: 'shopping_list',
  v: 1,
  id: 'card-shopping',
  data: {
    title: 'Shopping list',
    recipes: [
      { id: pasta.id, title: pasta.title, servings: pasta.servings },
      { id: chicken.id, title: chicken.title, servings: chicken.servings },
    ],
    sections: [
      {
        name: 'Produce',
        items: [
          { key: 'garlic', item: 'garlic', quantity: 1, unit: 'head', recipeIds: [pasta.id, chicken.id] },
          { key: 'lemon', item: 'lemon', quantity: 1, recipeIds: [chicken.id] },
          { key: 'basil', item: 'basil leaves', recipeIds: [pasta.id] },
        ],
      },
      {
        name: 'Pantry',
        items: [
          { key: 'spaghetti', item: 'spaghetti', quantity: 200, unit: 'g', recipeIds: [pasta.id] },
          { key: 'tomatoes', item: 'tinned chopped tomatoes', quantity: 400, unit: 'g', recipeIds: [pasta.id] },
        ],
      },
    ],
  } satisfies ShoppingListData,
};
/**
 * The model answers in the person's language, so its replies are written in
 * each one: an English reply on a Ukrainian screen reads as app text left in
 * English. Card contents stay in English; the judge treats them as the
 * model's words either way.
 */
const REPLIES: Record<'list' | 'move' | 'create' | 'partial', Record<Lang, string>> = {
  list: {
    en: 'Here is one list for both recipes.',
    uk: 'Ось один список для обох рецептів.',
    ru: 'Вот один список для обоих рецептов.',
    'zh-Hans': '这是两个食谱合在一起的购物清单。',
  },
  move: {
    en: 'I can move these two into Weeknights.',
    uk: 'Можу перемістити ці два до Weeknights.',
    ru: 'Могу переместить эти два в Weeknights.',
    'zh-Hans': '我可以把这两个移到 Weeknights。',
  },
  create: {
    en: 'I can file these two in a new collection.',
    uk: 'Можу додати ці два до нової колекції.',
    ru: 'Могу добавить эти два в новую коллекцию.',
    'zh-Hans': '我可以把这两个放进一个新合集。',
  },
  partial: {
    en: 'You could make the tomato pasta tonight, or',
    uk: 'Сьогодні можна приготувати пасту з томатами або',
    ru: 'Сегодня можно приготовить пасту с томатами или',
    'zh-Hans': '今晚可以做番茄意面，或者',
  },
};

const answered =
  (reply: keyof typeof REPLIES, ...cards: unknown[]) =>
  (lang: Lang) => [
    { t: 'tool', name: 'search_recipes', phase: 'start' },
    { t: 'tool', name: 'search_recipes', phase: 'end', ok: true },
    { t: 'text', step: 1, d: REPLIES[reply][lang] },
    ...cards.map((card) => ({ t: 'card', card })),
    { t: 'done' },
  ];

export const MOCKS = {
  /** A clean import in the UI language: no warnings, no translate checkbox. */
  importClean: importMock((request) => importOutcome(request, { lang: 'ui' })),
  /** An English recipe: "Looks like English", with a translation when the UI is not English. */
  importEnglish: importMock((request) => importOutcome(request, { lang: 'en' })),
  /** An Italian recipe, translated into the UI language at import. */
  importItalian: importMock((request) => importOutcome(request, { lang: 'it' })),
  /** An Italian recipe whose translation failed. */
  importTranslateFailed: importMock((request) => importOutcome(request, { lang: 'it', translationFailed: true })),
  /** Ingredients and no method, so the import check warns. */
  importWarnings: importMock((request) =>
    importOutcome(request, { lang: 'ui', recipe: TOMATO_SOUP_NO_STEPS, warnings: MISSING_INSTRUCTIONS }),
  ),
  /** The model call failed: 502 `import-model-failed`. */
  importModelFailed: importMock(() => ({
    status: 502,
    body: { error: "Couldn't read that recipe — try again.", code: 'import-model-failed' },
  })),
  /** No recipe on the page: 422 `import-no-recipe`. */
  importNoRecipe: importMock(() => NO_RECIPE),
  /** A recipe generated from a brief with Search the web on: clean, in the UI language, with three grounding sources, one untitled. */
  importGenerated: importMock((request) => {
    const outcome = importOutcome(request, { lang: 'ui' });
    return {
      ...outcome,
      body: {
        ...(outcome.body as Record<string, unknown>),
        grounding: {
          sources: [
            { title: 'Spring pea soup, the classic way', url: 'https://example.com/spring-pea-soup' },
            { title: 'Pea soup in a pressure cooker', url: 'https://example.org/pressure-cooker-pea-soup' },
            { title: '', url: 'https://example.net/pea-soup-notes' },
          ],
        },
      },
    };
  }),
  /** The brief was not about food: 422 `import-no-recipe-brief`. */
  importBriefNoRecipe: importMock(() => ({
    status: 422,
    body: { error: "Couldn't make a recipe from that — describe a dish.", code: 'import-no-recipe-brief' },
  })),
  /** The brief was over the cap: 400 `import-brief-too-long` (the textarea caps it; a mode switch can carry longer text). */
  importBriefTooLong: importMock(() => ({
    status: 400,
    body: { error: "That's too long — keep the idea under 2,000 characters.", code: 'import-brief-too-long' },
  })),
  /** Too many searched generations this hour: 429 `import-search-rate-limited`. */
  importSearchRateLimited: importMock(() => ({
    status: 429,
    body: { error: 'Too many web searches. Try again later, or turn Search the web off.', code: 'import-search-rate-limited' },
  })),
  /** Today's AI budget is used up: 429 `llm-budget-exceeded` from import and the assistant (server/llmBudget.ts). */
  llmBudgetExceeded: async (context) => {
    const refusal = {
      error: "You've reached today's limit. It resets at midnight UTC.",
      code: 'llm-budget-exceeded',
    };
    for (const path of ['**/api/import', '**/api/agent']) {
      await context.route(path, (route) => json(route, 429, refusal));
    }
  },
  /** Generation failed (a thrown call, or output that was not a usable recipe): 502 `import-generate-failed`. */
  importGenerateFailed: importMock(() => ({
    status: 502,
    body: { error: "Couldn't generate that recipe — try again.", code: 'import-generate-failed' },
  })),
  /** `POST /api/import` never answers: the Generating… state stays on screen. */
  importHangs: async (context) => {
    await context.route('**/api/import', () => new Promise<void>(() => {}));
  },
  /** Bulk rows by URL: `…/check` warns, `…/broken` fails, anything else is clean. */
  importBulk: importMock((request) => {
    const url = typeof request.url === 'string' ? request.url : '';
    if (url.endsWith('/broken')) return NO_RECIPE;
    if (url.endsWith('/check')) {
      return importOutcome(request, { lang: 'ui', recipe: TOMATO_SOUP_NO_STEPS, warnings: MISSING_INSTRUCTIONS });
    }
    return importOutcome(request, { lang: 'ui' });
  }),

  /** `POST /api/translate` never answers: the chip stays loading. */
  translateHangs: async (context) => {
    await context.route('**/api/translate', () => new Promise<void>(() => {}));
  },
  translateFails: async (context) => {
    await context.route('**/api/translate', (route) =>
      json(route, 502, { error: "Couldn't translate this recipe.", code: 'translate-failed' }),
    );
  },
  /** Translated; the detection matches the recipe's label. */
  translateOk: translateMock((request) => {
    const recipe = request.recipe as { lang?: unknown } | undefined;
    return typeof recipe?.lang === 'string' ? recipe.lang : 'it';
  }),
  /** The text turns out to be in the UI language already. */
  translateAlready: translateMock((request) => String(request.target)),
  /** Detects Russian, which no fixture recipe is labelled, so the edit form hints at it. */
  translateDetectsRussian: translateMock(() => 'ru'),

  /** `POST /api/invites` makes a link with a fixed token. */
  inviteCreated: async (context, env) => {
    await context.route('**/api/invites', (route) => json(route, 200, { url: `${env.baseUrl}${INVITE_URL_PATH}` }));
  },
  /** A member who has admitted their five people: 409 `member-invite-limit`. */
  inviteLimit: async (context) => {
    await context.route('**/api/invites', (route) =>
      json(route, 409, { error: 'You have already invited 5 people.', code: 'member-invite-limit', max: 5 }),
    );
  },
  clipboardWorks: async (context, env) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.baseUrl });
  },
  /** Every clipboard write is refused. */
  clipboardFails: async (context) => {
    await context.addInitScript({
      content: `(() => {
        const refuse = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
        Object.defineProperty(navigator, 'clipboard', { value: { write: refuse, writeText: refuse, readText: refuse } });
      })();`,
    });
  },
  /** `Math.random` always returns 0, so a random-recipe roll picks the same recipe on every capture. */
  randomFirst: async (context) => {
    await context.addInitScript({ content: 'Math.random = () => 0;' });
  },
  /**
   * No system share sheet, as in most desktop browsers, so a recipe's Share
   * copies instead. Headless Chromium has one on some platforms; a real one
   * would open a native dialog the capture cannot see.
   */
  shareUnavailable: async (context) => {
    await context.addInitScript({
      content: `(() => {
        for (const name of ['share', 'canShare']) {
          Object.defineProperty(navigator, name, { value: undefined, configurable: true });
        }
      })();`,
    });
  },

  /**
   * A suggestion is accepted (204, as the server answers). Not sent for real:
   * the server rate-limits suggestions per member, and a run sends one per
   * language and repeat.
   */
  suggestionAccepted: async (context) => {
    await context.route('**/api/feature-request', (route) => route.fulfill({ status: 204 }));
  },
  /** Disconnecting a connected app fails. */
  disconnectFails: async (context) => {
    await context.route('**/api/mcp/grants/revoke', (route) => json(route, 500, { error: 'Internal error' }));
  },
  /** Library writes succeed without reaching the emulator, so other captures still see the seed. */
  pushAccepted: async (context) => {
    await context.route('**/api/sync/push', (route) => json(route, 200, { results: [] }));
  },
  pushFails: async (context) => {
    await context.route('**/api/sync/push', (route) => json(route, 500, { error: 'Internal error' }));
  },
  /**
   * The persona's library plus 25 older recipes, added to the first pull page
   * and never written, so the list runs past one page and shows Show more.
   */
  longLibrary: async (context, env) => {
    await context.route('**/api/sync/pull?*', async (route) => {
      const response = await route.fetch();
      if (new URL(route.request().url()).searchParams.has('cursor') || !response.ok()) {
        await route.fulfill({ response });
        return;
      }
      const body = (await response.json()) as { changes: { recipes: unknown[] } };
      for (let i = 1; i <= 25; i += 1) {
        const at = env.now - (60 + i) * DAY;
        body.changes.recipes.push({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          title: `Pantry supper ${i}`,
          servings: 2,
          ingredientSections: [],
          steps: [],
          tags: [],
          createdAt: at,
          updatedAt: at,
        });
      }
      await json(route, 200, body);
    });
  },

  /** A collection's live links: none, then one fixed link after Copy link. */
  collectionLink: async (context, env) => {
    const row = { id: 'link-1', role: 'viewer', createdAt: env.now, expiresAt: env.now + 7 * DAY };
    await context.route('**/api/collections/*/links', (route) =>
      route.request().method() === 'POST'
        ? json(route, 200, { url: `${env.baseUrl}/c/${'c'.repeat(43)}`, id: row.id, links: [row] })
        : json(route, 200, { links: [] }),
    );
  },

  agentShoppingList: agentStream(answered('list', SHOPPING_CARD)),
  agentMove: agentStream(answered('move', MOVE_CARD)),
  agentCreate: agentStream(answered('create', CREATE_CARD)),
  /** As the server ends a run it gave up on: the error, then done. */
  agentUnavailable: agentStream(() => [
    { t: 'error', message: "The assistant couldn't answer that.", code: 'assistant_unavailable' },
    { t: 'done' },
  ]),
  /** A reply that has started a tool call and has not finished. */
  agentSearching: agentStream(() => [{ t: 'tool', name: 'search_recipes', phase: 'start' }], true),
  /** A reply part-way through its text, held open until Stop. */
  agentStreaming: agentStream((lang) => [{ t: 'text', step: 1, d: REPLIES.partial[lang] }], true),
} satisfies Record<string, Mock>;

export type MockName = keyof typeof MOCKS;
