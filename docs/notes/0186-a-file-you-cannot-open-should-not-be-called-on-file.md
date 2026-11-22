# 0186 — A file you cannot open should not be called "on file"

**Status**: accepted — implemented (uncommitted, worktree `insurance-cards-file-link-bug`)
**Date**: 2026-09-18

## Context

Prod (`ownertest@gmail.com`): "Do you have my insurance cards?" got "Yes, I
have your insurance cards on file for Alice Stone, John Doe, Ben
Doe, and Nolan Doe, including Delta Dental and NYSHIP details." — a
confident, specific answer with nothing in the reply to tap. Traced to two
composed defects, plus a related gap found in passing (storage grows
forever).

**Defect 1 — the two attachments are actually gone.** `insurance card
front.jpeg` / `insurance card back.jpeg` (uploaded 2026-05-16) both carry
`blob_missing_at = 2026-09-10T01:32:41Z` — the physical files are gone
from the server's disk. Not isolated: 3 other attachments (2 PAN cards, a
photo) share the exact same missing-timestamp to the second, and all 5 are
from the same account's earliest uploads (May 16–18) — a single discovery
event hitting an old batch, not five unrelated failures. `blob_missing_at`
(ADR 0037, migration 033) is stamped **only** by the download route
(`routes/files.ts`) on a 404, never by a scheduled sweep — there is no
"cadence" for file expiration anywhere in this codebase (`docs/ops/storage.md`
documents `data/` as meant to persist indefinitely). This reads as a
one-time operational data-loss incident, not a policy; not itself fixed
here (nothing on disk to recover), but worth stating plainly since the
question "what's the expiry cadence" implied one already existed.

**Defect 2 — the bot never knew, and never had anything to attach.** Two
separate code paths touch files. `send_file` (ADR 0036, `executor.ts`)
correctly checks `att.blobMissing` and refuses cleanly. But the path that
actually answered this question — `attachmentBlock` (`context.ts`), which
inlines a keyword-matched file's `extracted_text`/summary so the model can
answer content questions directly (ADR 0021/0006) — **never selected
`blob_missing_at` at all** (`retrieval.ts`'s `AttachmentRow`/
`RetrievedAttachment`). The model was shown OCR'd insurance-card text
captured at upload time, with zero signal that the source image is now
unrecoverable, and answered faithfully from what it was given. It also
correctly followed its own instruction never to fabricate a file link —
but the instruction only covered explicit "send me the file" requests, so
a plain "do you have X" got a description and no path to anything, healthy
or not: `attachmentBlock` never attaches a card the way `search`
(`buildSearchCards`) or `send_file` (a real posted message) do.

