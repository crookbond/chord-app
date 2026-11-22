# ADR 0056 — Workload-aware model routing

- **Status:** Proposed — direction confirmed 2026-07-16; handed to Adrian for
  detailed design (see Addendum)
- **Date:** 2026-06-18 (addendum 2026-07-16)
- **Supersedes/extends:** none yet. Interacts with [0005](./0005-iterative-tool-use.md)
  (native tools), [0027](./0027-configurable-bot-persona.md) (persona model
  override — see "latent hook" below), [0044](./0044-byok-failure-and-future-billing.md)
  (BYOK + future billing), [0063](./0063-billing-and-model-routing.md) (billing
  tiers — orthogonal axis, see Addendum).

## Problem

Today Chord uses **one model for everything**. The chat/agent turn, vision OCR,
document summaries, the retrieval helpers, every classifier and extractor — all
resolve to the *same* provider + model. There is no way to say "use a cheap
strong tool-caller for the agent turn, and a cheap vision model for OCR," which
is exactly what we want now that we're looking at OpenRouter (one
OpenAI-compatible gateway, many models — see the conversation that spawned this
ADR: a cheap high-ranked tool-caller for chat, a cheap VLM like Qwen-VL for OCR).

We want a **model router**: resolve `(provider, model, baseURL)` per *workload
class*, not once globally — while keeping BYOK, the mock provider, and the
`date-stamp` wrapper intact, and changing **zero behavior** until we opt a route
in.

## How model calls work today

### The abstraction

- **`LlmService`** (`server/src/services/llm/types.ts`) — the whole contract:
  `complete()`, `stream()`, `defaultModel`, `providerName`,
  `supportsNativeTools`. Messages are multimodal-capable already
  (`LlmContentPart` = `text | image`), and `LlmCompleteOptions` already carries
  an **optional per-call `model`** — *no caller currently sets it.*
- **Two resolution entry points**, both in `server/src/services/llm/factory.ts`:
  - **`getLlm()`** — process-wide **singleton**, chosen by `env.LLM_PROVIDER`,
    model from `env.OPENAI_MODEL` / `GEMINI_MODEL` / `ANTHROPIC_MODEL`. Wrapped
    once in `withDateStamp`. Cached.
  - **`getLlmForUser(db, userId)`** — BYOK. If the user row has a stored key,
    builds a per-user provider/model (`model_provider`, `model_name`,
    `model_base_url`); otherwise falls back to `getLlm()`. Not cached.
