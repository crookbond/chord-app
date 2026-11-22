# 0341 - A new message is a sheet over the mail, and pulled down it is a draft

Date: 2026-11-15
Status: Accepted (amends ADR 0222, ADR 0255)

## Context

Three things about writing a new message, all from the owner:

1. With one mailbox selected in the Email list (the ADR 0119 chips), New
   message still opened on the default mailbox (ADR 0255), so the user had to
   change From every time they wrote from the mailbox they were looking at.
2. The composer was a full screen (ADR 0222). On the web that hides the inbox
   behind one message; the owner asked for a smaller window, a popout.
3. On the phone, a swipe down should put the message away as a draft.

## Decision

**From follows the mailbox being looked at.** The compose button passes the
selected chip as `?mailbox=` (Traditional view only, where the chips are), and
`composeFromAccount` (kernel `compose-sheet.ts`) opens on it: `'primary'` is
the primary Gmail, an id is that mailbox, nothing (All) keeps ADR 0255's
default. A resumed draft still opens on its own mailbox, over both.

**The composer is a transparent modal route** (`email/compose`,
`presentation: 'transparentModal'`), so the Email list stays drawn behind it.
`ComposeFrame` (`mobile/src/compose-sheet.tsx`) draws it as:

- a **popout** on a web page at least 768 px wide: a 560 x 640 window in the
  bottom-right corner over a light dim, with a button that makes it most of
  the window (`composePopoutSize`);
- a **sheet** everywhere else (iPhone, Android, narrow web): a card from just
  under the status bar with a grab handle, over a darker dim.

The header (Cancel, title, ask, attach, Send) is drawn by the frame from the
same `composeHeaderOptions` as before, not by the navigator.

**Pulled down, it is a draft.** Dragging the handle or header down past 120
pt, or flicking it (`sheetSwipeDismisses`), saves the draft and closes, with
no Save / Delete question; Escape does the same on the web. Nothing written
just closes. Cancel still asks (ADR 0222 addendum). The gesture is a
PanResponder in the frame, the same on iOS, Android and web: iOS's own sheet
swipe has no Android equivalent, and a native page sheet sits lower in the
window than the keyboard avoidance assumes (the ADR 0222 bug). A drag starts
only when clearly downward (`sheetDragStarts`), so header buttons still tap.

Only the new-message composer moves; reply and forward stay layouts of the
reader screen (ADR 0222, 0320). No bot tool: this changes how a screen is
drawn, not what can be done.

## Consequences

- On the web the inbox is visible but not clickable while the popout is open
  (the navigator's screen wrapper takes the clicks).
- The swipe is checked in the web app at phone size; not yet on a device.
  `insets.bottom` pads the sheet on both platforms (home indicator, Android
  navigation bar).

## Rejected

- iOS `presentation: 'modal'` (native swipe): no Android equivalent, and the
  keyboard offset is wrong inside a page sheet.
- Keeping the inbox clickable behind the popout: needs reaching around the
  navigator's wrapper.
- Making reply/forward sheets too: they are part of the reader's layout.
