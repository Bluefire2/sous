# Kitchen profile

Status: built on `claude/personal-user-settings-explore-5d149e`, not deployed.
Constitutions applied: i18n (catalogs, principles 9, 10, 13, 16), client
state (component state only; nothing reads the profile outside its section).

## Goal

Sous stores no preferences on the account. Theme and UI language stay on the
device. The three features that write or change recipes started from nothing
every time:
- Ask (`api/chat.ts`)
- Generate on `/import` (`generateFromBrief`)
- the library assistant (`server/agent/sous/prompt.ts`)

A member with a nut allergy or a vegetarian household had to say so in every
brief and every chat. With the kitchen profile, they set it once in Settings,
and the server adds it to those three prompts.

## Out of scope (v1)

- Backups (export and import). The profile is not library data.
- MCP. No tool reads or writes it.
- Units, household size, and other display preferences.
- A warning on the recipe screen when a recipe contains an allergen. Ask
  brings it up when it matters; there is no new recipe UI.
- Page and paste import, photo import, and translation. Extraction must stay
  faithful to the source, so the profile never reaches those calls.

## Decisions

- **Form.** Chips plus free text.
  - Allergens are the EU's 14 major allergens.
  - Diets: vegetarian, vegan, pescatarian, gluten-free, dairy-free, halal, kosher.
  - Four text boxes of up to 500 characters each: other foods to never include
    (a hard constraint), dislikes (soft), equipment, and anything else.
  - Chips are stored as codes. The server always shows them to the model under
    fixed English names; only the labels are translated (i18n principle 10).
  - The free text stays in the language the member wrote it in.
- **Ask behaviour.** Allergens and "never include" foods are hard constraints.
  - Ask never suggests them and never adds them in `update_recipe`.
  - When the recipe contains one, Ask points it out whenever the member asks
    about cooking it, substituting, or changing it.
  - Ask does not warn unprompted.
  - Diet and dislikes give way to an explicit request.
- **Generate.** Allergens and "never include" foods are never written, even
  when the brief names one.
  - The model uses a substitute and says so in notes.
  - Diet and dislikes give way to a brief that explicitly asks otherwise.
  - The research call (Search the web) never sees the profile, so it never
    becomes a search query.
- **Assistant.** The profile shapes suggestions and filtering, and the
  assistant flags an allergen when it is relevant.
- **Read on the server, never from a body.** Every route reads the profile
  from the store for the session `sub`.
  - Chat on Cloud Run gets it through `withKitchenProfile` in
    `scripts/server.ts`, because `api/chat.ts` cannot import siblings.
  - The Vercel copy gets no context, so it gets no profile. It answers 401
    anyway.
- **A failed read is 503.** Ask, the assistant, and Generate refuse rather
  than answer as if the member had no allergies.
  - Generate reads the profile before taking a search slot, and logs
    `outcome: 'store_unavailable'`.
- **Never logged.** No log line holds any of the profile. The `import`, chat,
  and `agent` lines have no new fields.
- **Routes.** `GET /api/settings/kitchen` answers `{ profile }` (null when
  none is saved). `POST` replaces the whole profile. Both are behind
  `withMembership`; POST, not PUT, like every other write route.
  - Input is strict: an unknown code, a wrong type, a missing field, or text
    over the cap is 400, never repaired.
  - A stored document is read leniently: unknown codes are dropped, so
    removing a code later never breaks Ask.

## Where it is stored

`users/{sub}/settings/kitchen`:

| Field | Type | |
| --- | --- | --- |
| `allergens` | string[] | codes from `ALLERGENS` in `server/kitchenProfile.ts`, canonical order |
| `diets` | string[] | codes from `DIETS` |
| `avoid` | string | ≤ 500, trimmed |
| `dislikes` | string | ≤ 500, trimmed |
| `equipment` | string | ≤ 500, trimmed |
| `notes` | string | ≤ 500, trimmed |
| `updatedAt` | number | server time of the last save |

It is nested under `users/{sub}`, so account deletion's
`recursiveDelete(users/{sub})` removes it. The collection is classified as
`settings` in `FIRESTORE_COLLECTIONS`. The lists and the cap are mirrored in
`src/lib/kitchenProfileApi.ts`, and a test keeps the two equal.

## Steps

1. [core] `server/kitchenProfile.ts`: parse, prompt block, store, GET and
   POST handlers, `withKitchenProfile`. Classify `settings`. Add the routes.
2. [core] Ask: `systemPrompt` takes the block, plus the rules.
3. [core] Assistant: `server/agent/route.ts` reads the profile beside the
   library under the same timeout; `buildSystemPrompt` takes it.
4. [core] Generate: the brief branch of `server/importRoute.ts` reads the
   profile; `generatePrompt` appends the block and its rule.
5. [ui] `src/lib/kitchenProfileApi.ts` and
   `src/components/KitchenProfileSection.tsx` in Settings (signed in, after
   Library). Add a link line under the Generate hint on `/import`.
6. [ui] Catalog strings in all four languages, plus the
   `settings-kitchen-profile` and `settings-kitchen-profile-save-error`
   review states.
7. [core] `/privacy` and `/terms`; test-mode seed (member: eggs; viewer:
   vegetarian), a `writeSmoke` phase, and deletion-check lines.

## Verification still to run

- In the browser, in test mode as `member`:
  - Edit and save the profile, reload, and check it persisted.
  - Ask on Egg tarts flags the eggs.
  - Generate respects the allergy.
- `npm run test:i18n -- --states settings-kitchen-profile,settings-kitchen-profile-save-error,import-create-idle`
  in every non-English language.
