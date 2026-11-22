# 0332 — An allowance is a dollar budget, shown in real tokens

**Status**: accepted
**Date**: 2026-11-10

## Context

Users ran out of their token allowance (ADR 0196/0325) while the OpenRouter
bill stayed small, and there was no way to say how our tokens map to
OpenRouter's dollars. `token_usage` stored prompt and completion tokens only.
OpenRouter's usage block (on every response, streaming included) also carries
`cost` (dollars billed for the call) and `prompt_tokens_details.cached_tokens`
(prompt tokens read from cache, about a quarter of the fresh-input price on
`gpt-4.1-mini`). A chat turn sends 60-90k prompt tokens a round trip, most of
it the same system prompt and tool list (ADR 0322), so most of it is cached;
embeddings (ADR 0276) cost about a twentieth of chat input per token. So a
10M-token allowance ran out after roughly $1-1.50 of real spend, while nothing
stopped calls that cost more per token than the allowance assumed.

Owner constraint: **no user can spend more than their dollar amount, whatever
that comes to in tokens; the card shows tokens, as OpenRouter counts them.**

## Decision

- **Every call records its cost and cached count when the provider reports
  them.** `LlmTokenUsage` gains optional `cachedTokens` and `costUsd`;
  `usageFromResponse` (`llm/openai.service.ts`) reads them from the
  OpenAI-compatible usage block (OpenAI direct sends the cached count, no
  cost; Ollama/vLLM neither); the embedder reads `cost` the same way. Every
  usage writer passes them to `recordTokenUsage`. Migration `146` adds
  nullable `token_usage.cached_tokens` and `cost_usd`; a provider that does
  not say leaves them null, never 0. A turn's cost is the sum of its round
  trips, or unknown once any round trip reported none (`addUsage`).
- **Every allowance is a dollar budget**: its configured tokens (free,
  monthly, family pool, grandfathered) x `ALLOWANCE_USD_PER_MILLION_TOKENS`
  (default $0.40 = fresh input on `gpt-4.1-mini`; a paid month defaults to 20M tokens ($8), the free allowance to 12.5M ($5)). Spend is
  `SUM(cost_usd)`, with a row that has no cost (older rows, Anthropic/Gemini
  on Chord's key) priced at the same rate - never below the fresh-input price,
  so an estimate cannot let anyone overspend. `measureAllowance`
  (`tokens.service.ts`) decides; `getEntitlement` uses it in all four places.
  A rate of 0 restores plain token counting.
- **The card shows real tokens.** Used = every real token (the number
  OpenRouter shows). The allowance is the dollar budget restated at the
  user's own dollars per token so far (`tokens x budget / spent`), so used /
  allowance is exactly spent / budget and the bar empties when the money
  does. Before anything is spent it reads the nominal allowance. A user of
  cheap cached chat sees an allowance above 10M; a user of costly calls,
  below it.
- **A turn stops at the budget, not after it.** The entitlement carries
  `remainingUsd`; the model gate (`withAllowanceGate`, `llm/factory.ts`)
  adds up its own calls' cost and refuses the next call once that reaches
  it, for every handle including the bot turn's (which used to skip the gate
  once entitled). The bot's tool loop ends with what it has on that refusal
  and its spend is still recorded. A user can go over by at most the one call
  that crossed the line (a round trip is a few cents).
- **BYOK unchanged**: nothing recorded, no budget, the card says usage isn't
  tracked.

## Consequences

- `SUM(cost_usd) / SUM(total_tokens)` per source is the real price per token;
  allowance sizes are dollar decisions now.
- The allowance number on the card moves with how a user uses Chord. That is
  the honest translation of a fixed dollar amount.
- Two doors running at once (a sweep and a chat turn) each check against the
  same `remainingUsd`; the overshoot is still bounded by one call each.

## Rejected

- **Allowance in real tokens** (built first): a user who could check their
  count against OpenRouter, but a dollar amount could be overspent by
  expensive calls and underused by cheap ones.
- **Dollars on the card**: no dollars exist for a provider that does not
  report them, and the owner wants the unit to be tokens.
- **A price table**: OpenRouter already reports what it billed, routing and
  discounts included; a table goes stale.
- **Re-reading the entitlement before every call**: a query per round trip
  that still misses the turn's own unrecorded spend.