**Found in passing — nothing ever expires.** Checked whether a retention
policy already existed before answering "what's the cadence": it doesn't.
`data/` is documented as permanent, and `blob_missing_at` is reactive-only.
Meanwhile ADR 0071's email-attachment auto-import pipeline pulls in
*everything* from a synced mailbox — the useful PDF alongside a property
manager's letterhead logo or a retailer's coupon banner — and by design
(ADR 0149's "answering, not managing") nothing in Chord ever deletes a
Chord row on its own initiative. Owner call: a **direct** upload (chat,
WhatsApp, the mobile picker) is the user's own explicit act of keeping
something and should never expire; an **incidental** email-auto-import
that nobody pinned should, since the pipeline's real value — the
tasks/events/facts it stages (ADR 0074/0088/0132/0158/0160) — is already
durable by the time any sweep would run. The raw file copy is a byproduct,
not the deliverable.

## Decision

**1. Thread `blobMissing` through retrieval into the prompt.**
`RetrievedAttachment`/`AttachmentRow` (`retrieval.ts`) gain a `blobMissing`
field (`blob_missing_at != null`), selected in both `fetchAttachmentsVisibleTo`
and the cross-group fallback query, passed through `toRetrieved`/
`hydrateFulltext` untouched (both already spread the row). `attachmentBlock`
(`context.ts`) renders one line per flagged file — "the ORIGINAL FILE is no
longer stored on the server ... never say the file is 'on file'/available,
never offer to send it" — **before** the normal summary/full-text/excerpt
body, so the model still reads and can answer FROM the content (it's real,
just orphaned from its source) while knowing not to claim it's retrievable.

**2. New `reference_file` bot tool — a card on THIS reply, not a new
message.** `send_file` already exists for "send/give me the file" and
correctly refuses on `blobMissing`; the gap is that confirming a file's
mere *existence* had no tool to call at all. `reference_file(attachmentId)`
runs the identical scope gate as `send_file`/`look_at_attachment`, and on
success returns `{ card: { kind:'action', title: filename, attachmentId,
mimeType } }` — the exact card shape `search`'s file hits already use
(ADR 0059, `buildSearchCards`), attached to the bot's own reply via the
executor's existing `card` → `message_cards` plumbing. No new message is
posted (unlike `send_file`, which is right for an explicit send but would
be a noisy, possibly-unwanted re-post just to answer "do you have X").
`attachmentBlock`'s header now instructs the model to call it whenever it
confirms/answers from a specific named file (skipped for a blob-missing
one, per the note above, and skipped for a vague multi-file answer where
no one file is the point).

**3. New retention sweep for incidental attachments only.**
`expireIncidentalAttachments` (`attachments.service.ts`) deletes rows
where `origin_email_thread_id IS NOT NULL` (ADR 0071's own marker for "this
arrived via the mailbox auto-import pipeline, not a person putting it in
the chat") **and** `pinned = 0` **and** `created_at` older than
`ATTACHMENT_RETENTION_DAYS` (default 45). Reuses the existing
`deleteAttachment` (ADR 0037) rather than a bespoke bulk delete, so the
path-sharing safety (`copyAttachmentToGroup` siblings) and FTS-chunk
cleanup can't drift from the single-row path. Wired into the proactive
tick beside `archiveStaleTasks`/`sweepMailboxes`/`sweepCalendars`
(`proactive.service.ts`). A direct upload has no `origin_email_thread_id`
and is structurally untouched by the WHERE clause — no special-casing
needed, the existing schema already draws this line. Pinning
(`setAttachmentPinned`, already shipped) is the one way to promote an
incidental import to permanent, same signal a person already has for "keep
this."

## Alternatives considered

- **Fix only the honesty gap, leave retrieval blind to `blobMissing`** —
  rejected: the model would keep confidently citing content from files it
  has no way to know are gone, on every future accidental loss, not just
  this one.
- **Have `attachmentBlock` silently drop a blob-missing file from context
  instead of flagging it** — rejected: the extracted text is still a real,
  useful fact (what the insurance cards said), and dropping it entirely
  would make the bot claim to know nothing about something it can still
  answer from — a worse failure than the one being fixed.
- **Repurpose `send_file` instead of a new `reference_file` tool** —
  rejected: `send_file`'s job is genuinely different (post the actual
  bytes as a new message) and right for an explicit request; making it
  also silently double as "just attach a card" conflates two behaviors a
  future reader would have to disentangle from one description, and a
  card-only confirmation is deliberately quieter (no new message) for the
  much more common "do you have X" phrasing.
- **A smarter "is this decorative" classifier** (skip only logos/coupon
  banners, keep every other email-imported file forever) — rejected as
  over-engineering for what the owner explicitly asked for: a blunt,
  easy-to-explain line (explicit keep vs. everything else ages out) beats
  a heuristic that would need its own tuning and failure modes, and the
  pipeline's real output (tasks/events/facts) doesn't depend on the raw
  file surviving.
- **Soft-delete (a `deleted_at`/`expired_at` column) instead of a hard
  delete** — considered, following the `trips.deleted_at`/`cancelled_at`
  pattern (ADR 0168/0171). Rejected for this case: those ADRs made
  deletion recoverable because a trip is a record a family actively built;
  an un-pinned coupon banner nobody looked at twice has no comparable
  recovery value, and `deleteAttachment` already exists, is tested, and
  handles the one real hazard (a shared path) — a second delete
  representation here would be a second thing to keep in sync with zero
  demonstrated need.
- **Auto-recover the two already-lost insurance-card files** — not
  possible; the bytes are gone. Out of scope for this ADR, which is about
  the bot's behavior around missing files and about not accumulating more
  incidental clutter going forward, not about restoring what's already lost.

## Consequences

- Zero schema change beyond none needed — `blob_missing_at`,
  `origin_email_thread_id`, and `pinned` all already existed; this reuses
  them. One new env var, `ATTACHMENT_RETENTION_DAYS` (default 45).
- `reference_file` is "mobile only" in the same sense ADR 0059's own file
  search cards are (`attachmentId`-carrying cards render a real tap target
  in the Chord app; a bridged surface like WhatsApp/Telegram shows the
  card as inert text) — an existing, known limitation of the mechanism
  being reused here, not a new regression.
- The retention sweep is a real, if rare, deletion. Anything a family
  cares about past the 45-day default needs a pin — worth restating
  plainly since it's the one part of this change that removes data rather
  than only changing what the bot says.
- Does not, and cannot, restore the two insurance-card images already
  lost — the fix is forward-looking (the bot now says so honestly, and
  future incidental imports won't silently pile up forever).
- New tests: `attachment-fulltext.test.ts` (blobMissing renders the
  warning, still inlines the prior text, healthy files get no warning),
  `reference-file.integration.test.ts` (card attached / blob-missing
  refusal / sibling-group refusal / not-found), `attachment-expiry.integration.test.ts`
  (old unpinned import expires; direct upload, pinned import, and
  in-window import all survive).

## Addendum 2026-09-18 — itinerary attachments expire on their OWN date

Owner request: a boarding pass or hotel confirmation shouldn't wait for
`ATTACHMENT_RETENTION_DAYS` (or survive forever, if directly uploaded) —
once the trip it belongs to is actually over, it has no more reason to sit
in storage than a delivered parcel does (ADR 0135's `dropArrivedDeliveries`,
applied here to the source file instead of a derived tile fact).

New `expireExpiredItineraryAttachments` (`attachments.service.ts`), wired
into the same proactive tick, keyed on `travel_legs.source_doc_id` /
`accommodations.source_doc_id` — the attachment id `classifyAndAutoFileAttachment`
(ADR 0158) already stamps onto the leg/stay it produced. Deliberately a
**second, separate sweep** rather than folded into `expireIncidentalAttachments`,
because the eligibility test is genuinely different:

- **Date-driven, not age-driven.** An attachment expires
  `ATTACHMENT_ITINERARY_GRACE_DAYS` (default 7) after the LATEST leg
  arrival / stay checkout that references it — not a fixed window from
  upload.
- **Applies regardless of upload origin.** Unlike the incidental-import
  sweep (email-only, ADR 0071), a boarding pass a person screenshotted and
  uploaded directly is just as done once the flight lands — most itinerary
  documents in practice ARE direct uploads, so scoping this to
  `origin_email_thread_id` would have covered almost nothing.
- **A round-trip survives on its later leg.** One itinerary PDF often
  backs two legs (outbound + return); the query requires EVERY leg/stay
  referencing the attachment to be past grace before it's eligible, so a
  landed outbound leg doesn't delete a return-flight boarding pass still
  needed.
- **A user-deleted trip (ADR 0171) doesn't get to keep its attachment
  around on a technicality.** A leg/stay whose trip has `deleted_at` set
  no longer counts as "still needed" even if its date is in the future —
  the user already said they don't want the trip.
- **Pinning still exempts a row indefinitely** — the same universal
  escape hatch as every other sweep in this ADR.

New tests appended to `attachment-expiry.integration.test.ts`: single leg
past grace expires; a round-trip with one future leg survives; a pinned
itinerary attachment survives however old; a hotel stay past checkout+grace
expires, a future one survives; a deleted trip's future-dated leg still
expires; an attachment with no trip link is untouched by this sweep.

Rejected: folding into `expireIncidentalAttachments` (conflates two
different eligibility tests — age-since-upload vs. date-since-travel —
behind one function, and would have needed an opt-out for direct uploads
that the incidental sweep specifically exists to protect); expiring on the
EARLIEST leg instead of the latest (deletes a round-trip's return leg
data while it's still needed); no grace period at all (the exact instant
a flight lands is a bad time to lose the boarding pass — connections
misconnect, delays happen).
