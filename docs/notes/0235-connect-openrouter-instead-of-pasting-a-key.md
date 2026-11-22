# 0235 — Connect OpenRouter instead of pasting a key

**Status**: accepted
**Date**: 2026-10-09

## Context

Bring-your-own-key worked, but only for someone who already had a key: find the
provider's key page, create a key, copy it, paste it into Settings next to a
model name and a base URL. Billing-wise BYOK is the cheap path — a BYOK user
costs Chord no model spend and, while `STRIPE_PRICE_ID_BYOK` is empty, pays
Stripe nothing (ADR 0195) — so the friction is the only thing standing between
a user and it. OpenRouter is the natural first provider: one account reaches
Claude, GPT, Gemini and open models, and it already worked as an `openai`
provider with a base URL (ADR 0044's docs).

OpenRouter offers an OAuth (PKCE) flow that hands an app a key the user owns
and can revoke. The owner asked for BYOK "end to end" and for the model to
default to what the app uses today unless the user edits it.

## Decision

**A "Connect OpenRouter" button that ends with the key stored, and the user
having copied nothing.**

1. `POST /me/model-key/openrouter/start` (session) creates one pending attempt —
   an unguessable single-use `state`, a PKCE verifier, the chosen model, the
   platform — in `openrouter_connects` (migration 103) and returns the
   `openrouter.ai/auth` URL with `callback_url` and an S256 challenge. One open
   attempt per user; rows older than ten minutes (OpenRouter's own code
   lifetime) are pruned on each start.
2. The user signs in, adds credit if needed, approves. OpenRouter redirects the
   browser to `GET /api/v1/openrouter/callback/:state?code=…`.
3. **The server does the exchange.** The callback has no session, so the
   `state` is the credential: it is looked up, deleted at once (single use —
   a replay finds nothing), and the `code` plus the stored verifier are posted
   to `https://openrouter.ai/api/v1/auth/keys`. The key never passes through
   the app and the verifier never leaves the server. Neither is logged.
4. The key is stored by **`saveModelKey`**, the validate-then-seal rule lifted
   out of `PUT /me/model-key` so a connected key and a pasted key cannot drift
   apart (ADR 0044): one tiny test call first, then sealed at rest.
5. The browser is sent back to `/settings?byok=ok|needs_credit|error` (web) or
   `chord://settings?…` (native, so `openAuthSessionAsync` closes itself). The
   destination is derived from the `platform` the attempt started with — never
   taken from the request — so the callback is not an open redirect. The app
   refreshes Settings and says how it went.

**Which model.** Whatever the user typed (the app sends it only when it looks
like OpenRouter's `vendor/model` spelling), else *the model the app runs on
today*, written the way OpenRouter writes it: `gpt-5.4-mini` →
`openai/gpt-5.4-mini`, a Gemini model → `google/…`, Anthropic's
`claude-sonnet-4-6` → `anthropic/claude-sonnet-4.6` (dashes in the version
become dots). A system default on some other compatible endpoint, or a mock,
has slugs that mean nothing to OpenRouter, so those fall back to
`OPENROUTER_DEFAULT_MODEL`.

**A key with no credit is kept.** A brand-new OpenRouter account has no
balance, so the first validation call often fails with a 402. That is the
user's to top up, not a reason to throw away a key just minted for them — doing
so would mint another on every retry. `keepIfUnfunded` keeps it, the app says
"Connected. Add credit at openrouter.ai/credits", and the bot's existing
out-of-credit path (ADR 0044) takes over if a turn runs before they do. Every
other failure (rejected key, model that does not exist) is **not** kept, and an
existing key is left exactly as it was.

**Honest messages for OpenRouter.** OpenRouter rides the `openai` provider with
a base URL, so a dead key used to tell the user their *OpenAI* key was out of
credit and link platform.openai.com. `byokFailureMessage` now takes the base
URL and names OpenRouter and its credits page; a `402` and "insufficient
credits" now classify as credit.

**Chat.** `connect_openrouter` (personal-only) returns a link card and nothing
else — it says only that the link is ready, never that the key is connected,
because the key exists when the user finishes in the browser. The pasted-key
form has no chat equivalent on purpose: asking someone to type an API key into
a chat is exactly what this replaces.

## Not verified against live OpenRouter

No OpenRouter account was used; the flow is built from their published docs and
driven by tests with the HTTP call stubbed. Three things need a real run:
- The docs disagree on whether the exchange needs an `Authorization` header
  (the PKCE guide sends none; the API reference shows a bearer). We send none —
  a user's one-time code has no bearer to present.
- Whether `callback_url` accepts our https address with a path parameter (it
  should; this is the documented shape) and the localhost form used in dev.
- That a native build's `chord://settings` return closes the in-app browser; the
  Stripe checkout return uses the same mechanism and is the model for it.

## Alternatives rejected

- **Exchange in the app.** Puts the key in client memory and needs the verifier
  on the device for no benefit; the server has to hold the key anyway.
- **Pasted key only, with a nicer help link.** Still the copy-and-paste a
  non-technical family member will not do.
- **Discarding an unfunded key.** Mints a new key per retry and leaves a trail
  of dead keys in the user's OpenRouter account.
- **Taking `returnTo` from the request.** An open redirect on an unauthenticated
  endpoint; the platform enum carries everything the server needs.
- **A default model of Chord's choosing.** The owner's rule is "the same as the
  app unless the user edits it"; a separate default would silently change what
  the user's own money buys.
- **A referral or revenue share.** Nothing in OpenRouter's docs offered one; none
  is assumed.

## Consequences

- `describeSystemLlm` moved out of the settings route into
  `services/llm/system-llm.ts` so the connect flow can read it.
- Needs `WEB_ORIGIN` (already required for Stripe returns); without it the start
  route answers 503 and the chat tool says to paste a key instead.
- Switching from a Gemini or Anthropic key to OpenRouter replaces it; the form
  already behaved that way for pasted keys.
