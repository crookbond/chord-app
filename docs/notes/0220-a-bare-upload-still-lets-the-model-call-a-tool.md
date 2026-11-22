# 0220 — A bare upload still let the model call a tool

**Status**: accepted
**Date**: 2026-10-01

## Context

Prod (`ownertest@gmail.com`, WhatsApp): an event-invitation photo sent with no
caption. The deterministic attachment auto-filer (ADR 0071/0158's sibling for
chat-uploaded images) correctly read the invitation and created the calendar
event — `e_RxDQFAd5uheR`, "IIT Delhi Endowment Fund Exclusive Breakfast
Roundtable with IIT Delhi Leadership", 2026-10-28 08:00–09:00 -04:00, exactly
as printed on the invitation. But the user never saw that: the bot's *own*
conversational turn, running concurrently on the same trigger, called
`find_events`, got back an unrelated existing event in the same group
("Annual Fund Kick-Off Breakfast", Oct 14, also a breakfast, also 8:00 AM),
and replied "You have an 'Annual Fund Kick-Off Breakfast' event scheduled
for Wednesday, October 14…" — a confident, specific-sounding answer to a
question nobody asked, about the wrong event. From the user's side this
read as "nothing happened" (worse: as "it found some other old event"), so
they resent the same photo. The second send correctly produced only the
auto-filer's silent "📎 Indexed — … Added 1 calendar event" line — and
because the auto-filer already recognizes a once-processed attachment, no
duplicate event was created. The user then asked to "update it for October
28th date", and `update_event` answered "no matching event in this group" —
a downstream confusion, not a separate defect: the model's only referent for
"it" was the *wrong* event title its own first reply had just introduced
into the conversation, and that title matches nothing real in the group.

The design already has the right suppression mechanism: `bot.service.ts`'s
`bareAutoFileUpload` (an empty-after-stripping-the-mention trigger body, ADR
0009's "the bot must not also propose those tools from the same upload")
keeps a bare-upload turn's generated prose from double-posting over the
auto-filer's own acknowledgment. But it's gated on `!anyToolsExecuted` —
and nothing told the model not to execute a tool in the first place. The
system prompt (`context.ts`) already says "Do NOT create those yourself from
the file" (preventing a duplicate `create_event`), but says nothing about
*read-only* tools like `find_events`/`search`, which the model is otherwise
free — even encouraged — to use. Being "helpful" by checking for a
conflict first is reasonable behavior in general; it's wrong specifically
when there is no question to answer and the upload is already being filed
by someone else.

## Decision

When the trigger is a bare attachment upload (`isBareAttachmentUpload`,
already computed in `bot.service.ts` for the post-hoc suppression check),
compute it *before* the prompt is built and pass it into `buildLlmContext`
as `triggerIsBareUpload`. `context.ts`'s attachment block then adds one more
explicit sentence for that case: call no tool this turn, including a
read-only lookup, because there is nothing to check or answer and the
deterministic filer already handles it silently. This closes the gap at its
source rather than trying to catch it after the fact — once the model
calls no tool, `bareAutoFileUpload`'s existing suppression already does the
right thing with whatever text it still writes.

## Alternatives considered

- **Suppress the reply unconditionally whenever the trigger has an
  attachment, even if a tool fired** — wrong in the many cases where the
  user *did* ask something about the file (a genuine question is one of
  the two gates `bareAutoFileUpload` already excludes); this isn't a
  "attachment" problem, it's specifically a "attachment, no caption, model
  volunteered a check anyway" problem.
- **Teach `find_events` (and every read-only tool) to refuse when the
  trigger is a bare upload** — pushes a prompt-shaped problem into every
  tool's executor, and a tool genuinely doesn't know *why* it was called;
  the model knows it has nothing to answer, so telling the model is the
  right layer (same reasoning as ADR 0149/0188's prompt-first fixes).
- **Fix only the resulting `update_event` confusion** (teach it to fall
  back to "most recent event in this group" when `titleContains` matches
  nothing) — treats the symptom; the wrong referent only existed because
  the first reply introduced a wrong title into the conversation. With the
  root cause fixed, "update it" after a correctly-silent auto-file has
  nothing wrong to latch onto. Revisit only if a *genuine* "update it"
  immediately after a silent auto-file (no prior bad reply) turns out to
  still fail — not reproduced here.

## Consequences

A bare attachment upload (image or document, no caption) now reliably
produces exactly one acknowledgment — the auto-filer's — whatever the
file's content, instead of a second, possibly wrong-sounding bot reply
racing it. Pinned by two new tests in `context.test.ts`: the instruction is
present when `triggerIsBareUpload` is true and absent when the same upload
carries a real question. Not retroactive — the confusing first reply and
the resulting "update it" failure already happened once in prod; the real
event is already correct (Oct 28) and needs no repair.

## Addendum 2026-10-25: the app's own caption is not a message

None of this fired for a file sent from the app. The app posts a picked file
with the body `📎 <filename>` (`mobile/app/groups/[id]/index.tsx`), and
`isBareAttachmentUpload` stripped the emoji but kept the filename, so
"united confirmation png" read as words and every app upload got a visible
reply. A model-comparison run on 2026-10-24 showed it on every try, on both
models: gpt-4.1-mini said "Importing the calendar — events should appear
shortly" (not something it did), gpt-5.4-mini told the user to resend the
instruction without the attachment. The app already hides that caption by
the same rule (`index.tsx`, `trimmed === \`📎 ${filename}\``); the server now
does too: `isBareAttachmentUpload(body, filename)` removes the file's own name
before deciding, and the turn loads the name with the attachment row it
already read. A question typed next to the filename is still a question.
