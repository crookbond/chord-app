# 0013 — `.ics` calendar-invite ingest

**Status**: accepted
**Date**: 2026-04-30
**Builds on**: [ADR 0008](./0008-whatsapp-import.md), [ADR 0012](./0012-proactive-event-scanning.md)

## Context

ADR 0012 committed Chord to scanning the *projection* of `events` and
`trips` rows in the DB, not the user's actual cloud calendar. That
makes the proactive scanner only as good as what Chord has already
been told. Today the only ways events land are:

- bot tool calls during a chat turn,
- WhatsApp chat-export ingest (ADR 0008),
- the mobile Resources → Events composer.

Real users will arrive with a backlog of calendar items already
sitting in Google / Apple Calendar. The shortest path to giving Chord
visibility into that backlog — without committing to OAuth — is:
**parse `.ics` files the user uploads or forwards**. Calendar invites
are routinely emitted as `.ics` attachments, and the user's existing
calendar app exports `.ics` for any event or feed.

This is the lightweight first step. ADR 0014 will tackle Google
Calendar OAuth as the heavier follow-up.

## Decision

### Architecture: same shape as WhatsApp ingest

Add `server/src/services/ingest/ics/` mirroring
`server/src/services/ingest/whatsapp/`. The parse step is deterministic
(no LLM), produces `create_event` tool calls, and runs them through
`applyToolCall` with provenance pointing back to the `.ics` filename
and the originating VEVENT.

The pipeline:

1. User uploads either a single `.ics` file or a `.zip` containing one
   or more `.ics` members (the shape Google Takeout Calendar exports
   produce — one `.ics` per calendar) via the existing mobile document
   picker. A new "Import calendar" button on the groups list, parallel
   to the "Import chat" button. The pipeline detects the format by the
   PK\03\04 zip magic; raw `.ics` files take a single-source path,
   zips fan out across each `.ics` member.
2. Server route `POST /api/v1/ingest/ics` accepts the file, persists
   it as an attachment for provenance, and kicks off async ingest.
3. Parser (`node-ical`) produces an array of normalized VEVENTs.
4. For each VEVENT, the pipeline calls `applyToolCall` with a
   `create_event` whose args carry the title, start time, location,
   and the `external_uid` for dedup.
5. `ingest.progress` / `ingest.done` SSE events broadcast on the
   target group's channel — same pattern WhatsApp ingest established.
6. Bot posts a summary message: "Imported N events from `<filename>`."

### Scope: single events, single instance

- **VEVENT only.** VTODO, VJOURNAL, VFREEBUSY ignored. Tasks already
  have a richer surface in Chord (`create_task`); we won't auto-bridge
  for v1.
- **Recurrence (`RRULE`) ignored.** Only the master VEVENT is
  imported; recurring instances are not expanded. Documented as a
  known gap. Revisit when users complain.
- **No trip extraction.** Multi-day VEVENTs become a single event at
  the start time. The user can wrap the result in a trip via bot
  ("@Chord create a trip from these"). Auto-bundling into a trip is
  conjecture-prone for a generic .ics import.
- **No attendees → RSVPs.** ATTENDEE fields are dropped. Adding RSVPs
  cleanly requires resolving emails to Chord users, which is its own
  problem.
- **No timezone correction.** `node-ical` resolves DTSTART to a JS
  Date; we serialize that as ISO-8601. Server-local time bias matches
  ADR 0012's existing assumption.

### Dedup: `events.external_uid`

Add an `external_uid` column on `events` (nullable, indexed). The
`create_event` executor case accepts an optional `externalUid` arg;
when present, it short-circuits if a row exists in the same group
with that UID. Re-uploads of the same `.ics` become no-ops.

The migration adds the column + index. No backfill — existing rows
have `external_uid = NULL` and will never collide with imports.

This is a tool-call arg, not just a route concern, so future
ingestion paths (Google Calendar OAuth in ADR 0014) reuse the same
dedup contract by passing the cloud event id.

### Demo / web testability

Two affordances, both gated by `DEMO_MODE=1`:

1. **"Import calendar" button on the groups list (mobile + web).**
   Reuses the existing `expo-document-picker`; web users get the
   browser file picker. Posts to `/api/v1/ingest/ics`.
