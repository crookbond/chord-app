# 0250 — A thread opens at its unread mail

**Status**: accepted
**Date**: 2026-10-15

## Context

The reader opened every thread at the top. Older messages were folded and the
newest unfolded (ADR 0121), but the screen started at the subject. So a new
reply at the bottom of a long thread took scrolling to find, and when several
replies were new, only the newest was open.

## Decision

A thread with unread mail opens at that mail (`threadOpenPlan`, kernel
`email-thread-open.ts`):

- every unread message is unfolded;
- the reader scrolls to the **earliest** unread message, so a run of new
  replies reads in order (Gmail's behaviour);
- with nothing unread, the newest message is unfolded and scrolled to, as
  before;
- if the earliest unread message is the first one, the screen stays at the
  top.

The plan is decided **once per thread, from the state at opening**. Opening a
thread marks it read (the auto mark-read), and the refresh that follows would
otherwise fold the new messages back up. Message positions are remembered as
they lay out, so the scroll happens whether the layout or the plan arrives
first. A tap on a message still outranks the plan.

No server change, and no new capability, so no bot tool.

## Verified

- `thread-open.test.ts`: one new reply at the bottom; two unread replies
  with a read one between them (both open, lands on the first); unread first
  message (stays at the top); nothing unread; a single message; an empty
  thread.
- Mobile typechecks. Not yet checked on a device.

## Rejected

- **Landing on the newest unread message.** With two new replies it skips the
  first, which is the one written earlier.
- **Re-deciding on every refresh.** The auto mark-read would fold the new mail
  away a moment after it opened.

## Addendum 2026-11-10: read message by message

Opening a thread no longer marks the whole thread read. Each message is
marked read when it is open and at least 60px of it (or all of it, if
shorter) is on screen (`messagesOnScreen` / `messagesToMarkRead`,
`kernel/src/email-auto-read.ts`), so reopening a thread and scrolling through
it marks every message, and one never scrolled to stays unread. The request
is `EmailModifyRequest.messageIds` (only with `markRead: true`), applied per
message on every mailbox: Gmail `messages/batchModify`, Outlook per message,
IMAP `\Seen` per UID. A refused per-message write fails for the reader to
retry on the next scroll; it is NOT queued (ADR 0199 holds a thread intent,
and replaying "read" would mark messages nobody saw).

Prod: a reply arrived in an open thread and was never marked read, because
the reader marked the thread once and remembered it had. A message that
arrives after opening now opens (it was not in the plan), and is marked when
it is on screen. "Mark unread" still sticks: every message on the thread at
that moment counts as already sent from this screen.
