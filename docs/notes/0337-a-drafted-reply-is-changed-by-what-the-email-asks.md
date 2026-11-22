# ADR 0337 — A drafted reply is changed by what the email asks

**Status:** Accepted, 2026-11-13. Amends ADR 0197.

## Context

The suggested-reply ask bar (ADR 0197) has two sets of chips. Before a
draft exists, the chips are chosen for each email by the model (ADR 0197
addendum, `reply-asks.service.ts`). Once a draft exists, the chips were a
fixed four: Shorter, Warmer, More formal, Suggest times, the same on every
email.

The owner wanted more ways to change a draft, naming two: longer, and
answering the email point by point. The ask bar already takes free text,
so "make it longer" worked if typed; the chips are the shortcuts people
actually tap. Adding every possible change as a fixed chip makes a row
nobody reads, and "Suggest times" on a thank-you note is noise.

## Decision

1. **The revise chips are chosen per email, in code, with no model call**
   (`reviseReplyAsks` / `replyShapeOf`, `kernel/src/email-reply-shape.ts`).
   Always offered: Shorter, **Longer** (new), Warmer, More formal. Put in
   front when they fit:
   - **Point by point** when the message being answered (the newest one the
     mailbox did not send) asks two or more things: two or more numbered or
     bulleted items, else two or more real questions (a "How are you?" is
     not one). Quoted history and the signature are left out.
   - **Suggest times** when that message or the subject is about a time, or
     the email's own first-draft chips already offered Suggest times.
   The New message composer answers nothing, so it gets the four style
   chips and Suggest times.

2. **"Point by point" is a shape the writer is given, not a phrase it has
   to interpret.** When the instruction asks for it (`wantsPointByPoint`:
   the chip's text, or typed "point by point", "each question", "one by
   one", "in order", "inline"), `composeReply` reads the points off the
   message being answered with the same parser and lists them, in order, in
   the prompt: answer each one under a short line naming it, keep greeting
   and sign-off, leave `[answer]` where the thread does not give one, never
   invent. With no points found it is told to take each question in turn.

## Consequences

- No new model call, migration, route or setting; nothing new is stored.
- No bot tool: chat already takes "answer her point by point" as free text
  to `reply_to_email`, and nothing here changes anything the user owns.
- The parser is English and punctuation-based; a message that asks things
  without question marks or a list gets no Point by point chip, though
  typing it still works.

## Rejected

- More fixed chips: a longer row on every email, most of it irrelevant.
- Asking the model for the revise chips too: a second call per reply for
  something a parser decides well enough.
- Remembering a per-user default style (always more formal, always longer):
  deferred until people are seen repeating the same tap; it would need a
  `users.defaults` key and a chat tool.
