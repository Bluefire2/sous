# Library assistant agent (v1: read-only tools + modular cards)

Merged (#34), not deployed. App-level assistant at `/assistant`:
read-only tools over the signed-in user's own library, plus modular cards
starting with a shopping list. Conversations are ephemeral. Write tools are v2
proposal cards, documented below and not built.

## Build vs. buy: roll a thin loop, no framework

The harness needed here is small. It is a loop that calls Gemini, runs any function calls, appends the results, and repeats until there is a text answer or a cap is hit. It needs no memory, no durable runs, no multi-agent handoffs, and no provider switching. Everything else (tools, cards, prompt, UI) has to be written whichever library you choose.

- **`@google/genai` automatic function calling** (installed, v1.52; `processAfcStream` in `dist/node/index.mjs`). It runs tool calls one after another. When its call cap is reached it can end on an unanswered function call instead of forcing text. It is also hard to unit test without mocking the SDK.
- **Vercel AI SDK** (`ai`, `@ai-sdk/google`, `zod`, `useChat`). It would add a second Gemini integration next to the three direct ones (chat, import, speech-to-text), plus a new streaming protocol and zod. Its main advantages, provider abstraction and `useChat`, are not needed.
- **Google ADK, LangGraph, Mastra.** These center on sessions, runners, and graph state for multi-agent or durable workflows. They are heavy for about four read-only tools.
- **Chosen: a hand-written loop (`startAgent`) on `generateContentStream`**, with the model client injected so tests can supply a fake. It gives bounded parallel tool execution, a forced final answer (`functionCallingConfig.mode: NONE` on the last step), explicit progress events, and model parts passed back unchanged.
- **When to revisit:** multi-provider routing, long-running or resumable jobs, cross-request human approvals, or multi-agent delegation. None of these is in v1 or in the v2 write tools.

## Module boundary and public API

The agent is a self-contained module on each side. The rest of the app depends on a deliberately small public surface and never on internals. Changing the loop, tools, cards, or wire protocol should not touch files outside these directories, apart from the few wiring points listed here.

```mermaid
flowchart TB
  subgraph serverSide [server]
    scriptsServer["scripts/server.ts"] -->|"agentPost only"| agentIndex["server/agent/index.ts"]
    agentIndex --> route["server/agent/route.ts"]
    route --> harness["server/agent/harness/"]
    route --> sous["server/agent/sous/"]
    sous -->|"ToolSpec, CardSpec types"| harness
    sous -->|"listLiveDocs, compactRecipeFields"| storeTs["server/store.ts"]
    route -->|requireMember| membershipTs["server/membership.ts"]
  end
  subgraph clientSide [src]
    appTsx["App.tsx, Library.tsx"] -->|"AssistantScreen, AssistantEntryLink"| clientIndex["src/agent/index.ts"]
    clientIndex --> clientInternals["src/agent/ api, store, cards, screen"]
    clientInternals -->|"onSessionReset, invalidateSession"| sessionTs["src/lib/session.ts"]
  end
```

**Server layout.**
- `server/agent/harness/` is generic. It knows nothing about recipes, Firestore, auth, or HTTP.
  - `types.ts`: harness-owned `ToolSpec`, `CardSpec`, `AgentMessage`, `AgentEvent`, `AgentLimits`, `ModelClient`, and `ToolParameters`.
  - `limits.ts`, `ndjson.ts` (event encoder), `run.ts` (`startAgent`).
  - `google.ts` is the **only file under `server/agent/` that imports `@google/genai`**. It exports `googleModel({ apiKey, model })` returning a `ModelClient`. Internally it maps `ToolParameters` to the SDK `Schema` (lowercase `'object'` to `Type.OBJECT`, and so on), `AgentMessage[]` to `Content[]`, and SDK chunks to harness-internal step parts. It is also the place for the raw `GenerateFn` (`(params) => Promise<AsyncIterable<GenerateContentResponse>>`), which exists only as an internal and test seam.
  - `ModelClient.step(request): Promise<ModelStepStream>` is an ordinary async function, **not** an `async function*`. It opens the HTTP stream before resolving, so startup failures reject there. The returned `AsyncGenerator` yields harness events (text deltas and function calls with `{ id?, name, args }`), and its return value is an opaque `turn`.
  - `run.ts` passes `turn` back unchanged to the **same** `ModelClient` instance when building the next request. That is how raw parts, including thought signatures, survive between steps without `run.ts` importing the SDK. Turns are never serialized or logged.
  - The route starts consuming the prepared first stream immediately after constructing the `Response`, to keep buffering short.
- `server/agent/sous/` holds the domain code: `library.ts`, `search.ts`, `ingredients.ts`, `tools.ts`, `cards/`, `prompt.ts`. It imports **only** harness types, its own files, and `server/store.ts` (`listLiveDocs`, `compactRecipeFields`, `isLiveDoc`). It never imports the SDK. Its schemas are plain `ToolParameters` object literals.
- `server/agent/route.ts` composes the pieces: auth, validation, library load, prompt, `startAgent`, and the HTTP response. It sees no SDK types.
- `server/agent/index.ts` is the **only** module imported from outside `server/agent/`. It exports `agentPost` and nothing else.

**Harness API** (what domain code and the route see):

```ts
// JSON-schema subset owned by the harness; adapted to Gemini in harness/google.ts.
type ToolParameters =
  | { type: 'object'; description?: string; properties: Record<string, ToolParameters>; required?: string[] }
  | { type: 'array'; description?: string; items: ToolParameters; maxItems?: number }
  | { type: 'string'; description?: string; enum?: string[] }
  | { type: 'number' | 'integer' | 'boolean'; description?: string };

interface AgentMessage { role: 'user' | 'assistant'; text: string }

interface ToolSpec<Ctx> {
  name: string;
  description: string;
  parameters: ToolParameters;
  run(args: unknown, ctx: Ctx, signal: AbortSignal): Promise<ToolResult>; // { output } | { error }
}
interface CardSpec<Ctx, T> {
  type: string;           // 'shopping_list'
  version: number;        // 1
  toolName: string;       // 'show_shopping_list'
  description: string;
  parameters: ToolParameters;
  rule: string;           // system-prompt paragraph: when to emit this card
  normalize(args: unknown, ctx: Ctx): { ok: true; data: T } | { ok: false; error: string };
  historyText(data: T): string;
}

// Opens the first model stream before resolving, so a startup failure rejects
// (the route maps that to 502) without the route knowing first-step config.
function startAgent<Ctx>(opts: {
  model: ModelClient; systemInstruction: string; messages: AgentMessage[];
  tools: ToolSpec<Ctx>[]; cards: CardSpec<Ctx, unknown>[]; ctx: Ctx;
  limits: AgentLimits; signal: AbortSignal;
}): Promise<{ run(emit: (event: AgentEvent) => void): Promise<AgentRunSummary> }>;
// AgentRunSummary: steps, calls, result bytes, finish reason; for logging only.
```

**Client layout.**
- `src/agent/` contains `protocol.ts` (wire types, **types only**), `api.ts` (fetch plus NDJSON parser), `store.ts` (ephemeral thread), `cards/`, `AssistantScreen.tsx`, and `AssistantEntryLink.tsx`.
- `cards/` is split so card parsing is testable without JSX. `cards/parse.ts` is pure `.ts` holding the `parse` functions and importing only `protocol.ts` types. `cards/registry.tsx` maps each type to one `render` that parses and draws that card.
- `src/agent/index.ts` exports only `AssistantScreen` and `AssistantEntryLink`.
- Outbound dependencies are limited to `react`, `react-router-dom`, `src/lib/session.ts` (`onSessionReset`, `invalidateSession`), `src/lib/uiClasses.ts`, `src/lib/icons.tsx`, `collectionStore.moveRecipes` from `src/lib/collectionStore.ts`, and `useRecipes` from `src/lib/recipeStore.ts`. For the shopping list, card data carries the recipe titles it needs. For `collection_move`, source labels are frozen on the card (`sources`, and the preview's `from`). Expanded titles still come from `useRecipes`, falling back to the preview title. Replay sends destination, preview, and total only.

**Wiring points outside the modules** (the complete list):
- `scripts/server.ts` gets one route line.
- `src/App.tsx` gets one route.
- `src/screens/Library.tsx` gets `<AssistantEntryLink />`.
- `src/lib/session.ts` gets a generic `onSessionReset(listener)` hook fired from `invalidateSession`. The agent subscribes to it, so `session.ts` never imports the agent (no import cycle, and dependencies point inward only).
- `server/store.ts` gets `listLiveDocs`.

**Enforcement.** `test/agentBoundary.test.ts` is a static scan in the spirit of the architecture-lock suite in [server/membership.test.ts](server/membership.test.ts), with these scanning rules:
- It covers **production sources only**, under `api/`, `server/`, `scripts/` and `src/`, in both `.ts` and `.tsx`. It excludes `*.test.ts(x)`, `test/`, and `evals/`, so tests, fakes, and the live eval may import internals.
- It parses files with the installed TypeScript compiler API (`ts.createSourceFile`) and not with regex. It reads static `import` and `export ... from` declarations, dynamic `import('literal')` calls, and whether each import is type-only. An import counts as type-only when the whole clause is `import type` or every named specifier carries `type` (as in `import { type X }`).

It asserts:
1. No production file outside `server/agent/` imports or re-exports anything under it except `server/agent/index.ts`.
2. Within `server/agent/harness/`, only `google.ts` imports `@google/genai`. Other harness files import only harness files and `node:` builtins.
3. `server/agent/sous/` imports only harness files, sous files, and `server/store.ts`. It does not import `@google/genai`.
4. No production file outside `src/agent/` imports or re-exports anything under it except `src/agent/index.ts`.
5. Every `server/` import from `src/` is type-only (the runtime image has no `src/`, see [Dockerfile](Dockerfile)).
6. `src/agent/protocol.ts` has no runtime exports, and `src/agent/cards/parse.ts` imports nothing but `protocol.ts` types.

**Repo constraints this respects.**
- The route calls `requireMember` directly, as [server/stt.ts](server/stt.ts) does, and uses `access.sub`. It does not use `withMembership`: assertion 6 in `server/membership.test.ts` allows the identifier `authorizedSub` only in `api/chat.ts` and `server/membership.ts`.
- Test doubles such as `test/fakeGeminiStream.ts` live in `test/`, next to [test/fakeGemini.ts](test/fakeGemini.ts), not in `server/`.

## Harness loop semantics

For each step:
1. Consume the stream to completion and **buffer every candidate part verbatim, in order**. This includes `thought` and `thoughtSignature` parts; Gemini 3 needs signatures returned on later steps.
2. Text parts are streamed live as `{"t":"text","step":n,"d":...}`. If the step turns out to contain function calls, the server emits `{"t":"interim","step":n}`. The client then shows that step's text as muted progress narration, not part of the answer, and history replay leaves it out. This avoids a draft answer contradicting the final one while keeping the final answer streaming.
3. If there are function calls, append the exact model content. Execute the calls with a concurrency limit of 4, then append **one** `role: 'user'` content containing a `functionResponse` for each call, in the original call order, echoing the call's `name` and `id` when present. The payload is `{ output }` or `{ error }`. Unknown tool names and argument validation failures become `{ error }`. Tool exceptions are caught and become a generic `{ error }` without the stack.
4. Card calls go through `CardSpec.normalize`. On success the server emits `{"t":"card",...}` and the response is `{ output: { shown: true } }`. On failure the response is `{ error }` so the model can retry.
5. A step with no calls ends the run. On the last allowed step the loop keeps the declarations but sets `functionCallingConfig.mode: NONE`, which forces text.
6. A response with no text and no calls, or a blocked `finishReason` or prompt feedback, emits `{"t":"error","code":"assistant_unavailable","message":"The assistant couldn't answer that."}`. The English `message` is the fallback for older clients; the client shows the catalog sentence for that code.
7. When a per-request call or byte limit is reached mid-run, the next step is forced to be the final one (mode `NONE`). The limit note is an extra text part on the function-response user turn, so the transcript still alternates roles.

## Limits

These live in one `AgentLimits` object and are passed in by the route.

| Limit | Value |
| --- | --- |
| Model steps | 6 (last forced to text) |
| Function calls | 8 per step, 16 per request; extras get `{ error: 'limit' }` |
| `get_recipes` ids | 8 per call |
| Tool result | 24 KB serialized each, 150 KB cumulative. Oversize results are truncated **structurally** by dropping trailing array items or recipes, then adding `truncated: true`. The result is never cut by slicing serialized JSON. |
| Library load | 2,000 live recipes **and** 8 MB of aggregate JSON, whichever comes first, then `truncated` |
| Prompt index | 500 entries **and** 40,000 characters |
| Wall-clock deadline | 90 s via `AbortSignal.any([clientAbort, timeout])`, passed to every Gemini call and checked between tool calls |
| Output | `maxOutputTokens: 4096` per step |

## Request validation and status mapping

The request is `{ messages: [{ role, content, cards? }], clientNow, timeZone }`, read through `readBoundedText` with a 100 KB limit.

Validation:
- 1–40 messages, roles `user` or `assistant`, and the last message is from the user.
- Message content is at most 4,000 characters for the user and 20,000 for the assistant.
- At most 4 cards per message. Each replayed card is re-normalized by its `CardSpec`; invalid or unknown cards are dropped from the replay.
- `clientNow` must be an ISO string that parses. `timeZone` must be accepted by `Intl.DateTimeFormat`, otherwise UTC is used.

Status mapping **before** the stream starts: everything that can fail with a real HTTP status runs first.

| Condition | Status |
| --- | --- |
| Membership denied / unknown | 401 / 503 (`requireMember`) |
| Body over 100 KB | 413 |
| Malformed or invalid body | 400 |
| `GEMINI_API_KEY` missing | 503 |
| Firestore library load fails | 503. The library is loaded **eagerly** before the response, because the index is needed for the prompt anyway. A rejection that arrives after the load timeout is caught so it does not surface as an unhandled rejection. |
| First `generateContentStream` call rejects | 502. The route awaits `startAgent`, which opens the first stream before resolving (as `api/chat.ts` awaits its stream), and only then returns the `Response`. |

After headers are sent, failures become a sanitized `{"t":"error","code":"assistant_unavailable","message":...}` followed by `{"t":"done"}`. The English message stays as a fallback; the client owns the words. The response is `application/x-ndjson` with `Cache-Control: no-store` and no `Content-Length`. A stream without `done` is treated as truncated by the client. A server deadline (`TimeoutError` from `AbortSignal.timeout`, including when it wins `AbortSignal.any`) emits that canned error and `done`. A client abort returns `finish: 'aborted'` with no error event, so the client can label the partial reply.

**Cancellation is guaranteed only after the `Response` is returned.** Then client Stop aborts the fetch, and the stream's `cancel()` aborts the run's controller, which stops Gemini and any pending tools. The pre-response phase (library load and opening the first stream) cannot see a client disconnect: `dispatchFetch` in [scripts/server.ts](scripts/server.ts) builds the `Request` without a signal tied to the Node request. That phase is bounded by the same 90 s deadline instead. Wiring a disconnect signal through `dispatchFetch` is a possible generic follow-up, deliberately left out so v1 adds no new wiring outside the module.

If the user stops before a step's `interim` event arrives, the client keeps the text received so far, labels it "Stopped", and replays it in history as a normal assistant message.

## Server data access

- `listLiveDocs(uid, kind: 'recipes' | 'collections', { maxDocs, maxBytes })` in [server/store.ts](server/store.ts) pages by document id (200 per page), skips tombstones, and stops at `maxDocs + 1` live documents, `maxBytes`, or exhaustion. It returns `{ docs, truncated }`. Recipes pass through `compactRecipeFields`.
- The cost is one billed read per document per turn, which is hundreds of reads for a personal library. v1 re-reads on every turn on purpose and does not cache: a per-sub cache would serve recipes that another device has already edited. The count is logged so cost can be watched. `listLiveDocs` appends each kept document in place so the page fold stays linear in the number of live docs.
- Collection membership is ported from `winningMembership` in [src/lib/collectionMembership.ts](src/lib/collectionMembership.ts) into `sous/library.ts`, with a comment linking the two copies.
- Logs record only tool names, call counts, durations, step count, result bytes, document counts, and truncation flags. They never include recipe text, messages, or card data.

## Tools (all read-only)

- `search_recipes({ query?, tags?, collectionId?, maxTotalMinutes?, includeIngredients?, excludeIngredients?, limit? })` returns compact hits: `id`, `title`, `tags`, `servings`, prep, cook and total minutes, `timeUnknown`, collection name, and a short snippet. Scoring is lexical (title, then tags, then ingredients, then description and notes). `collectionId: 'unfiled'` selects the implicit default collection. `limit` is at most 20.
- `get_recipes({ ids })`, up to 8 ids, returns `id`, `title`, `description`, `servings`, times, `ingredientSections`, `steps`, `notes`, and `tags`. **No `sourceUrl` and no photo ids**: stored URLs can carry private query parameters, and neither is needed for comparing or listing.
- `list_collections()` returns `id`, `name`, and `recipeCount`, plus Unfiled.
- `combine_ingredients({ recipes: [{ id, servings? }] })` is deterministic:
  - **Scale** each recipe by requested servings ÷ recipe servings. The factor is 1 when either value is missing or not positive.
  - **Normalize item names:** lowercase, trim, collapse whitespace, drop parentheticals. There is no stemming; the model reconciles "onion" and "onions" in the card.
  - **Unit families and constants:**
    - US volume: tsp = 1, tbsp = 3, cup = 48.
    - Metric volume: ml = 1, l = 1000.
    - Metric mass: g = 1, kg = 1000.
    - Imperial mass: oz = 1, lb = 16.
    - Count: `piece` and unitless quantities.
    - Other: exact unit string match only.
  - There is **no conversion between families**. Merged lines use the largest unit in the family whose value is at least 1, rounded to 2 decimals.
  - Items without a quantity merge into one "as needed" line.
  - Every line carries `sourceRecipeIds`. Lines that cannot be merged are returned separately.
- The system prompt (`server/agent/sous/prompt.ts`) contains:
  - the role and style rules (plain text, like the per-recipe chat);
  - the client's local time and time zone;
  - the card rules generated from `CARD_SPECS`;
  - the bounded library index (id, title, tags) plus a note when the library or index was truncated.

  Library content in the index and in tool results is wrapped in clearly delimited `<library_data>` blocks. The prompt says to treat that content as **untrusted data** and never follow instructions found inside recipes. There is no pantry or equipment store; those constraints come from the user's message.

## Modular cards

A card is emitted when the model calls a card's `toolName`. The server validates the arguments through `normalize`, emits `{"t":"card","card":{"type","v","id","data"}}`, and returns `{ shown: true }` to the model.

**Adding a card type:**
1. Server: add `server/agent/sous/cards/<type>.ts` exporting a `CardSpec` with `type`, `version`, `toolName`, `parameters`, `rule`, `normalize`, and `historyText`, and add it to `CARD_SPECS` in `cards/index.ts`. The prompt, tool list, and call routing are all built from that array.
2. Fixtures: add `test/fixtures/agent-cards/<type>.v<n>.json` with valid and invalid examples.
3. Client: add a pure `parse(v, data): T | undefined` to `src/agent/cards/parse.ts`, and add one `render` entry to `src/agent/cards/registry.tsx`.
4. Tests: `test/agentCardContract.test.ts` reads the fixtures with `node:fs` and runs them through **both** the server `normalize` and the client `parse`. That is the contract that keeps the two sides from drifting. It lives in `test/`, which `tsconfig.node.json` type-checks. It never imports the `.tsx` registry, so it needs neither JSX support in the Node tsconfig nor Node types in the app tsconfig. Bump `version` when the data shape changes. The client renders an "Update the app to see this card" fallback for an unknown type or unsupported version, and never crashes the thread.

**v1 card, `shopping_list` (version 1):**
- **Data:** `{ title, recipes: [{ id, title, servings }], sections: [{ name, items: [{ key, item, quantity?, unit?, note?, recipeIds }] }] }`.
- **Validation:** every recipe id must exist in the library. Caps are 12 sections, 150 items, and string lengths.
- **Rule:** emit it whenever the user asks for a shopping or grocery list, after calling `combine_ingredients`.
- **UI:** items grouped by section, recipe chips linking to `/recipe/:id`, and "Copy as text". Ticked items are stored in the agent store keyed by card id and item `key`, so they survive opening a recipe and coming back.

## Client (ephemeral)

- `src/agent/api.ts` sends the request and parses NDJSON. The parser is pure and unit-tested for UTF-8 characters split across chunks, lines split across chunks, malformed lines (skipped), missing `done` (truncated), deliberate abort (not an error), and an oversized-line guard (1 MB). A 401 calls `invalidateSession()`.
- `src/agent/store.ts` is a module-level store read through `useSyncExternalStore`. It holds messages, cards, interim text, tool chips, and checked items. Its transitions are pure reducer functions with unit tests. It survives route changes, not reloads. It clears on Clear and through `onSessionReset`. Nothing is synced, and `ChatMessage` and the other schema-locked types are not touched.
- `AssistantScreen` at `/assistant` shows messages, cards, tool chips ("Searching recipes..."), a Stop button, Clear, and 2–3 starter prompts, with a note under them that only the user's own recipes are searched, not collections shared with them. `AssistantEntryLink` is the Ask link in the Library header: a chat-bubble icon with the translated "Ask" as its accessible name, like the settings cog. With a word there, the header wrapped onto two rows in `uk` and `ru`; even the icon left `ru` 22 px over at 390 px, so the Library's Invite control became a person-plus icon in the same change.

## v2: write tools and trust boundary (documented, not built)

- Collection moves are the **`collection_move` card** (`propose_collection_move`), applied on the client through `collectionStore.moveRecipes`. Creating a collection is the **`collection_create` card** (`propose_create_collection`): the person confirms, and `collectionStore.createWithRecipes` creates it and files the given recipes in one push. Recipe edits and new recipes stay unbuilt.
- Other write tools are **proposal cards** the user applies (`propose_recipe_edit`, `propose_new_recipe`), following the `update_recipe` pattern. They are never server-side writes from inside the loop.
- The client applies an accepted proposal through the existing stores (`recipeStore`, `collectionStore`). Last-write-wins, tombstones, `compactRecipe`, and push validation therefore all apply unchanged.
- This fits `CardSpec` with a client-side `apply` handler added to the registry entry.
- **Trust boundary:** recipe text (often imported from the web) is untrusted and can contain prompt injection. So:
  - proposals are never auto-applied;
  - every proposal shows a diff and needs an explicit user action (a collection move shows the destination and the full list of recipes that will move, collapsed to a preview of 8 until expanded; a collection create shows the new name and the recipes that will be filed, with the same preview);
  - proposal targets are validated against the user's own library;
  - no tool gets network or cross-user access.
- Also parked: persisted threads (a new synced Firestore kind), photo input, and Google Search grounding.

## Steps

1. [core] Save this plan as `docs/plans/library-agent.md`, including the module boundary, the card how-to, and the v2 and trust-boundary sections. Add a row to the `AGENTS.md` plans table and a short "Agent module" note: the public entry points, the one-line wiring points, and that nothing outside imports agent internals.
2. [core] [src/lib/session.ts](src/lib/session.ts): add a generic `onSessionReset(listener)` fired from `invalidateSession`, plus a test.
3. [core] [server/store.ts](server/store.ts): add `listLiveDocs` as specified, with tests of the pure paging and cap helper.
4. [core] `server/agent/harness/`: `types.ts` (including `ToolParameters` and `AgentMessage`), `limits.ts`, `ndjson.ts`, `google.ts` (the SDK adapter and schema mapping), and `run.ts` (`startAgent`) as specified. Add `test/fakeGeminiStream.ts`, a fake `GenerateFn` wrapped by the same adapter, and tests for:
   - `ToolParameters` to SDK `Schema` mapping and `AgentMessage` to `Content` mapping;
   - a startup failure making `startAgent` reject;
   - text only;
   - one tool round;
   - text plus calls in one step (`interim`);
   - parallel calls with ordered responses and echoed ids;
   - thought signature parts preserved;
   - unknown tool and invalid arguments;
   - a throwing tool;
   - card success and retry;
   - per-step and per-request call limits;
   - byte limits;
   - forced final step;
   - empty or blocked response;
   - deadline and abort.
5. [core] `server/agent/sous/library.ts`: `AgentLibrary`, ported membership, and the bounded index text, plus tests.
6. [core] `server/agent/sous/search.ts`: `searchRecipes`, plus tests (scoring, time filter, unknown times, include and exclude ingredients, unfiled, limit).
7. [core] `server/agent/sous/ingredients.ts`: `combineIngredients`, plus tests (scaling, each family, choice of output unit, no conversion across families, counts and unitless, no-quantity lines, unmergeable lines).
8. [core] `server/agent/sous/tools.ts`: data `ToolSpec`s with argument validation and result caps, plus tests. These include asserting that `sourceUrl` and photo ids are absent.
9. [core] `server/agent/sous/cards/`: the `shopping_list` v1 spec and `CARD_SPECS`; fixtures in `test/fixtures/agent-cards/`; tests.
10. [core] `server/agent/sous/prompt.ts`: prompt builder with untrusted-data delimiting and truncation notes, plus tests.
11. [core] `server/agent/route.ts` (validation, pre-stream status mapping, eager load, first stream awaited, NDJSON response, sanitized logs) and `server/agent/index.ts` exporting only `agentPost`. Wire `{ method: 'POST', path: '/api/agent', handler: agentPost }` in [scripts/server.ts](scripts/server.ts). Add tests for the pure validation and status mapping.
12. [core] `test/agentBoundary.test.ts` with the six boundary assertions.
13. [core] `src/agent/protocol.ts`, `api.ts` (parser and tests), `store.ts` (reducers and tests, `onSessionReset` subscription), and `index.ts`.
14. [ui] `src/agent/cards/`: pure `parse.ts`, `registry.tsx`, `ShoppingListCard`, and the unknown-card fallback. Add `test/agentCardContract.test.ts`, which runs the shared fixtures through server `normalize` and client `parse`.
15. [ui] `src/agent/AssistantScreen.tsx` and `AssistantEntryLink.tsx`; the route in [src/App.tsx](src/App.tsx); the entry in [src/screens/Library.tsx](src/screens/Library.tsx).
16. [core] Update [public/privacy.html](public/privacy.html) and `public/terms.html`: when you use the assistant, many recipes from your library (titles, tags, and the full text of recipes it looks up), not only the one you are viewing, are sent to Gemini at request time.
17. [core] `evals/agent.eval.ts`, run through `npm run test:import`, never CI. A fixture library of about 4 recipes and two prompts ("compare for 30 minutes tonight, no oven", "shopping list for X and Y") checks for the expected tool calls and a valid `shopping_list` card with the right recipe ids.

## Verification

- `npm test`, which includes the boundary scan and the existing architecture lock, and `npm run build`, which is the type gate for `server/`.
- Manual: `npm run dev` and `npm run dev:api`, signed in at `localhost:5173`. This needs `.env.local` with `GEMINI_API_KEY` and Firestore credentials.
  - Run the compare prompt and the shopping-list prompt.
  - Tick items, open a recipe chip, and come back; the thread and ticks survive.
  - Stop in the middle of a stream, then Clear.
  - Sign out; the thread is gone.
  - Reload; the thread is gone.
  - Confirm the per-recipe chat and the Library are unaffected.
