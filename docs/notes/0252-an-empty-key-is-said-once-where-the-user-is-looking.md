# 0252 — An empty key is said once, where the user is looking

**Status**: accepted
**Date**: 2026-10-15
**Extends**: ADR 0044 (BYOK key-failure handling), ADR 0042 (proactive reconnect nudge)

## Context

ADR 0044 made a failed chat turn on the user's own key say so ("out of credits,
top up here"). That only reaches someone who happens to chat. Every background
AI pass runs on the same key — email sorting, suggestions, people extraction,
the morning briefing's render — and each one failed with a log line and nothing
else. With BYOK now free (ADR 0251) the key is the only thing between the user
and a silent product: the inbox just stops getting sorted, no suggestions
arrive, and the briefing never comes, with no sign of why until the day they
ask the bot something.

**This was not true when first written** (found the same day, ADR 0257): the
email-suggestion and people extractors, the briefing and attachment indexing
called Chord's own model (`getLlm()`) for everyone, BYOK or not. The rule the
owner set is that a BYOK user's AI work runs on their key, so those call sites
were moved onto it and this ADR is now accurate.

## Decision

- **Record at the one place every call goes through.** `buildByokLlm` hands out
  the user's LLM wrapped in `withKeyHealth`. A call that fails with a credit or
  auth error (the two kinds that are theirs to fix; a rate limit or an outage
  says nothing about their key) writes `users.byok_key_issue` / `_at`; a call
  that works clears it. No pass has to remember to report, and a future one
  cannot forget. Migration `106`.
- **Tell them once, in the 1:1 chat, on the first failure.** The proactive tick
  sweeps recorded outages that have not been told and posts one message — what
  is wrong, what it pauses ("Chord can't sort your email, suggest to-dos from it,
  or write your morning briefing"), and a card that opens Settings → AI model.
  `byok_key_nudged_at` is claimed with an atomic update before anything is
  written, so two ticks or two processes cannot post it twice, and it is cleared
  with the outage so a second outage is told again.
- **A chat reply that already said it claims the outage.** The bot turn's
  failure message (ADR 0044) marks the outage told; the sweep waits 45 seconds
  before nudging so that claim wins the race and the user is not told twice.
- **Show it where the missing suggestions would be.** `EmailStatus.aiKeyIssue`
  drives a banner above the to-dos on the Email tab (Add credits to your key / Update key),
  and `BillingStatus.byokKeyIssue` puts the same sentence in Settings → AI model,
  opening that section. Both are read from the recorded state, so they are there
  the moment the key is bad and gone the moment it works or is replaced.
- **Fixing it clears it.** Saving a key (Settings or the OpenRouter connect)
  resets the state; one kept with no credit is recorded as an outage but marked
  told, since the connect flow just explained it.
- **Wording is the provider's, and there is a way off the key.** The button says "Add credits to your key" so it is plain the top-up is the user's own account with their provider, not a Chord charge (the link goes to the provider; Chord sells nothing there). The nudge and the banner always offer the other way out, whichever exists on the deploy (`ByokKeyIssue.fallback`): where Chord sells plans (`BILLING_ENABLED`), "Use a Chord plan instead" → Settings → AI Plan, and on the plan card a BYOK user with an outage can drop their key (confirmed) so a plan applies, since a key that is present always wins over a plan; where billing is off, "Use Chord's AI instead" → Settings → AI model, where removing the key hands the turn back to Chord's own, free, model. A deploy with neither offers only the key.

The nudge is an ordinary proactive message (`proactive_kind: byok_key_issue`),
not the briefing: it is skipped out of WhatsApp's window rather than spending the
briefing's template (ADR 0137), and a push respects quiet hours.

## Consequences

- No new bot tool: this is a notification and a status line, not a new way to
  change anything. `get_billing_status` carries `byokKeyIssue` because it shares
  the assembler with Settings.
- A key that fails for a reason we do not classify (a typo'd model name, an
  outage) is still silent in the background; only credit and auth are flagged,
  deliberately, so the banner never cries wolf.
- Only chat and email are covered by a surface. A user who never opens either
  still learns from the chat nudge (and its push).

## Rejected

- **A nudge per failing pass or per day.** One message per outage; the banner and
  Settings are the standing reminder.
- **Recording in each pass's catch block.** About eight call sites, each a
  chance to be forgotten (the ADR 0137 lesson); the wrapper is one.
- **Probing the key on a timer.** The user's own provider would be billed a call
  per user per interval to learn what the next real call reports for free.
- **Falling back to the system key meanwhile.** ADR 0044 already rejected it:
  it silently moves the cost onto Chord.
