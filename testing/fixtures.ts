/**
 * Seed data for test mode (docs/plans/test-mode.md, Personas and seed data).
 * Recipes are written for this file. Ids are fixed so a test can open
 * `/recipe/<id>` by a constant. Timestamps are relative to the seed run, so
 * relative-time labels read the same on every run.
 */
import type { ChatMessage, CookLog, CookStateRow, Collection, Recipe, RecipeDraft } from '../src/lib/types.ts';

const DAY = 24 * 60 * 60 * 1000;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
}

export const FIXTURE_IDS = {
  member: {
    roastChicken: uuid(101),
    tomatoPasta: uuid(102),
    borscht: uuid(103),
    overnightOats: uuid(104),
    eggTarts: uuid(105),
    bananaBread: uuid(106),
    /** An unfiled variant of Lemon garlic roast chicken (`variantOf`). */
    herbRoastChicken: uuid(107),
    weeknights: uuid(151),
    baking: uuid(152),
    cookLogRecent: uuid(171),
    cookLogOlder: uuid(172),
    chatQuestion: uuid(181),
    chatAnswer: uuid(182),
  },
  owner: {
    shakshuka: uuid(201),
    misoSoup: uuid(202),
    picks: uuid(251),
  },
  viewer: {
    pancakes: uuid(301),
    /** Ask on member's Quick tomato pasta, seen through Weeknights (viewer). */
    pastaQuestion: uuid(381),
    pastaProposal: uuid(382),
    /** Ask on owner's Shakshuka, through Owner's picks (editor). */
    shakshukaQuestion: uuid(383),
    shakshukaProposal: uuid(384),
  },
} as const;

type RecipeBody = Omit<Recipe, 'id' | 'createdAt' | 'updatedAt'>;

function recipe(id: string, ageDays: number, now: number, body: RecipeBody): Recipe {
  return { id, createdAt: now - ageDays * DAY, updatedAt: now - ageDays * DAY + 60_000, ...body };
}

