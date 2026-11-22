# ADR 0090 — Talk to WhatsApp directly, not through Twilio

- **Status:** Accepted
- **Date:** 2026-08-20
- **Extends:** ADR 0053 (WhatsApp via Twilio), ADR 0089 (session window)

## Context

Chord's WhatsApp connector goes through Twilio as a Business Solution
Provider. Production has not sent a successful WhatsApp message since
2026-07-21: every outbound fails with Twilio error **63007**, "no channel for
that From". The configured sender `+15555550142` was never registered — the
only sender on the account is the sandbox, OFFLINE, with an empty `waba_id`.

Registering it kept failing in Twilio's console with an unhelpful "Oops,
something went wrong". Two causes surfaced, in order:

1. Meta Business verification was incomplete. That cleared on 2026-08-20 and
   **changed nothing** — the sender still would not register.
2. The number is **already attached to a WABA**. A phone number can belong to
   exactly one WhatsApp Business Account at a time, so Twilio's Embedded Signup
   cannot claim it. That conflict is what the generic error was hiding.

Which reframes the choice. Registering via Twilio means first *removing* the
number from the WABA it already works on — deliberately dismantling a working
setup, accepting a release cooldown, and taking anything else on that WABA down
with it. Meanwhile the Cloud API talks to that same WABA directly, with no
migration at all.

## Decision

**Add a first-party Meta Cloud API connector behind a `WHATSAPP_PROVIDER`
seam, and keep the Twilio one.**

Not a replacement. `WHATSAPP_PROVIDER=twilio` (the default) keeps existing
deployments and the documented sandbox dev path working; `cloud` selects the
new connector. This mirrors how every other vendor in the codebase is handled —
`LLM_PROVIDER`, `GMAIL_PROVIDER`, `OUTLOOK_PROVIDER`, `PHONE_VERIFY_PROVIDER`.
Twilio's sandbox needs no Meta approval and remains the cheapest way to develop
locally, so deleting it would cost more than it saves.

Everything above the connector is untouched. The ADR 0089 session-window gate,
the `n+`/`n-` callback verbs, the renderers, and the length caps are all
provider-agnostic and carry over as-is.

### Channel ids are normalised to Twilio's shape

The Cloud API identifies a user by `wa_id` — `13475550100`, no `+`, no prefix.
Twilio uses `whatsapp:+13475550100`, and that string is already persisted in
`group_external_channels`, `external_identities`, and the ADR 0089 session-window
rows. So the Cloud connector **normalises inbound `wa_id` to Twilio's format**
and strips it again on the way out.

That is a deliberate coupling to a competitor's formatting, and it is worth it:
it means a user already bound over Twilio keeps their binding, their personal
group, and their briefing when the deployment switches providers. The
alternative — a migration rewriting every stored channel id — buys a tidier
string and risks orphaning live users.

### In-session buttons stop needing pre-approval

Twilio required a `twilio/quick-reply` **Content template** for every button
count (`TWILIO_QUICK_REPLY_SID_2` / `_3`) even inside the 24h window. The Cloud
API sends `type: interactive` free-form within the window, so proposal
confirm/reject buttons work with **no template and no approval**. Only the ADR
0089 out-of-window nudge still needs an approved template, referenced by
**name** rather than by SID.

### Webhooks

Meta's contract differs from Twilio's on every axis, so none of the parsing is
shared:

- **GET challenge.** Meta verifies a webhook subscription with a GET carrying
  `hub.mode` / `hub.verify_token` / `hub.challenge`, and expects the challenge
  echoed as **plain text**. The router only registered POST, and its existing
  challenge path replies with `res.json` — which would return `"123"` *with
  quotes* and fail verification. Both are fixed: a GET route, and a `text` field
  on `VerificationChallenge` that sends `text/plain`.
- **Signature.** `X-Hub-Signature-256`, HMAC-SHA256 of the raw body under the
  app secret, compared with a timing-safe equal. Verified against `req.rawBody`
  — re-serialising the parsed JSON reorders keys and breaks the HMAC.
- **Batching.** One notification can carry several messages. `parseInbound`
  returns a single message, so a batch would silently drop all but one. Rather
  than lose user messages, the `Connector` interface gains an optional
  `parseInboundBatch`; the route prefers it and falls back to `parseInbound`.
- **Status callbacks.** Delivery receipts arrive on the same webhook as
  `statuses` rather than `messages`. They are ignored explicitly — parsed as
  messages they would post delivery noise into the user's chat.

## Consequences

**Two WhatsApp connectors to keep working.** The seam means a bug fixed in one
is not fixed in the other. Accepted because the Twilio path is the local-dev
story and its sandbox is genuinely useful; if that stops being true, deleting it
is a small change.

**The `morning_nudge` template is the wrong type either way.** It exists on the
Twilio account as `twilio/text` — one variable, no buttons — so it cannot
satisfy ADR 0089's Yes/No contract on either provider. A quick-reply template
still has to be authored and approved, now in WhatsApp Manager.

**Meta credentials are a new class of secret.** A System User token is
long-lived and grants send rights on the WABA. It lives in the environment
alongside the existing provider keys and is never logged.

**Twilio is not fully removed.** `phone/otp.ts` uses Twilio **Verify** for SMS
OTP (ADR 0064), an unrelated product, and keeps working regardless of
`WHATSAPP_PROVIDER`.

## Alternatives considered

**Free the number and register through Twilio.** Requires removing it from its
current WABA, tolerating a cooldown, and reattaching through the flow that has
been failing — to end up with a middleman taking a per-message margin on a
service Meta offers directly. Rejected.

**Replace Twilio outright.** Simpler to reason about, one code path, no seam.
Rejected because the Twilio sandbox is the only WhatsApp surface that works
locally with no Meta approval, and the ADR 0053 setup docs depend on it.

**Normalise channel ids to Meta's `wa_id`.** Cleaner in isolation, but requires
migrating every persisted channel id and identity row, and any miss orphans a
live user's binding. Rejected in favour of formatting on the connector edge.
