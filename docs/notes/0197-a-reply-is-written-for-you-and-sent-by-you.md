# 0197 — A reply is written for you, and sent by you

**Status**: accepted
**Date**: 2026-09-23

## Context

The most common family email is a scheduling ask — "what times work for a
call next week?", "can you do Saturday?" — and answering one means leaving
the thread, opening the calendar, finding the gaps, and typing them back.
The `reply_to_email` bot tool (ADR 0107) can already send a reply from chat,
but the model writes the body there with no view of the user's calendar, and
the reader in the Email tab had no help at all.

Owner request: a non-sendable block inside the reply box where the user types
an instruction ("compose a reply with times that work", "reply saying yes,
ask about parking"); Chord writes the reply into the reply box; the user
reviews it and hits Send.

ADR 0149 gates new mail features on producing or improving a shared family
artifact. This one is admitted on two grounds: answering is explicitly kept
by 0149 as the pipeline's response half, and the thing that makes it more
than a writing assistant is the family calendar — "times that work" is
answered from the user's real busy blocks, which is coordination, not inbox
polish.

## Decision

**The ask is never sent; the reply is never sent by us.**
`POST /me/email/threads/:id/compose` (`EmailComposeReplyRequest`:
`instruction`, optional `draft`) returns `{ body }` and has no side effect on
the mailbox. The client puts `body` into the ordinary reply box, where the
existing Send path (recipients, attachments, signature, draft autosave) takes
over unchanged. The AI block is visibly not part of the message — dashed,
tinted, labelled "this part is never sent" — with one-tap asks (Suggest
times / Say yes / Decline / Thanks) while the reply box is empty.

**A second ask revises.** When the reply box already holds text it rides
along as `draft`, and the prompt says to revise it rather than start over,
so "make it shorter" works on what the user is looking at.

**Availability comes from the calendar, never from the model.**
`composeReply` renders the next 10 days of the user's busy blocks via
`busyIntervalsInWindow` — the same definition of "busy" as `find_conflicts`
and the email-magics availability (free/transparent/info-only calendars
never block) — per local day in the user's zone (`users.last_tz`, falling
back to `BRIEFING_DEFAULT_TZ`), with empty days stated as "nothing
scheduled" so free is distinguishable from unlisted. No calendar connected,
or too many events to list, is said as **unknown**, and the prompt forbids
proposing specific times then (a `[time]` placeholder instead) — a slot that
merely sounds plausible is worse than a blank the user fills.

**The thread is data.** It is fenced in `<email_thread>` and the system
prompt says to ignore instructions inside it; only the user's instruction is
followed. The consequence of a successful injection is bounded anyway: the
output lands in an editable box the user reads before anything is sent.

**Same model, gate and meter as every other AI surface.** `resolveTurnLlm`
picks the model; `getEntitlement` gates when `BILLING_ENABLED` (402 with a
Settings → AI Plan pointer); tokens are written to `token_usage` under a new
source `email_reply` (migration `087` widens the CHECK the way `085` widened
`credit_ledger`'s), which under ADR 0196 is the debit; BYOK records nothing.
A model failure returns one fixed sentence (ADR 0102), or the ADR 0044
fix-your-key message when it is the user's own key that failed.

**Output is cleaned, not trusted to follow format.** A code fence or a
"Subject:" line the model adds anyway is stripped (`cleanComposed`); no
signature is written because the send path appends the Chord-managed one
(ADR 0069).

## Consequences

- Chat parity is the existing `reply_to_email` tool (ADR 0107, propose-mode
  draft card, tap to send), plus a new read-only `get_my_availability` tool
  that returns the SAME rendering (`services/availability.service.ts`, one
  implementation for both surfaces). `reply_to_email`'s description tells
  the model to call it before offering times and to use a `[time]`
  placeholder when it reports `known: false`. Personal 1:1 only, with an
  executor backstop: busy blocks are owner-scoped across every group, so a
  shared group must not read them (ADR 0032).
- Only the reply screen has the block. Compose-new and forward do not — a
  new message has no thread to answer, and a forward's note is rarely the
  hard part.
- The 10-day window is fixed; "the week after next" gets no availability
  past day 10 and the model is told what window it has.

## Addendum — a bot-drafted reply is read whole and edited in the reply box

The `reply_to_email` card in chat clipped the draft to two lines (and the To
Do's row to 120 characters), so a long reply was approved unread. Both now
show every word — the draft is the decision. A reply card also carries an
**Edit** button: it closes the proposal FIRST (rejected), then opens the
email thread with the draft in the reply box (`mobile/src/reply-draft.ts`),
where the ordinary composer, its autosave and the Ask Chord block take over.
Closing first is the point: an edited reply sent from the composer must not
also be sendable from a ✓ on the card still sitting in chat. If the close
fails, nothing opens. The hand-off is in memory; once the thread screen has
it, autosave makes it a normal reply draft that survives a restart.

Chat-drafted replies do not appear in To Do's → Action Items (that tab lists
email-derived suggestions only); the row-level Edit button is there for the
day one does.

## Rejected

- **Sending the composed reply directly** (a "reply for me" button). The
  owner's shape is review-then-send, and an unreviewed AI-sent email in the
  family's name is the failure ADR 0102/0107 keep ruling out.
- **Letting the model call a calendar tool** to find free time. One bounded,
  pre-rendered block costs one call and cannot drift from what
  `find_conflicts` means by busy; a tool loop costs several and can.
- **Always-on suggested replies** generated on thread open. A per-open LLM
  call for mail most people will not answer; the explicit ask spends only
  when someone wants a reply.
- **Folding availability into the reply box as a picker.** A good idea for
  later, but a picker answers only the scheduling case; free text covers
  "say yes and ask about parking" too.

## Addendum 2026-10-28: the chips come from the email

The empty reply box offered the same four chips on every email (Suggest
times, Say yes, Decline, Thanks), which fit almost none of them. Opening the
reply screen with nothing written now asks `POST
/me/email/threads/:id/reply-asks` (`reply-asks.service.ts`) for 2-4 chips
read off this thread ("Yes, I can drive", "Ask where to meet"): label <= 28
characters, `ask` = the instruction the composer gets when tapped. Same
model, gate and meter as the composer (source `email_reply`); the thread is
fenced as data; at most 6,000 characters read; in-memory cache keyed on the
newest message, so reopening is free and a new reply asks again. Output
with no usable chip is a failure, and the app shows the fixed four on any
failure (incl. no plan / no consent). The chips are empty while asking. The
"change it" chips (Shorter, Warmer...) stay fixed: they are about the draft,
not the email. Unlike the rejected always-on suggestion, this spends only
when the user opens Reply, and it is a small call (a few chips, not a
reply). No bot tool: in chat the user just says what to reply.
