# 0274 — A swipe says which way, and tldr reads the newest email

**Status:** Accepted, 2026-10-19 (amends ADR 0128, 0215, 0261)

## Context

Two complaints about the email screens.

**Swipe.** The Traditional list's swipe (ADR 0128/0215) did the opposite of
what its panel said. `ReanimatedSwipeable` names a swipe by where the ROW
went (`toValue > 0` is `right`), and the code read `left` as "the left
panel opened" — so swiping right showed "Archive" and toggled read, and
swiping left showed "Read" and archived. The panel was also only as wide as
its label, the row had no background (its text showed through the panel
while dragging), and a read toggle left the row stuck open: the "shaky
transparent rectangle".

**tldr.** On a thread, tldr read each mirrored message with quoted history
folded after the first one. The mirror often holds only the last few
messages of a long conversation (backfill window, other folders), so the
earlier part — present only as quotes inside the newest message — never
reached the model, and the summary read like one email.

## Decision

**Swipe.** Finger left = the Settings choice, archive or Trash (ADR 0215);
finger right = read / unread. The row is opaque; each panel is a fixed
92px, full height, coloured, with an icon and label that grow in with the
drag. Archive/Trash fires on `onSwipeableWillOpen` (as the release starts,
not after the animation); read fires on open and the row springs back
closed. Thresholds 56px, spring a little stiffer than the default.

**tldr.** When the newest message carries quoted history, that one message
read **in full, quotes kept** is the input, and the prompt says it quotes
the earlier ones and to summarize the whole conversation ending where it
stands. Only when it quotes nothing (a client that trims history) does tldr
fall back to reading the mirrored messages one by one (ADR 0261's rule).

## Consequences

- One model input per thread instead of N, so a long thread costs less.
- A newest message that quotes only part of the history yields a summary of
  that part; the older mirrored messages are not added back. Accepted: the
  quoted chain is what the sender saw as the conversation.
- "Flag" on a swipe is not built: flagging is a provider-side management
  verb (ADR 0107) with a different write per provider; the swipe stays
  archive or Trash.
- Swipe feel is not verified on a device here; web has no swipe (ADR 0215).

## Rejected

- Reading every message AND the newest's quotes (sends the same text twice).
- A full-width panel that slides the row off screen (read would need the
  row to come back from off screen, which reads as a glitch).