2. **"Run scan now" dev endpoint** — `POST /api/v1/_dev/proactive-scan`.
   When called, immediately queues a `daily_morning_scan` row for the
   authenticated user with `scheduled_for = now()`, so the scheduler
   fires it on the next tick (~15s) instead of waiting until 7am.
   Mobile groups screen gets a small "Run morning scan" button under
   the same `DEMO_MODE` gate.

Together these let a tester verify the full flow on web without
touching a phone: upload `.ics` → see `event.created` SSE + nudges
fire from the event-write hook → click "Run scan now" → see the
morning briefing fire.

## Alternatives considered

- **Wire up the ingest email forwarder.** Each group already has
  `{slug}-{gid}@chord.app`; users could forward calendar invites
  directly. Right idea, but it requires running an inbound mail
  service (or wiring SES / Mailgun webhooks). Real engineering for
  a path .ics-upload already covers. Defer.
- **Use the existing attachment extraction pipeline** (the one that
  reads PDFs and stores `extracted_text`). Tempting because it's
  there. Rejected: that pipeline produces *retrieval text*, not
  entity creations. Mixing modes (some attachments produce events,
  most don't) is more confusing than a parallel ingest path.
- **Use the LLM to extract events from `.ics` text.** The mock
  provider couldn't fake it, and `node-ical` is deterministic and
  free. The LLM adds nothing here.
- **Auto-extract trips from multi-day events.** Producing trip rows
  needs destination, participants, legs — none of which are in a
  vanilla VEVENT. Heuristics would mostly be wrong.
- **Always run through the proposal flow (ADR 0009).** A user
  uploading an invite has already decided they want it on their
  calendar. Adding a confirm step adds friction without a real
  safety win — the dedup by `external_uid` covers the
  "oops re-uploaded" case.

## Consequences

### What this commits us to

- **`events.external_uid`** is a real column, not just an in-memory
  field. ADR 0014's Google Calendar sync will store the cloud event
  id in the same column.
- **`node-ical` becomes a runtime dependency.** Pinned, not abstracted
  behind an interface. If we ever swap parsers, it's a single-file
  change in `services/ingest/ics/parse.ts`.
- **`DEMO_MODE` gates two more behaviors.** Already gates the demo-reset
  endpoint; now also gates the .ics import button visibility (no — the
  button stays visible for everyone, the *demo button* is gated) and
  the `_dev/proactive-scan` route. Production deploys leave
  `DEMO_MODE` off.
- **Provenance points to attachment IDs.** Same shape WhatsApp ingest
  uses; the "Why this entity?" drill-down keeps working without
  changes.

### What we explicitly do NOT do

- **No recurring event expansion.** Users will notice this when
  they import a calendar with weekly soccer practice and only see
  one row. Surface as a known gap; consider expansion in v2 if the
  pain is real.
- **No timezone re-anchoring.** ICS files contain TZID rules; we
  trust `node-ical` to flatten to local time and store ISO-8601.
- **No two-way sync.** Chord-created events are not exported back
  to the originating calendar. Device-calendar push (ADR 0012) is
  separate and one-way.
- **No mail server.** Forward-to-ingest-email stays a docs promise,
  not a feature.

### Things to watch

- **Large feeds.** Soft cap at 10k VEVENTs per ingest job — protects
  against pathological inputs (decades of expanded recurrences) without
  limiting normal users. Real personal calendars run 5–8k events; raise
  the cap if a real user hits it. Multer's 100MB request size cap is
  the hard upper bound.
- **All-day events.** ICS DTSTART can be a date (no time). Treat
  these as 09:00 local on that date for `events.starts_at`. Document.
- **Cancelled events.** ICS `STATUS:CANCELLED` rows are skipped.
- **The "import N events" bot summary** shouldn't trigger N×nudges
  via the event-write hook. ADR 0012's hook fires for any
  `create_event` execution; for ingest paths we should pass a flag
  through `applyToolCall` to suppress per-row nudges and (optionally)
  emit a single batch-summary nudge instead. Track as follow-up;
  shipping without the suppression first is acceptable for the
  demo because users will notice and ask for it.
