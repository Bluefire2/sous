# Per-member daily AI spending cap

Status: built on `claude/per-user-llm-rate-limit-96825d`, not deployed.

## Why

Every Gemini call is billed to the owner. Before this, only translation
(60/h) and searched generation (20/h) were limited, both in memory per Cloud
Run instance: with `--max-instances=4` and scale-to-zero, those limits are up
to 4× looser than written and reset when an instance recycles. Chat, the
assistant, URL/paste/photo/extension import, generate, and dictation had no
limit at all.

A request count is a poor proxy for cost here: a chat body could be 12 MB,
almost all of it text, enough to fill the model's context (~1M tokens,
about $1.50) in one request. So the cap is on what Google bills.

Owner decisions (2026-10-07): a Firestore counter, not in memory; owners get
the same limit; **$10 per member per UTC day**, plus a cap on chat text.

## Design

- `server/llmPricing.ts`: per-model prices and `costMicroUsd(model, usage,
  searchQueries)`. Standard paid tier, read from
  https://ai.google.dev/gemini-api/docs/pricing on 2026-10-07:

  | Model | Input / 1M | Output / 1M (thinking included) |
  | --- | --- | --- |
  | `gemini-3.7-flash` (chat, agent, import, STT) | $1.50 | $7.50 |
  | `gemini-3.8-flash` (not used by default) | $1.50 | $7.50 |
  | `gemini-3.5-flash` (not used by default) | $1.50 | $9.00 |
  | `gemini-3.5-flash-lite` (translation) | $0.30 | $2.50 |
  | Google Search grounding | $14 per 1,000 queries | |

  `gemini-3.7-flash` and `gemini-3.8-flash` are half that until 2026-12-31;
  the table uses the 2027 rates so the cap does not loosen in January. The
  unused models are listed so a `CHAT_MODEL` or `TRANSLATE_MODEL` change is
  priced exactly; a model not in the table is priced at the highest rates in
  it ($1.50 in, $9.00 out). Cached input is charged at the full rate and
  the free search allowance is ignored, so every estimate errs high.
- `server/llmBudget.ts`:
  - `admitLlm(sub, route)` after auth and body checks, before the first model
    call: reads `users/{sub}/llmUsage/{YYYY-MM-DD}` (UTC). At or over
    `LLM_DAILY_BUDGET_MICRO_USD` (10 000 000) it is 429 `llm-budget-exceeded`
    with `Retry-After` to UTC midnight. A failed read is 503, never a refusal.
  - At most `LLM_MAX_IN_FLIGHT_PER_MEMBER` (2) metered requests per member
    per instance, else 429 `llm-busy`. The slot is taken before the read, so
    parallel requests cannot all pass a stale read.
  - `meter.charge` after each model call, from the response's
    `usageMetadata` (`promptTokenCount + toolUsePromptTokenCount` as input,
    `candidatesTokenCount + thoughtsTokenCount` as output) and its
    `webSearchQueries`; `FieldValue.increment` on `spentMicroUsd` and
    `calls`, plus `expireAt` (the day + 8 days). A failed write is logged
    and never fails the request. A stream cut off before it reported usage is
    charged an estimate (a token per character of the request, tool
    declarations included, 1 300 tokens a photo, and a token per character it
    already wrote), because Google still bills its prompt and its output so
    far. No script uses more than a token per character, so the estimate is
    high.
  - `meteredAi(ai, meter)` wraps a `generateContent` client and does not wait
    for the charge's write, so a slow store never delays an answer. Import,
    the import translator, `/api/translate`, and STT use it.
  - Known gaps: the translation and searched-generation hourly buckets are
    taken before `admitLlm`, so a budget refusal still uses one slot; URL
    import fetches the page before admission. A Stop that lands between a
    step's stream opening and the harness reading it leaves that step
    uncharged (an undercount, not a leak).
  - Chat: `api/chat.ts` cannot import siblings, so `withChatBudget` in
    `scripts/server.ts` (`withMembership(withChatBudget(chatPost))`) admits,
    passes `ctx.onUsage`, and releases when the response body ends.
  - Agent: `googleModel` takes `onUsage`, called once per step.
- Chat text caps in `api/chat.ts`: `MAX_CHAT_TEXT_CHARS` (120 000, message
  text over the thread) and `MAX_CHAT_CONTEXT_CHARS` (210 000, recipe plus
  cooking state as JSON; a stored recipe is under 200 000). The client
  (`fitChatHistory` in `src/lib/chatApi.ts`) drops the oldest messages to fit,
  so a long thread keeps working.
- Logs: one `event: 'llm'` line per charged call (sub, route, model, token
  counts, searches, cost) and one `event: 'llm_refused'` line per refusal
  (sub, route, reason). Never prompt, reply, or error text. A refused import
  is `outcome: 'llm_refused'` on its import line.
- `llmUsage` is classified nested under `users/{sub}` in
  `server/accountDeletion.ts`, so the `users` step deletes it.
- The existing translation and search limits stay.

## What it costs, worst and normal

Worst single request after the caps, at 2027 prices:

| Request | Bound | Cost |
| --- | --- | --- |
| Chat | ≈ 332k chars of prompt; English ≈ 85k tokens, Chinese up to ≈ 330k | ≈ $0.15, up to ≈ $0.55 |
| Agent run | 6 steps, each with the 40k-char index, a 100 KB body, and up to 150 KB of tool results | ≈ $0.55 English, up to ≈ $2 in theory |
| Page or paste import | source capped at 60 000 chars | ≈ $0.06 |
| Photo import | 4 photos | ≈ $0.03 |

Overshoot past the cap is at most 2 requests × 4 instances × one request
(≈ $1–5; the theoretical extreme is about $16), once, after which every
request is refused until midnight. The worst sustained abuse is about $10–15
a day per member, about $300–450 a month, until the owner removes them.

Measured in test mode against real Gemini on 2026-10-08 (2027 prices): a
short paste import $0.0036, a short Ask chat $0.0028, a four-step assistant
shopping-list run $0.044. Long Ask threads and big pages cost more, so a
heavy legitimate day (60 chats, 20 imports, 10 agent runs, 30 translations,
30 dictations) is estimated at $1.50–2.50, 15–25% of the cap. The `llm` log
lines give real per-member numbers after a week.

## Owner steps

1. Before deploying: nothing (no new env var, no secret).
2. After deploying, add a Firestore TTL policy on collection group
   `llmUsage`, field `expireAt` (`/privacy` says about 8 days).
3. After a week, read real daily spend per member from Logs Explorer
   (`jsonPayload.event="llm"`, sum `jsonPayload.costMicroUsd` by
   `jsonPayload.sub`) and confirm the cap sits far above it.

## Verification

- `npm run build`, `npm test`.
- Unit tests: `server/llmBudget.test.ts`, `server/llmPricing.test.ts`, the
  refusal and charge cases in each route's tests, `fitChatHistory`, the chat
  caps and usage reporting.
- Test mode: the `capped` persona has today's budget used up;
  `testing/smoke.ts` checks it gets 429 `llm-budget-exceeded` on `/api/chat`
  and `/api/import` (both admit before the model key is checked, so CI needs
  no key), and that `empty` is not refused.
- Translation review: `import-llm-budget` and `assistant-llm-budget`.