- Provider impls: `openai.service.ts` (also Ollama/vLLM/**OpenRouter** via
  `OPENAI_BASE_URL`), `gemini.service.ts`, `anthropic.service.ts`,
  `mock.service.ts`. Each pins `defaultModel = opts.model ?? env.*_MODEL`.

### Latent, *unwired* hook (important)

`BOT_LLM_PROVIDER` / `BOT_MODEL` (`env.ts:112-113`) flow into the persona row
(`bot-personas.service.ts:102-103,120-121`) — but **nothing reads them back into
an `LlmService`.** `getLlm()` / `getLlmForUser()` never consult the persona.
So the per-persona model override is dead config today. The router is the right
place to finally honor it.

### Census — every real (non-test) model call, by workload class

| Workload | Call site | Mode | Tools | Vision | temp / maxTok | Resolves via | Funder |
|---|---|---|---|---|---|---|---|
| **Agent turn** (chat + tools) | `bot.service.ts:827`, `:914` | stream | yes | no | — / `MAX_TURN_TOKENS` | `getLlmForUser` | user (BYOK) or platform |
| **Proactive** (briefings/nudges) | `proactive.service.ts:755`, `:991`, `:1035` | complete + stream | no | no | — | `getLlm` | platform |
| **Vision / OCR** (upload) | `attachments.extract.ts:221` | complete | no | **yes** | 0.1 / 1500 | `getLlm` | platform |
| **Vision** (content auto-propose) | `content_classifier.ts:218` | complete | no | **yes** | 0 / 1500 | `getLlm` | platform |
| **Vision** (`look_at_attachment` tool) | `executor.ts:2306` | complete | no | **yes** | — | `getLlmForUser` | user (BYOK) |
| **Summarize / index** | `attachments.extract.ts:429` (summary), `:161` (answerable-questions) | complete | no | no | 0.2/400, 0.3/300 | `getLlm` | platform |
| **Classify / extract** | `trip_classifier.ts:255,295`, `extraction.ts:238,309`, `forms.service.ts:326`, `ingest/whatsapp/extract.ts:97` | complete | no | no | mostly temp 0, 1.5k–8k tok | `getLlm` (whatsapp injectable) | platform |
| **Retrieval helpers** | `query-understanding.ts:25` (expandQuery), `:73` (rerank) | complete | no | no | low | **caller-provided `LlmService`** | follows caller |

**Two facts that make routing cheap to introduce:**

1. **Vision is exactly three sites** (`attachments.extract.ts:221`,
   `content_classifier.ts:218`, `executor.ts:2306`). Everything "image-related"
   downstream (trip/content classifiers reading `ocrText`, summaries) consumes
   the *text those three calls already produced*. Point three sites at a VLM and
   all OCR is routed.
2. **`opts.model` already plumbs through** every provider. A router can drive it
   without touching provider code.

## Proposed design

A thin **router** that maps a `Workload` to a resolved `LlmService`, replacing
direct `getLlm()` / `getLlmForUser()` calls at the ~15 sites above.

```ts
// server/src/services/llm/router.ts  (new)
export type Workload =
  | 'agent'      // bot turn: needs native tools
  | 'vision'     // OCR / image understanding: needs a VLM
  | 'summarize'  // doc summary, answerable-questions
  | 'extract'    // classifiers, trip/content/whatsapp, forms, retrieval helpers
  | 'proactive'; // briefings / nudges

export async function getLlmForWorkload(
  workload: Workload,
  ctx?: { db?: Kysely<DB>; userId?: string | null },
): Promise<LlmService>;
```

Resolution order per workload:

1. **BYOK — "the user's key funds everything they cause."** *(decided)* If a
   triggering/attributable user has a stored key, their provider/model wins for
   **any** workload their action set in motion — not just the agent turn, but the
   upload-time `vision` OCR, the content classifier, trip/whatsapp extraction, and
   summaries of files *they* uploaded. The platform key is used only for true
   system jobs with no attributable user (e.g. scheduled `proactive` briefings).
   This goes further than today's `getLlmForUser` and has a plumbing cost — see
   "Implication" below. Failure handling stays per [ADR 0044](./0044-byok-failure-and-future-billing.md).
2. **Per-route config** — a `MODEL_ROUTES` map (below) gives
   `(provider, model, baseURL)` for the workload.
3. **Fallback** — any unset route falls back to the global
   `LLM_PROVIDER`/`*_MODEL`. **So day-one behavior is identical** until a route
   is filled in.

**Implication of the BYOK decision** — several background sites that today call
`getLlm()` with *no* user context (`attachments.extract.ts`,
`content_classifier.ts`, `trip_classifier.ts`, `extraction.ts`,
`ingest/whatsapp/extract.ts`) must now receive the **uploader's / triggering
user's id** so the router can pick their key. Threading that `userId` through the
upload + auto-file pipelines is part of step 1 of the migration, not a free
refactor. Where a file enters with no owning user (some connector ingest paths),
it falls through to the platform route — that's correct.

Every resolved service still goes through `withDateStamp`. Mock stays the
`LLM_PROVIDER=mock` global for all workloads (tests unaffected).

### Config shape

Default each route to empty = "use the global model" (no-op migration):

```
# Global default (today's behavior) — unchanged
LLM_PROVIDER=openai
OPENAI_MODEL=gpt-5.4-mini

# Per-workload overrides — all 5 routes are independent (decided). Empty = inherit global.
MODEL_AGENT_PROVIDER=      MODEL_AGENT_MODEL=      MODEL_AGENT_BASE_URL=
MODEL_VISION_PROVIDER=     MODEL_VISION_MODEL=     MODEL_VISION_BASE_URL=
MODEL_SUMMARIZE_PROVIDER=  MODEL_SUMMARIZE_MODEL=  MODEL_SUMMARIZE_BASE_URL=
MODEL_EXTRACT_PROVIDER=    MODEL_EXTRACT_MODEL=    MODEL_EXTRACT_BASE_URL=
MODEL_PROACTIVE_PROVIDER=  MODEL_PROACTIVE_MODEL=  MODEL_PROACTIVE_BASE_URL=
```

Five routes is more env surface, but it's the finer-cost-control choice: e.g.
`summarize`/`extract` can ride the absolute-cheapest text model while `agent`
gets a pricier strong tool-caller and `proactive` (user-facing prose) gets
something mid-tier.

OpenRouter example (the motivating case):

```
MODEL_AGENT_PROVIDER=openai
MODEL_AGENT_BASE_URL=https://openrouter.ai/api/v1
MODEL_AGENT_MODEL=deepseek/deepseek-v4-pro        # cheap, strong tool-caller

MODEL_VISION_PROVIDER=openai
MODEL_VISION_BASE_URL=https://openrouter.ai/api/v1
MODEL_VISION_MODEL=qwen/qwen3-vl                   # cheap VLM for OCR
# (one OPENROUTER_API_KEY reused as OPENAI_API_KEY for these routes)
```

### Capability safety

Routing the wrong model into a workload is the main new failure mode:

- **`agent` needs native tools.** If a route's model doesn't support
  function-calling on the chosen OpenRouter provider, the turn breaks — the
  text-fence fallback (ADR 0003) only triggers for `supportsNativeTools=false`
  providers (mock), not for a native provider whose *model* lacks tools. The
  router must know per-route whether tools are expected.
- **`vision` needs a VLM.** A text-only model silently drops the image part
  (`contentToString`).

Proposal: a small **capability check at boot** (reuse the `validateUserModelKey`
pattern in `factory.ts`) — one cheap probe per configured route asserting
tools/vision as required; log + refuse to start (or fall back to global) on
mismatch. Tool support on OpenRouter is per-model **and** per-underlying-provider,
so this guard is not optional.

## Migration plan

1. **Introduce the router as a pure refactor.** Add `Workload` +
   `getLlmForWorkload`; swap the ~15 call sites. Every route inherits the global
   model → no behavior change. Ship behind tests (the existing mock-injection
   tests already assert call counts).
2. **Add per-route config + boot-time capability validation.** Still defaults to
   global.
3. **Opt routes in.** Point `vision` at a VLM and `agent` at a cheap tool-caller
   (OpenRouter). Measure cost/latency.
4. **Wire the latent persona hook.** Let the persona's `llmProvider`/`model`
   override the `agent` route (closes the ADR 0027 gap).

## Decisions

- **BYOK granularity — resolved:** a user's key funds *every* workload their
  action causes (uploads included), not just the agent turn. Requires threading
  `userId` into the background pipelines (see "Implication" above).
- **Route granularity — resolved:** all 5 workloads are independently
  configurable (`agent`, `vision`, `summarize`, `extract`, `proactive`).

## Open questions

- **Cost attribution** — the router is the natural choke point to add per-workload
  token metering for the future-billing work in ADR 0044. Out of scope here, but
  the seam should be left clean.
- ~~**Per-route key management**~~ — resolved in the Addendum: optional
  `MODEL_<ROUTE>_API_KEY` per route, falling back to the route provider's global
  key.

## Addendum (2026-07-16) — direction confirmed, refinements

Direction re-confirmed; Adrian owns the detailed design + implementation from
here. Refinements from the 2026-07-16 discussion:

### Routing vs. billing are two orthogonal axes (ADR 0063 shipped since)

[ADR 0063](./0063-billing-and-model-routing.md) landed **billing-tier** routing
(`resolveTurnLlm` → BYOK / premium / OSS = *who pays*). This ADR is the
**capability** axis (*what the task needs*). Don't merge them:

- The workload route answers "which system model serves this class of call."
- `resolveTurnLlm` composes **on top of the `agent` route only**: its "premium"
  model becomes *the `agent` route's resolved model* instead of the global one.
  The OSS free tier stays its own `OSS_*` env profile, not a route — folding it
  in would tangle "user is out of credits" with "task doesn't need a big model."
- Non-turn workloads (`vision`, `summarize`, `extract`, `proactive`) never touch
  billing tiers; their resolution is BYOK → route config → global default.

### Entry-point shape

Either a new `getLlmForWorkload(workload, ctx)` (as proposed above) or a role
argument on the existing factory — `getLlm(role: Workload = 'agent'…)` — is
acceptable; pick whichever reads better once BYOK ctx-threading is designed.
Non-negotiable either way:

1. **`Workload` stays a closed TS union, never a free string.** A typo'd route
   must be a compile error, not a silent fallback to the expensive default.
   Extending = one union member + optional env vars; every route greppable.
2. **Routes name capability/cost profiles, not call sites.** `vision`,
   `extract`, `summarize` — never `email-classifier` or `forms`. A new caller
   picks an existing route first; a new route needs a genuinely different
   capability or cost profile. This is what keeps "extensible" from becoming
   fifteen env quadruples pointing at the same two models.

### Per-route key (closes the open question)

Add optional `MODEL_<ROUTE>_API_KEY` alongside provider/model/baseURL. Unset →
the route uses its provider's global key (`OPENAI_API_KEY` / `GEMINI_API_KEY` /
`ANTHROPIC_API_KEY`). This covers the OpenRouter case (one key shared across
routes via the openai provider) and the mixed case (e.g. `docs` on Gemini while
everything else rides OpenRouter) without inventing a key registry.

### Motivating deployment (cost)

The near-term intent is the cheap-open-model split: `agent` + `vision` on a
strong tool-calling / VLM model, and `extract`/`summarize` on a
pennies-per-Mtok open model (Groq / DeepInfra / OpenRouter, ~$0.03–0.10/Mtok
for the 8B class as of 2026-07). Small open models are measurably weaker at
native tool-calling, which is exactly why the `agent` route must be able to
stay premium while the classifier fleet gets cheap.
