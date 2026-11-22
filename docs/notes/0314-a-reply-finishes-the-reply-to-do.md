# 0314 — A reply finishes the "reply to …" to-do

**Status**: accepted
**Date**: 2026-10-30

## Context

The email suggestion pass turns "when are you free for coffee?" into a to-do,
"Reply to Sarah with times that work for coffee" (ADR 0132 / the magics
prompt). Replying to Sarah did nothing to it. The only thing that touched a
thread's suggestions was deleting the mail (ADR 0073 / 0143). So:

- a **pending card** stayed in Action Items for its 72h and then expired, and
  ADR 0134 counts an expired card as "still owed", so the footer said a reply
  was owed after it had been sent;
- a **confirmed reply to-do** stayed open. It usually has no due date, and ADR
  0092 never auto-archives an undated to-do, so it stayed until ticked by hand;
- the thread's **`reply_needed` badge** (ADR 0086) stayed until the classifier
  happened to judge the thread again, and it could judge it the same way.

## Decision

**A to-do that IS a reply to the email's sender is done once the user replies
in that thread.** Only that to-do: a reply does not return a permission slip,
pay a bill or text a third person, so the thread's other to-dos and cards stay.

- **Marked when staged, not guessed later.** The extractor returns
  `"reply": true` on such a task; staging also treats a title starting "Reply",
  "Respond" or "Write back" as one, in case the flag is left out. The card's
  `create_task` args carry `closesOnReply` (hidden from the model's schema,
  `INTERNAL_TOOL_FIELDS`), and a confirm writes `tasks.closes_on_reply = 1`
  (migration `134`; honoured only for a `gmail:` provenance).
- **Seen in `recomputeThread`**, which every provider's sync and every Chord
  send passes through, so a reply sent from Gmail, Outlook or a phone's mail
  app counts the same as one sent from Chord (`email/reply-todos.ts`).
- **What counts as answered** (`answeredSince`): the ask is the newest message
  from someone else on or before the to-do was made; a reply is a sent message
  after it (drafts and trashed messages ignored, compared as instants). A reply
  to an earlier question, followed by a new one, does not answer the new one.
- **Pending card → `expired`**, as ADR 0073 withdraws a deleted thread's cards.
  **Open or active to-do → `done`**, not archived: unlike ADR 0143, the user
  did exactly what it asked, so it is a completion (ADR 0092's signal).
- **No card for an ask already answered.** Staging skips a reply to-do when the
  user already replied after the latest ask (a backfill of handled mail).
- **The badge follows the thread.** When the newest live message is the user's
  own, `reply_needed` becomes `other` in `recomputeThread`, and classifier ingest
  cannot write `reply_needed` back onto such a thread (`newestIsSentSql`).

Any reply counts, even "I'll get back to you": Chord cannot judge whether a
reply was a full answer, and a to-do left open after replying is the worse
mistake. A user who wants it back reopens it.

No bot tool: this adds no new way to change anything; replying (`reply_to_email`)
already exists and now finishes the to-do too.

## Consequences

- To-dos confirmed before this change have no mark and are not closed by a
  reply. No backfill: a title test over old rows would be a guess about rows
  nobody marked.
- A reply that only exists outside Chord is seen at the next sync of that
  mailbox's Sent mail (ADR 0116/0144), not instantly.

## Rejected

- **Matching on the title alone, at close time.** Fragile, and it would close
  "Respond to the survey form" on a reply. The title test is only a fallback
  when the model leaves the flag out, applied once at staging.
- **Closing every to-do from the thread.** A reply does not finish a form or a
  payment.
- **Archiving instead of done.** The user did it; archiving is for giving up.
- **Clearing the badge only in the app.** The briefing, filters and search read
  the stored `action`.

## Addendum 2026-10-31: cards made before the mark close too

The first day in prod proved the "no backfill" consequence wrong. A user
replied to Irene and the card "Reply to Irene with times that work
for a 10-15 mins call next week" stayed: it was staged the afternoon before
the mark existed, so it carried no `closesOnReply`, and closing read only the
mark.

Closing now applies the same title test staging applies (`REPLY_TITLE`, moved
to `reply-todos.ts` so both import one rule): a pending card or open to-do
from the thread closes on a reply if it is marked OR its title starts "Reply",
"Respond" or "Write back". Staging already marks every such title, so for new
cards this matches nothing the mark did not; it only reaches older rows. The
first item under Rejected no longer holds as written: the title is read at
close too, under the same rule, and "Respond to the survey form" closing on a
reply is the accepted edge it always was at staging.
