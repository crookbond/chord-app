# 0071 — Email attachments feed the knowledge base

**Status**: accepted
**Date**: 2026-07-15

## Context

The knowledge base already learns from Chord-uploaded attachments: `saveFile`
runs text extraction (plain text, PDF via pdfjs), LLM summaries + answerable
questions (ADR 0021), image tags, and Postgres FTS indexing; the bot searches
them (ADR 0059) and injects summaries into context. But documents that arrive
**by email** — school schedules, itineraries, statements — never entered that
pipeline, so the assistant was blind to exactly the files families receive
most.

## Decision

After each Gmail sync (`afterSync`), an import pass
(`email/attachment-import.ts`) scans new mirror messages for real attachment
parts and saves each one into the user's **personal group** via the normal
`saveFile` pipeline. No new storage, index, search modality, or UI: the file
shows up in To Do's → Attachments, is FTS-indexed, and the bot can find and
send it like any upload.

Mechanics:

- **Discovery**: `listAttachmentParts` walks the message MIME tree; a part
  counts only when it has both a `filename` and a `body.attachmentId`
  (inline bodies and unnamed parts are skipped). Bodies are fetched `full`
  for at most `EMAIL_ATTACHMENTS_BATCH_SIZE` (default 10) unscanned messages
  per sync tick — the backfill drains gradually instead of spiking.
- **Once per message**: `email_messages.attachments_imported_at` (migration
  027) marks scanned messages — set even on failure so one bad message can't
  wedge the queue (same shape as the magics `magic_processed_at` marker).
- **Filters**: >15 MB skipped; images <20 KB skipped (signature logos);
  duplicate filename+size already in the personal group skipped (forwarded
  copies).
- **Scope = personal group**, not a `user`-scoped attachment row: email is
  1:1 owner-private (ADR 0063's privacy model), and the personal group is
  what every existing surface (files tab, ADR 0032 scoping, ADR 0059 search,
  `send_file`) already queries. Sharing stays explicit: the owner re-posts
  the file into a shared chat.
- **Gate**: `EMAIL_ATTACHMENTS_ENABLED`, default **on** — unlike magics
  (off), the pass costs nothing for mail without attachments, and extraction
  cost scales with real documents received.
- **Mock parity**: the mock Gmail mailbox seeds one attachment
  (`UA512-itinerary.txt` on the flight email) + `getAttachment`, so the whole
  path runs in tests/demos without Google.

## Alternatives considered

- **`user`-scoped attachment rows** — invisible to the group-scoped read
  paths (files list, retrieval, search); would need parallel plumbing.
- **Import on thread open** (alongside lazy body fetch) — only learns from
  mail the user already opened; the point is the assistant knowing about the
  PDF *before* being asked.
- **Gmail `has:attachment` search query for discovery** — cheaper per tick,
  but a second discovery path to reconcile with the mirror; the bounded
  full-fetch scan is simpler and self-heals.
- **A separate email-attachments store** — duplicates extraction/indexing and
  splits search into two corpora.

## Consequences

- Personal-group storage grows with attachment-bearing mail (bounded by the
  15 MB cap); account deletion (ADR 0043) already tears down personal-group
  attachments.
- Each imported document triggers the standard extraction pass, including one
  LLM summary call — acceptable because volume is attachment-bearing mail
  only, and the batch cap paces the backfill.
- Attachments imported before a user disconnects Gmail remain (they are
  ordinary files the user owns); `disconnectGmail` keeps clearing only the
  mail mirror.

## Addendum 2026-10-29 — no suggestions from an email's pictures

Going through `saveFile` also meant going through its image step, which asks
the model for tasks, events and saves "in this screenshot" and posts a
"📎 I see N tasks" card. That step is for a picture a person posted to act on.
An image copied out of email was never chosen by anyone: in prod, one new
user's USPS Informed Delivery scans of her postal junk mail produced about 70
pending suggestions in a night (college brochures, political mailers, bank and
oil-change offers), none of it through the bulk, coupon or suspect-sender gates
the email's own suggestion pass applies (ADR 0127, 0179, 0294).

`saveFile` now takes `originEmailThreadId`, written on the row at insert (it
was set by a second update after extraction had already run), and extraction
skips the image suggestions when it is set, including the boot retry of an
interrupted import. The file is still extracted, summarised, indexed and
searchable, and the trip filer still runs (a PDF itinerary still becomes a
trip). Every other caller of `saveFile` that is not a person posting already
passes `index: false`.

## Addendum 2026-11-09 - an email's file is filed under the email's rules

The trip filer (`classifyAndAutoFileAttachment`) writes trips and calendar
events directly, with no card, and for a file copied out of email it skipped
every guard the email-BODY path applies to the same email. Found by an audit
of later paths skipping earlier fixes; not seen in prod data yet. Four gaps:

1. **Past dates (ADR 0158 §4).** `stageFlight`/`stageHotel` drop a leg that
   already flew and a stay that already ended. The filer did not, so the
   90-day backfill could file last month's itinerary PDF as a new trip, and a
   school calendar mailed as a PDF filed every date that had gone by.
2. **Dangerous sender (ADR 0294 addendum 2026-10-28).** Only magics and
   person extraction asked `isDangerousSender`, so a phishing "booking" PDF
   (e.g. "Delta Air Lines" from `delta-checkin-alerts.com`) filed a trip.
3. **Trash and archived mail (ADR 0073, 0294 addendum 2026-10-29).** Import
   checked per-message SPAM only.
4. **The mailbox's calendar (ADR 0312).** Flight legs went on their mailbox's
   calendar (`calendarForBooking`); a restaurant, movie or calendar-file event
   from the same mailbox went on the user default.

Now: the import query leaves threads in Trash out (unmarked, so a thread
restored from Trash is imported then) and skips a single trashed message like
a spam one. `saveFile` passes the copy's `originEmailThreadId` to the filer,
which, before any model call, asks `emailCopyFiling`
(`email/attachment-filing-gate.ts`): no filing from Trash, Spam or archived
mail or a dangerous sender, and the mailbox's calendar from
`calendarForBooking` for every event it writes (null = the user default, as
for flights). After classifying, a date before the reader's today
(`isBeforeDay` in `utils/tz.ts`, now also what `stageFlight`/`stageHotel`
use) is dropped: a finished trip or stay files nothing, a trip under way
keeps the legs still ahead (filtered before the trip is made, so no empty
trip), a calendar file keeps its future rows and says nothing if none are
left. An archived email's file is still imported and searchable (search
reaches archived mail, ADR 0108); only the filing is skipped.

**A file a person uploads keeps its old behaviour**, past dates included: the
upload is their request and nobody is being asked, so ADR 0155's rule (do not
ask about a file's past dates) holds without dropping anything. Sharing an
email's file into a group is also a person's act and is not gated.
Rejected: refusing to import a dangerous sender's file at all (the mail itself
stays searchable, so its file does too), and gating archived mail out of the
knowledge base. Test: `attachment-import-filing-guards.integration.test.ts`.