function collection(id: string, name: string, recipeIds: string[], ageDays: number, now: number): Collection {
  return { id, name, recipeIds, createdAt: now - ageDays * DAY, updatedAt: now - ageDays * DAY + 60_000 };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface PersonaLibrary {
  recipes: Recipe[];
  collections: Collection[];
  /** `cookState.put` payloads: the row plus its write clock. */
  cookStates: (CookStateRow & { updatedAt: number })[];
  cookLogs: CookLog[];
  chat: ChatMessage[];
}

export function memberLibrary(now: number): PersonaLibrary {
  const ids = FIXTURE_IDS.member;
  const roastChicken = recipe(ids.roastChicken, 20, now, {
    title: 'Lemon garlic roast chicken',
    description: 'A whole chicken roasted over potatoes, with lemon and garlic in the pan.',
    servings: 4,
    prepMinutes: 15,
    cookMinutes: 75,
    lang: 'en',
    tags: ['dinner', 'weekend'],
    // In US units, so Measurements: Metric has something to convert (docs/plans/measurement-units.md).
    ingredientSections: [
      {
        items: [
          { quantity: 1, item: 'whole chicken', note: 'about 3½ lb' },
          { quantity: 1.75, unit: 'lb', item: 'waxy potatoes', note: 'halved' },
          { quantity: 1, item: 'lemon' },
          { quantity: 6, item: 'garlic cloves', note: 'unpeeled' },
          { quantity: 2, unit: 'tbsp', item: 'olive oil' },
          { item: 'salt and black pepper' },
        ],
      },
    ],
    steps: [
      { text: 'Heat the oven to 400°F. Pat the chicken dry and season it well inside and out.' },
      { text: 'Toss the potatoes and garlic with the oil and spread them in a roasting tin.' },
      { text: 'Halve the lemon, squeeze it over the chicken, and put the halves inside the bird.' },
      { text: 'Roast the chicken on the potatoes for 70 to 80 minutes, until the juices run clear.' },
      { text: 'Rest for 10 minutes before carving. Squeeze the roasted garlic over the potatoes.' },
    ],
    notes: 'Dry the skin the night before for the crispest result.',
  });
  const herbRoastChicken = recipe(ids.herbRoastChicken, 5, now, {
    title: 'Herb roast chicken',
    description: 'The roast chicken with thyme and rosemary butter under the skin instead of lemon.',
    servings: 4,
    prepMinutes: 20,
    cookMinutes: 75,
    lang: 'en',
    tags: ['dinner', 'weekend'],
    variantOf: ids.roastChicken,
    ingredientSections: [
      {
        items: [
          { quantity: 1, item: 'whole chicken', note: 'about 1.6 kg' },
          { quantity: 800, unit: 'g', item: 'waxy potatoes', note: 'halved' },
          { quantity: 50, unit: 'g', item: 'soft butter' },
          { quantity: 1, unit: 'tbsp', item: 'thyme leaves' },
          { quantity: 1, unit: 'tbsp', item: 'rosemary', note: 'finely chopped' },
          { quantity: 6, item: 'garlic cloves', note: 'unpeeled' },
          { item: 'salt and black pepper' },
        ],
      },
    ],
    steps: [
      { text: 'Heat the oven to 200 °C. Mash the butter with the herbs and a pinch of salt.' },
      { text: 'Loosen the breast skin and push the herb butter underneath. Season the chicken.' },
      { text: 'Spread the potatoes and garlic in a roasting tin and set the chicken on top.' },
      { text: 'Roast for 70 to 80 minutes, until the juices run clear.' },
      { text: 'Rest for 10 minutes before carving.' },
    ],
  });
  const tomatoPasta = recipe(ids.tomatoPasta, 12, now, {
    title: 'Quick tomato pasta',
    servings: 2,
    lang: 'en',
    tags: ['quick'],
    ingredientSections: [
      {
        items: [
          { quantity: 200, unit: 'g', item: 'spaghetti' },
          { quantity: 400, unit: 'g', item: 'tinned chopped tomatoes' },
          { quantity: 2, item: 'garlic cloves', note: 'sliced' },
          { quantity: 2, unit: 'tbsp', item: 'olive oil' },
          { item: 'basil leaves', optional: true },
        ],
      },
    ],
    steps: [
      { text: 'Cook the spaghetti in well-salted water.' },
      { text: 'Meanwhile, soften the garlic in the oil, add the tomatoes, and simmer for 10 minutes.' },
      { text: 'Toss the drained pasta with the sauce and the basil.' },
    ],
  });
  const borscht = recipe(ids.borscht, 9, now, {
    title: 'Борщ',
    description: 'Класичний борщ на яловичому бульйоні.',
    servings: 6,
    prepMinutes: 30,
    cookMinutes: 120,
    lang: 'uk',
    tags: ['суп'],
    ingredientSections: [
      {
        name: 'Бульйон',
        items: [
          { quantity: 600, unit: 'g', item: 'яловичина на кістці' },
          { quantity: 3, unit: 'l', item: 'вода' },
        ],
      },
      {
        name: 'Овочі',
        items: [
          { quantity: 2, item: 'буряк' },
          { quantity: 1, item: 'морква' },
          { quantity: 1, item: 'цибуля' },
          { quantity: 3, item: 'картопля' },
          { quantity: 300, unit: 'g', item: 'капуста' },
          { quantity: 2, unit: 'tbsp', item: 'томатна паста' },
        ],
      },
    ],
    steps: [
      { text: "Залийте м'ясо водою, доведіть до кипіння і варіть 1,5 години, знімаючи піну." },
      { text: 'Наріжте буряк соломкою і тушкуйте з томатною пастою 15 хвилин.' },
      { text: 'Обсмажте цибулю і моркву.' },
      { text: 'Додайте до бульйону картоплю, потім капусту, буряк і засмажку. Варіть до готовності.' },
    ],
    notes: 'Подавайте зі сметаною і пампушками.',
  });
  const overnightOats = recipe(ids.overnightOats, 5, now, {
    title: 'Overnight oats',
    servings: 1,
    tags: ['breakfast'],
    ingredientSections: [
      {
        items: [
          { quantity: 50, unit: 'g', item: 'rolled oats' },
          { quantity: 120, unit: 'ml', item: 'milk' },
          { quantity: 2, unit: 'tbsp', item: 'yogurt' },
          { quantity: 1, unit: 'tsp', item: 'honey' },
        ],
      },
    ],
    steps: [
      { text: 'Stir everything together in a jar.' },
      { text: 'Cover and chill overnight. Top with fruit in the morning.' },
    ],
  });
  const eggTarts = recipe(ids.eggTarts, 3, now, {
    title: '蛋挞',
    servings: 12,
    prepMinutes: 20,
    cookMinutes: 25,
    lang: 'zh-Hans',
    tags: ['甜点'],
    ingredientSections: [
      {
        items: [
          { quantity: 12, item: '蛋挞皮' },
          { quantity: 3, item: '蛋黄' },
          { quantity: 150, unit: 'ml', item: '牛奶' },
          { quantity: 100, unit: 'ml', item: '淡奶油' },
          { quantity: 40, unit: 'g', item: '细砂糖' },
        ],
      },
    ],
    steps: [
      { text: '烤箱预热至 200 °C。' },
      { text: '牛奶、淡奶油和糖加热至糖溶化，稍凉后加入蛋黄拌匀，过筛。' },
      { text: '将蛋液倒入蛋挞皮，约八分满。' },
      { text: '烤 20 至 25 分钟，至表面出现焦斑。' },
    ],
  });
  const bananaBread = recipe(ids.bananaBread, 1, now, {
    title: 'Banana bread',
    servings: 8,
    cookMinutes: 60,
    lang: 'en',
    // Imported from a page, so the warning box offers Retry import and View original.
    sourceUrl: 'https://example.com/banana-bread',
    tags: ['baking'],
    ingredientSections: [
      {
        items: [
          { quantity: 3, item: 'ripe bananas', note: 'mashed' },
          { quantity: 75, unit: 'g', item: 'melted butter' },
          { quantity: 150, unit: 'g', item: 'brown sugar' },
          { quantity: 1, item: 'egg' },
          { quantity: 190, unit: 'g', item: 'plain flour' },
          { quantity: 1, unit: 'tsp', item: 'baking soda' },
        ],
      },
    ],
    steps: [{ text: 'Mix everything and bake in a loaf tin at 175 °C for about an hour.' }],
    importCheck: {
      at: now - DAY,
      warnings: [{ code: 'TOO_FEW_STEPS' }, { code: 'UNGROUNDED_INGREDIENT', at: [0, 5] }],
    },
  });

  const cookedRecently = now - 3 * DAY;
  const cookedEarlier = now - 17 * DAY;
  return {
    recipes: [roastChicken, tomatoPasta, borscht, overnightOats, eggTarts, bananaBread, herbRoastChicken],
    collections: [
      collection(ids.weeknights, 'Weeknights', [roastChicken.id, tomatoPasta.id, borscht.id], 8, now),
      collection(ids.baking, 'Baking', [eggTarts.id, bananaBread.id], 2, now),
    ],
    cookStates: [
      {
        recipeId: roastChicken.id,
        servings: 4,
        currentStep: 1,
        checkedKeys: ['0-0', '0-1'],
        recipeUpdatedAt: roastChicken.updatedAt,
        updatedAt: now - 60 * 60 * 1000,
      },
    ],
    cookLogs: [
      {
        id: ids.cookLogRecent,
        recipeId: roastChicken.id,
        cookedOn: isoDay(cookedRecently),
        rating: 5,
        servings: 4,
        notes: 'Used two lemons. The potatoes needed ten more minutes.',
        lessons: 'Start the potatoes 10 minutes before the chicken.',
        createdAt: cookedRecently,
        updatedAt: cookedRecently,
      },
      {
        id: ids.cookLogOlder,
        recipeId: roastChicken.id,
        cookedOn: isoDay(cookedEarlier),
        rating: 3,
        notes: 'Skin was not crisp.',
        createdAt: cookedEarlier,
        updatedAt: cookedEarlier,
      },
    ],
    chat: [
      {
        id: ids.chatQuestion,
        recipeId: tomatoPasta.id,
        role: 'user',
        content: 'Can I use fresh tomatoes instead of tinned?',
        createdAt: now - 2 * DAY,
      },
      {
        id: ids.chatAnswer,
        recipeId: tomatoPasta.id,
        role: 'assistant',
        content:
          'Yes. Use about 500 g of ripe tomatoes, chopped, and simmer a few minutes longer so the sauce thickens.',
        createdAt: now - 2 * DAY + 5_000,
      },
    ],
  };
}

export function ownerLibrary(now: number): PersonaLibrary {
  const ids = FIXTURE_IDS.owner;
  const shakshuka = recipe(ids.shakshuka, 30, now, {
    title: 'Shakshuka',
    servings: 2,
    prepMinutes: 10,
    cookMinutes: 25,
    lang: 'en',
    tags: ['breakfast'],
    ingredientSections: [
      {
        items: [
          { quantity: 1, item: 'onion', note: 'sliced' },
          { quantity: 1, item: 'red pepper', note: 'sliced' },
          { quantity: 400, unit: 'g', item: 'tinned tomatoes' },
          { quantity: 1, unit: 'tsp', item: 'ground cumin' },
          { quantity: 4, item: 'eggs' },
        ],
      },
    ],
    steps: [
      { text: 'Soften the onion and pepper in a wide pan.' },
      { text: 'Add the cumin and tomatoes and simmer until thick.' },
      { text: 'Make four wells, crack in the eggs, cover, and cook until the whites set.' },
    ],
  });
  const misoSoup = recipe(ids.misoSoup, 25, now, {
    title: 'Miso soup',
    servings: 2,
    lang: 'en',
    tags: ['soup'],
    ingredientSections: [
      {
        items: [
          { quantity: 500, unit: 'ml', item: 'dashi' },
          { quantity: 2, unit: 'tbsp', item: 'white miso' },
          { quantity: 150, unit: 'g', item: 'silken tofu', note: 'cubed' },
          { quantity: 2, item: 'spring onions', note: 'sliced' },
        ],
      },
    ],
    steps: [
      { text: 'Warm the dashi without boiling it.' },
      { text: 'Whisk in the miso, add the tofu, and heat through. Top with spring onion.' },
    ],
  });
  return {
    recipes: [shakshuka, misoSoup],
    collections: [collection(ids.picks, "Owner's picks", [shakshuka.id, misoSoup.id], 24, now)],
    cookStates: [],
    cookLogs: [],
    chat: [],
  };
}

export function viewerLibrary(now: number): PersonaLibrary {
  const pancakes = recipe(FIXTURE_IDS.viewer.pancakes, 6, now, {
    title: 'Pancakes',
    servings: 4,
    lang: 'en',
    tags: ['breakfast'],
    ingredientSections: [
      {
        items: [
          { quantity: 200, unit: 'g', item: 'plain flour' },
          { quantity: 2, item: 'eggs' },
          { quantity: 300, unit: 'ml', item: 'milk' },
          { item: 'butter, for the pan' },
        ],
      },
    ],
    steps: [
      { text: 'Whisk the flour, eggs, and milk into a smooth batter. Rest for 15 minutes.' },
      { text: 'Cook ladlefuls in a buttered pan until golden on both sides.' },
    ],
  });
  return { recipes: [pancakes], collections: [], cookStates: [], cookLogs: [], chat: [] };
}

function draftOf(recipe: Recipe): RecipeDraft {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = recipe;
  return draft;
}

/**
 * `viewer`'s Ask threads on recipes shared with them, each ending in a
 * proposal card: a viewer share offers only Save as a new recipe, an editor
 * share also Apply. Pushed after the grants exist, since the server checks
 * the share on every chat write.
 */
export function viewerSharedChat(now: number): ChatMessage[] {
  const ids = FIXTURE_IDS.viewer;
  const pasta = memberLibrary(now).recipes.find((r) => r.id === FIXTURE_IDS.member.tomatoPasta)!;
  const shakshuka = ownerLibrary(now).recipes.find((r) => r.id === FIXTURE_IDS.owner.shakshuka)!;
  return [
    {
      id: ids.pastaQuestion,
      recipeId: pasta.id,
      role: 'user',
      content: 'Can you make this for four people?',
      createdAt: now - 3 * DAY,
    },
    {
      id: ids.pastaProposal,
      recipeId: pasta.id,
      role: 'assistant',
      content: 'Here it is doubled for four.',
      proposedRecipe: {
        ...draftOf(pasta),
        servings: 4,
        ingredientSections: [
          {
            items: [
              { quantity: 400, unit: 'g', item: 'spaghetti' },
              { quantity: 800, unit: 'g', item: 'tinned chopped tomatoes' },
              { quantity: 4, item: 'garlic cloves', note: 'sliced' },
              { quantity: 4, unit: 'tbsp', item: 'olive oil' },
              { item: 'basil leaves' },
            ],
          },
        ],
      },
      createdAt: now - 3 * DAY + 5_000,
    },
    {
      id: ids.shakshukaQuestion,
      recipeId: shakshuka.id,
      role: 'user',
      content: 'Add some feta?',
      createdAt: now - 2 * DAY,
    },
    {
      id: ids.shakshukaProposal,
      recipeId: shakshuka.id,
      role: 'assistant',
      content: 'Crumble feta over the top just before serving.',
      proposedRecipe: {
        ...draftOf(shakshuka),
        ingredientSections: [
          {
            items: [
              ...shakshuka.ingredientSections[0].items,
              { quantity: 100, unit: 'g', item: 'feta', note: 'crumbled' },
            ],
          },
        ],
        steps: [
          ...shakshuka.steps,
          { text: 'Crumble the feta over the top before serving.' },
        ],
      },
      createdAt: now - 2 * DAY + 5_000,
    },
  ];
}

/**
 * Kitchen profiles (`docs/plans/kitchen-profile.md`), saved through the real
 * route. `member` is allergic to eggs, which the egg tarts and banana bread
 * contain, so Ask has something to flag. `viewer` has one so the deletion
 * check removes a settings document.
 */
/**
 * Account preferences (`docs/plans/measurement-units.md`), saved through the
 * real route. `member` reads recipes in metric, so the roast chicken shows
 * grams and °C; `viewer` has a document so the deletion check removes it.
 */
export const ACCOUNT_PREFERENCES = {
  member: { units: 'metric' },
  viewer: { units: 'metric' },
} as const;

export const KITCHEN_PROFILES = {
  member: {
    allergens: ['eggs'],
    diets: [],
    avoid: 'cilantro',
    dislikes: 'olives',
    equipment: 'No stand mixer.',
    notes: '',
  },
  viewer: {
    allergens: [],
    diets: ['vegetarian'],
    avoid: '',
    dislikes: '',
    equipment: '',
    notes: 'Cooking for one.',
  },
} as const;
