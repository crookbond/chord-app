# 0139 — A link is a button, but only when it is the only one

**Status**: accepted
**Date**: 2026-08-27
**Relation**: corrects a stale constraint in [0053](./0053-whatsapp-twilio-connector.md) §7's
renderer, made obsolete by [0090](./0090-whatsapp-cloud-api-direct.md)'s move off Twilio;
applies [0107](./0107-chord-reads-and-answers-gmail-manages.md)'s rule that a thing we do
not really do must not be reported as done; the link it carries is
[0138](./0138-a-flight-we-cannot-name-gets-no-link.md)'s.

## Context

ADR 0138 gave a flight number a FlightAware URL and put it on a `BotCard`,
because a URL in the bot's prose is dead text. On WhatsApp that card arrived as
a bare URL appended to the message body — tappable, since WhatsApp linkifies,
but not a button.

The renderer said why, at `whatsapp.renderer.ts`:

> *URL buttons can't be quick-replies (they'd need the CTA content type)*

True when written. It is a **Twilio Content API** constraint: a URL button there
is a separate approved content template, which is why 0053 declined it. ADR 0090
moved production to Meta's Cloud API, where the same thing is one field —
`interactive.type: 'cta_url'` — and needs no template at all. The comment
outlived its reason by a year and nobody went back for it, which is the same
shape as ADR 0116's attachment-import constraint that had quietly stopped being
true.

**Verified rather than assumed**, because the cost of being wrong is a message
that fails to send. Meta documents `cta_url` as a *service message*: free-form,
no pre-approval, deliverable only inside the 24h customer service window — the
identical constraint `sendButtons` already carries. One button per message,
`display_text` capped at 20 characters. There is no documented WABA eligibility
gate, and none applies to us: the number is `CLOUD_API`, quality `GREEN`,
throughput `STANDARD`.

Confirming it needed a real send, because there is no read-only probe — the
token is phone-number-scoped (ADR 0099), so `whatsapp_business_account` still
returns `#100`, and no Graph field enumerates which interactive types a number
may use. One `cta_url` to a live handset returned a `wamid` **and** rendered as
a button. Both halves matter: ADR 0137 is the record of Meta accepting a message
and then failing delivery into a `warn` nobody read.

## Decision

`cta_url` when the turn carries **exactly one URL and no callbacks**. Otherwise
nothing changes.

### Callbacks win

A turn with both a proposal and a link sends quick-replies. `interactive.type`
is a single value, so the two cannot coexist in one message, and the tie breaks
on what is lost either way: a confirm/reject is **only** doable as a button on
WhatsApp, while a URL survives as a linkified bare URL in the text. Promoting
the link would trade a working affordance for a prettier one.

### Two links stay as text

`cta_url` permits one button. Promoting one of several would silently drop the
rest — the ADR 0107 failure, where a thing we did not do reads as done. N links
as text is lossier per link and complete, which is the better trade.

### `text` keeps the URLs

The rendered `text` slot still has the card lines appended, and only the Meta
`ctaUrl.body` omits them. This is load-bearing rather than tidy: the **Twilio**
connector reads `rendered.whatsapp?.quickReply` alone, so a `ctaUrl`-only slot
falls through to `text` there — and stripping the URL to avoid duplication would
delete the link entirely on that path. Same split `quickReply` already used.

Meta-only is therefore a property of the slot, not a flag: Twilio would need the
CTA content template that 0053 declined, and it degrades correctly by doing
nothing.

## Consequences

- A flight link, a signup link and a maps link each become a real button in the
  common case — those turns carry one URL and no proposal.
- **One existing test flipped rather than being deleted.** *"URL action card
  (signup link) degrades to plain text"* asserted the behaviour this ADR
  reverses; it now asserts the button, and still asserts the URL survives in
  `text`. Same treatment ADR 0108 gave its folder test.
- Button label comes from `card.title`, which for `suggest_external_action` is
  the model's `label` — already written to read as a button ("Track UA 512",
  "Open in Maps"). The 20-char clip reuses the existing `clip()` helper.
- Button URLs (`BotActionButton.url`) count toward the "exactly one" test even
  though nothing emits them today. The card type allows them, and a rule that
  only looked at `card.url` would lose a future producer's link silently.
- **Unrelated but found here, and larger than this change**: service messages
  have been free since November 2024 and Meta begins charging for them on
  **1 October 2026**, at utility/authentication rates, to be published by
  1 September. That prices *every* WhatsApp bot reply Chord sends — the ADR 0053
  taster allowance and the ADR 0089 briefing path both need re-costing against
  it. Noted, not addressed.

## Alternatives rejected

- **Replace the text fallback wholesale.** Every turn with any URL becomes a
  button. Loses every link after the first, on exactly the turns that carry
  several.
- **Promote the first of N and drop the rest.** The same loss, chosen
  deliberately rather than by accident, and invisible to the sender.
- **Strip the URL from `text` when a button is sent.** Removes the duplication
  and breaks Twilio, where `text` is the only path.
- **Build the Twilio CTA content template too.** A second approved template to
  maintain for a provider that is now the local-dev path only (ADR 0090).
- **Use `cta_url`'s optional header/footer.** More surface, no question
  answered; the body already says what the link is for.
- **Trust the docs and skip the live send.** The docs were right, and ADR 0137
  is the counter-example: accepted is not delivered, and only a handset shows
  the difference.
