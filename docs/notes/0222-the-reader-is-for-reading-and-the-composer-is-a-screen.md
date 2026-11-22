# 0222 — The reader is for reading, and the composer is a screen

Status: accepted (2026-10-02)

## Context

The email thread screen (`mobile/app/email/[threadId].tsx`) had grown three
permanent fixtures around the mail: a row of up to eight text buttons on top
(Mark unread, Archive, Trash, Forward, Share, Unsubscribe, the provider link,
Apply label), a "Chord labels" card with its own text field under the subject,
and a docked reply box with an "Ask Chord" block at the bottom. On a phone the
email itself was left a strip in the middle.

Replying was worse. The reply box sat at the bottom of the screen and split it
50/50 with the email when focused, so with the keyboard up most of the text
being written was behind the keyboard. The `KeyboardAvoidingView` also had no
`keyboardVerticalOffset`, so on iOS the bottom of the box was under the
keyboard by exactly the header's height.

Owner direction: copy the iPhone Mail layout. Renderings were agreed before
any code.

## Decision

**Reading.** The mail gets the whole screen. Everything else is one tap away:

- A floating pill with three icons: trash, more, reply
  (`mobile/src/email-reader-bar.tsx`).
- The reply arrow opens a sheet: Reply, Reply all, Forward, Suggested — plus
  "Continue draft" when an unsent reply exists.
- More holds Archive, Mark read/unread, Share/Print, Unsubscribe and the
  provider link. Archive and mark-unread stay as list swipes (ADR 0128/0215);
  they are repeated here because web has no swipe.
- A small Label button under the subject opens a box
  (`mobile/src/email-label-sheet.tsx`) that holds the thread's Chord labels, a
  field for a new one, the user's existing Chord labels, and "apply the
  category as a label in your mail app" (was its own top-row button).
- The header no longer repeats the subject; the full subject is the first
  line of the page.

**Answering.** The composer is a full-screen layout of the same screen, not a
docked box: Cancel on the left, attach and Send in the header, To / Cc-Bcc /
Subject rows, then a body that takes all remaining height and scrolls inside
itself. The message being answered is one collapsed line under the body that
expands on tap. `keyboardVerticalOffset` is the header height.

It is a layout of the same screen rather than a new route because it shares
the draft, the autosave (ADR 0113), the recipients and the attachment state
with the reader; a route would have to hand all of that across.

**Which message the bar acts on.** Reply, Reply all and Suggested answer the
message the reader opened last (the newest by default, `pickReplyTarget`
otherwise). The per-message Reply / Reply all buttons on each card are gone.
Trash and Archive still act on the whole thread, as before.

**Suggested is asked for, not assumed.** Opening the reply box used to draft
a reply with the model every time (ADR 0197 addendum). Now plain Reply opens
an empty box, and only Suggested drafts one and shows the ask bar. A failure
to draft is shown, because the reader asked for it.

**Icons.** The app had no icon set (emoji and text glyphs only), and there is
no reply-all glyph. `@expo/vector-icons` is added, importing only
`MaterialCommunityIcons` so one font ships rather than nineteen. `expo`
already depends on it and on `expo-font`, and `expo-font` is already linked
into the shipped builds (checked with `expo-modules-autolinking resolve`), so
this is deliverable as an OTA update. `expo-font` is pinned to the version
already in the build.

## Rejected

- **A separate `/email/reply/[threadId]` route** — would duplicate or hand
  across draft, recipient and attachment state the reader already owns.
- **Keeping the side-by-side split on wide screens** — owner call: one
  composer everywhere.
- **Swipe-to-archive inside an open email** — fights wide HTML mail that
  scrolls sideways; the swipes stay on the list.
- **Emoji for the new icons** — no reply-all, and they render differently
  per platform.
- **Importing from the `@expo/vector-icons` index** — pulls every icon font
  into the bundle.

## Consequences

- No server change and no new capability, so no bot tool (the rule is for
  new ways to change something; this rearranges existing ones).
- A reply no longer costs a model call unless the reader picks Suggested.
- `Cancel` keeps the draft (autosave); there is no discard prompt.
- After pulling, run `npm install` once: the icon package moves from under
  `expo/node_modules` to the top level.
- Verified on web against the mock mailbox. The keyboard behaviour is an iOS
  matter and has not been run on a device.

## Addendum 2026-10-02 — every composer is that screen, and a draft comes back

Owner direction after using it: the New message screen still had the old
layout (a chip per mailbox, a second row of chips for send-as, Send at the
bottom), and there was no visible way to keep or drop what was written.

- **One layout, three composers.** New message and Forward now use the same
  pieces as the reply composer, from `mobile/src/email-compose-ui.tsx`: Cancel
  and Send in the header, ruled field lines, a body that takes the rest of the
  screen, the ask bar under it. The reply composer was moved onto the same
  module rather than left as a second copy.
- **From is one list.** A single line that opens a sheet holding every address
  the message can leave from: each connected mailbox, and each verified
  send-as address of the primary Gmail (ADR 0130). With one address it is
  plain text.
- **The ask bar on a new message.** A header button shows it. It calls
  `POST /me/email/compose` (`composeNew`), ADR 0197's call without a thread:
  same model, gate, meter and calendar grounding. With no subject written the
  model's first line supplies one; a subject the user wrote is never replaced.
  Chat already has `compose_email`, so no new bot tool.
- **Cancel asks.** With something written, Cancel offers Save draft or Delete
  draft (tapping away returns to writing). This replaces "there is no discard
  prompt" above for New message and Forward; the reply composer's Cancel still
  just closes, since the reader behind it offers Continue draft.
- **A saved draft is loaded back.** Reply and forward drafts were saved per
  thread and never read again: reopening the thread showed an empty box, and
  the first keystroke overwrote the saved text. `GET
  /me/email/threads/:id/draft?kind=reply|forward` returns it and the composer
  starts from it. A single-draft read also names its files (`attachments`,
  only ones the user can read), so a resumed draft keeps them instead of
  autosaving an empty list over them.
- **Send-as and undo.** A queued send (ADR 0115) leaves from the draft's
  mailbox, and a draft has no send-as field, so with the undo window on a
  chosen send-as address was dropped and the message left from the mailbox's
  own address. A send-as message now goes directly, from the address chosen,
  without the undo. Storing the address on the draft would restore undo for it
  and is not built.
- Only whole addresses are written into a draft. One half-typed name made the
  server refuse the save, which lost the body with it.

Verified on web against the mock mailbox: layout order, the From list, the
ask round trip, Save, Delete, and resuming a new, a reply and a forward draft.
Not run on a phone.
