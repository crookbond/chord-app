# 0161 — A briefing can be told what to skip

**Status**: accepted
**Date**: 2026-09-11
**Relation**: modeled on [0077](./0077-user-declared-email-routing.md)'s
`email_routing_rules` (same table shape, same deterministic-before-anything-
runs posture), but with no target — a hit here means "leave this out of
[0072](./0072-unified-calendar-settings-and-one-briefing.md)'s email
section", never a route. Touches only `digest.service.ts`, the surface
[0149](./0149-the-mail-surface-is-bounded-to-coordination.md) already
sanctions as lane #3.

## Context

Verified against prod (ownertest@gmail.com): 17–19 `notifications@rippling.com`
"🎉 Happy Birthday, X!" / "🎉 Happy Work Anniversary, X!" threads over the
last month — about one every 1–2 days, classified `informational` under
`Social & professional`, and inconsistently flagged `bulk`/`bulk_inferred`
(so [0127](./0127-a-gate-needs-two-signals-agreeing.md)'s bulk gate doesn't
reliably catch them — a birthday notice to one recipient rarely carries
`List-Unsubscribe`). Tracing the pipeline: the LLM-authored "Conflicts/This
week/Heads-up" section of the daily scan never touches email at all
(`SCAN_SYSTEM_PROMPT` reads only calendar/tasks/trips/important-days). The
**only** place email reaches the briefing is `digest.service.ts`'s fully
deterministic "Worth a look" list — up to 5 unread threads from any category
except a hardcoded `LOW_SIGNAL_ROOTS` set (`newsletters`, `coupons`,
`deliveries`, `receipts`). `Social & professional` isn't in that set, so
every Rippling greeting's subject line surfaced there, day after day. There
was no way for a user to say "don't show me mail from X" — the closest
existing mechanism, `email_routing_rules`, only routes mail *to* a group; it
has no "exclude" concept.

## Decision

New `email_briefing_rules` table (migration `071`), four kinds:
`sender_domain`, `sender_email` (finer than domain), `category`
(substring of the classifier's assigned category title, same forgiving
match as `email_routing_rules`'s `category` kind), and `subject_keyword`
(substring of the subject, for a topic that isn't sender- or
category-shaped — "the PTA fundraiser"). `matchBriefingRule` is a pure
function pinned by a table of cases, mirroring
[0127](./0127-a-gate-needs-two-signals-agreeing.md)'s
`isMinable`/`minablePredicate` split.

**Free text resolves to a rule deterministically, no LLM**
(`resolveBriefingPattern`): an `@` → `sender_email`; a dotted no-space
token → `sender_domain` (mirrors `inferRuleKind`); else a check against
[0152](./0152-email-search-trusts-the-classifier-on-a-category-match.md)'s
`resolveCategoryMatch` (already built) → `category`; else a sender-name
search over the user's **own** mail only
([0065](./0065-deterministic-contact-discovery.md)/[0114](./0114-suggestions-come-from-your-own-mail.md)'s
sender-scoped-only discipline) — exactly one matching domain auto-resolves,
more than one returns `candidates` (the same ambiguous-match shape
`set_email_route` already uses, so the bot asks and the user picks), none
falls through to `subject_keyword`. This is what lets "don't show me
Rippling" work without the user ever typing a domain.

**Scoped to what's rendered, not to the extraction passes**
(magics/person-extraction/attachment-import) — an owner decision: excluded
mail is still classified/mined exactly as before; the rule only changes
what `digest.service.ts` shows. `buildEmailDigestBody` filters `unreadRows`
(in addition to the existing `LOW_SIGNAL_ROOTS` check) and, separately,
resolves each pending suggestion's `gmail:<threadId>` provenance back to
its thread to filter `pendingSuggestionsForUser`'s results the same way —
without widening `EmailMagicSuggestion` (a wire type shared with the
client) just for this one caller. The closing count line gets its own
exclusion-aware recount (`unreadCountExcluding`) so the briefing doesn't
say "23 unread" immediately after hiding some of them — but the
app-wide unread badge/tile counts (`classification.service.ts`'s
`getTiles`/`unreadCount`, used by the Email tab) are untouched; this is a
briefing preference, not a mailbox-wide filter.

**Chat-only interface** (owner decision, not a Settings screen): one tool,
`set_briefing_exclusion` (`pattern`, optional `remove`) — no `kind`
parameter, the model never picks one, `resolveBriefingPattern` always
does — plus read-only `list_briefing_exclusions`. Both join
`PERSONAL_ONLY_TOOL_NAMES` (same rule as `set_email_route`/
`set_weather_location`: a shared group has no business seeing or changing
another member's briefing). This gives the "back and forth" the user asked
for for free: state intent in the personal 1:1, the tool resolves or
returns `candidates`, the model asks and retries — the same mechanism
[0148](./0148-a-stale-weather-location-should-ask.md) already established
and explicitly chose over new answering machinery.

## Rejected

- **Also gating the extraction passes** (magics/person-extraction/
  attachment-import) on these rules. A separate, larger-blast-radius
  decision the owner didn't ask for — and moot today anyway, since a
  Rippling-style `informational` thread never generates a proposal in the
  first place.
- **LLM-interpreted "about X" matching.** A literal subject substring is
  enough for what users actually type ("birthday", "the PTA fundraiser")
  and stays testable/deterministic, matching
  [0085](./0085-one-search-matching-rule.md)/[0127](./0127-a-gate-needs-two-signals-agreeing.md)'s
  standing preference for determinism over model judgment on a rule that
  fires on every briefing.
- **A Settings list+delete editor now.** `list_briefing_exclusions`
  answers "what have I hidden" from chat; a dedicated screen (mirroring
  [0123](./0123-a-rule-says-where-mail-goes.md)'s routing-rules editor) is
  a natural follow-up if it's actually missed, not built speculatively.
- **Per-thread mute.** Too fine-grained for what users actually ask for
  ("stop showing me Rippling", not "hide this one email") and would need
  its own UI surface with no chat-tool equivalent.

## Consequences

- A user can now say "don't show me emails from rippling.com in my
  briefing" (or a company name, or a topic) in their personal 1:1 and have
  it take effect on the next briefing, with no code change and no waiting
  on Settings work.
- The rule is purely a display filter — nothing about classification,
  extraction, or the Email tab's own unread counts changes.
- Discovering existing rules or removing one requires asking the bot
  ("what have I hidden from my briefing") rather than a Settings screen —
  acceptable for a chat-first feature per the owner's decision, revisit if
  users reach for a screen that isn't there.
