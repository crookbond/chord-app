# 0163 — A meeting remembers why

**Status**: accepted
**Date**: 2026-09-11
**Relation**: sibling of [0162](./0162-an-event-remembers-what-made-it.md),
not a variant of it. 0162's excerpt only ever looks at the ONE
message/thread that directly triggered `create_event`; this one searches
the user's mailbox broadly for prior correspondence with an invited
attendee — the negotiation that produced a meeting is often a different
thread than whatever chat message told the bot to add it — and is the
first place in the calendar-event surface that spends a genuine, if
narrowly-scoped, LLM call.

## Context

Owner's ask, verbatim: *"search the email for relevant invitee — emails
from other party, that is generally what led to the meeting setup. include
a short summary of that exchange within briefing. e.g. you set up meeting
with Bill Mills on x, to discuss y, z and w."* [0157](./0157-inviting-someone-to-an-event.md)
already resolves a named/emailed invitee and writes `event_attendees`
rows, in `executor.ts`'s `create_event`/`update_event` cases, **after**
the event row already exists (`resolveInvitees` + `addEventAttendees`
run after `createEvent`/`updateEvent`). Nothing downstream of that ever
looked at the user's own mail for what the meeting was actually about.

## Decision

New `server/src/services/events/meeting-context.ts`, hooked in right
after `addEventAttendees` succeeds (not inside `createEvent` — attendee
identity isn't known that early), using the already-resolved
`inviteEmails` directly.

**Search, then decide whether an LLM call is worth it.**
`findCorrespondence` looks in the user's **own** mailbox only
([0065](./0065-deterministic-contact-discovery.md)/[0114](./0114-suggestions-come-from-your-own-mail.md)'s
sender-scoped-only discipline — never a cross-user search), both
directions: `email_threads`/`email_messages` where the attendee is the
sender, or is in `to_emails`/`cc_emails` (jsonb array, matched via
`jsonb_array_elements_text` the way
[0114](./0114-suggestions-come-from-your-own-mail.md)'s recipient
autocomplete already does), windowed to the 60 days before the meeting was
created — "generally what led to the meeting setup" implies recency, not
a person's entire mail history. Capped to the first 3 attendees and the 2
most recent matched messages overall, mirroring
[0088](./0088-email-magics-world-context.md)'s byte-bounded-context
discipline. **No match → return `null`, zero LLM calls spent.** This is
what keeps the feature nearly free in the common case: most calendar
entries carry no attendees at all (a family dinner isn't an "invite"),
and most invitees have no recent correspondence on file.

**One small, dedicated LLM call, only when something was found**: *"Below
is an email exchange with {who}. In 3-8 words, name what it's about — e.g.
'budget, timeline, and staffing'. Reply with ONLY that phrase. If you
cannot tell, reply exactly NONE."* Deterministic parse — `NONE`/empty/over
100 chars → `null`, never a guess. Injectable
(`CorrespondenceSummarizer`) the same way
[0158](./0158-email-body-through-the-trip-classifier.md)'s
`stageEmailTripProposal` injects `TravelClassifier`, so tests pin exact
phrases instead of depending on the mock LLM's keyword regex matching this
module's prompt.

**Computed once, stored, never recomputed at render.** New
`events.meeting_context` column (migration `072`) — a dedicated typed
slot rather than folded into `description`
([0162](./0162-an-event-remembers-what-made-it.md)), matching this
codebase's existing per-fact-column idiom (`delivery_json`/`flight_json`/
`receipt_json` are each their own column). Written by
`buildAndStoreMeetingContext`, called **fire-and-forget**
(`void ….catch(...)`) right beside the existing
`void maybeSyncCalendar(db, actorUserId)` best-effort call in the same
executor case — the context isn't needed until the next briefing, not the
immediate chat reply, and a failed build must never fail the event
creation it's attached to.

**Rendered by folding into the existing scan, not a new section.**
`SCAN_SYSTEM_PROMPT`'s event listing already composes prose ("This week:
…") from a ground-truth context block built by `loadScanContext`
([0088](./0088-email-magics-world-context.md)'s exact mechanism — facts the
model may narrate but must never invent beyond). Extended to append
`(context: …)` to an event's line when `meeting_context` is present, plus
one prompt sentence: work it in naturally when given, say nothing about
why when it's absent. This produces the owner's example as ONE bullet,
composed by the SAME LLM call that already writes "This week", rather
than a second line competing with it.

**Own feature flag**: `MEETING_CONTEXT_ENABLED` (default on), separate
from [0162](./0162-an-event-remembers-what-made-it.md)'s
`EVENT_CONTEXT_EXCERPT_ENABLED` — 0162 is free and deterministic; this one
is a real, if usually-zero, LLM cost surface and deserves its own
kill-switch.

**Scope**: only wired into the [0157](./0157-inviting-someone-to-an-event.md)
invite path (chat-triggered `create_event`/`update_event` with
`invitees`). Email-magics-created events don't stage `invitees` today, so
this doesn't yet apply there.

## Rejected

- **Running the search+summarize inside the SCAN loop itself**, as a tool
  call the daily-briefing model could invoke. Cost and latency scale with
  however many meetings are on the radar on any given morning, and breaks
  the "compute once at creation, render from storage" discipline every
  other fact-extraction ADR here follows
  ([0135](./0135-a-shipping-update-says-when.md),
  [0138](./0138-a-flight-we-cannot-name-gets-no-link.md),
  [0160](./0160-a-receipt-is-settled-not-owed.md)).
- **Folding the phrase into `description` instead of a dedicated
  column.** Loses it as a distinctly renderable fact — the scan prompt
  needs to find it without parsing prose, and a future UI wants to show
  "why" separately from "what led to this."
- **One LLM call per attendee.** The plan is one bounded call over
  whatever correspondence was actually found, capped by construction
  (3 attendees × 2 messages), not a call that scales with the guest list.
- **Requiring a display-name-resolved "who"** before prompting. The raw
  email address(es) are enough context for the model to condense a
  subject+excerpt into a phrase; resolving names would need a `people`
  lookup for no real gain here.

## Consequences

- Inviting someone with recent, findable correspondence gets a short
  "what this is about" on the event, surfaced in both the daily briefing's
  "This week" line and the mobile event detail view
  ([0162](./0162-an-event-remembers-what-made-it.md)'s "Why" block).
- The overwhelming majority of events (no attendees, or attendees with no
  mail on file) cost nothing — the LLM call only fires on an actual find.
- Email-magics-created events (no `invitees` staged) don't get a meeting
  context yet; wiring that in is a natural, separate follow-up once
  [0158](./0158-email-body-through-the-trip-classifier.md)-style flows
  start staging invitees too.
