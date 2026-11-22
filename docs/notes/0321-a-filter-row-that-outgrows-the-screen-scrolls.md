# 0321 — A filter row that outgrows the screen scrolls

Status: accepted (2026-11-05)

## Context

Reported from a phone, with a screenshot: "if a person has a lot of mailboxes,
some ribbons for inboxes disappear from top. like in this one, 4 (gmail,
hotmail, yahoo, rudders\*) are visible, others hiding. we should be able to
pull the invisible ones by swiping on names."

The Email tab's mailbox filter (ADR 0119, one chip per connected mailbox, named
by the user since ADR 0145) was a plain `<View>` with `flexDirection: 'row'`
and no `flexWrap` — so every chip past the right edge of the screen was
clipped, with no swipe, no wrap and nothing on screen to say it was there. The
row has no bound: it is `All mail` plus one chip per mailbox, and ADR 0080
exists precisely so somebody can attach five of them. On a 390-wide phone with
seven mailboxes, three of them simply could not be selected.

It had looked fine because it was only ever used with two or three mailboxes —
the shape of the bug ADR 0119 could not see when it added the row for ">1
mailbox" and ADR 0145 could not see when it let the labels be arbitrary names.

## Decision

Both filter rows on that screen — the mailbox chips and the ADR 0086 action
chips below them — are rendered through one `ChipRow`, a horizontal
`ScrollView` whose content keeps the spacing the row already had. The chips
themselves are unchanged.

One component rather than a fix at the one site that overflowed: the two rows
are the same thing, the second one is five chips today only because nobody has
added a sixth, and the chip set on a 320-wide phone is tighter than it looks in
a simulator.

`showsHorizontalScrollIndicator={false}`, as everywhere else chips scroll in
this app (the composer's ask chips). The cue that there is more is the chip cut
off at the edge — which is exactly what the report's screenshot shows, and what
will now move when it is pulled.

`filterScroll: { flexGrow: 0, flexShrink: 0 }` is load-bearing: a `ScrollView`
in a column stretches to fill it, and without that the row would take the space
the mail list needs.

## Consequences

- With many mailboxes the chips are still not all visible at once. They are
  reachable, which is the complaint; naming the current filter is already the
  active chip's job.
- A horizontal scroll inside a vertically scrolling screen: the gesture is
  unambiguous (the row is 42pt tall and the list below it is a `FlatList` with
  its own area), and the chip row sits above the rows whose own swipe
  gestures archive mail (ADR 0274), not inside them.
- Verified in the browser at 390 wide against the dev server with seven
  mailboxes seeded: the row reproduces the reported screenshot, reports
  `scrollWidth` 681 against a 390 client width, scrolls to the chips that were
  off-screen, and a chip reached that way filters the list and keeps its
  scroll position.

## Rejected

- **Wrapping to a second line** (`flexWrap: 'wrap'`). Nothing is hidden, which
  is tempting — but seven chips become three lines above the mail, on the
  screen where vertical space is scarcest, and the row's height would change
  as mailboxes are added or renamed.
- **An overflow "more" menu** after N chips. A second way to pick a mailbox,
  and the question "which ones are in the menu" has no good answer when the
  labels are user-chosen.
- **Shortening the labels to fit.** ADR 0145 made these names the user's
  choice precisely because the address local part said the wrong thing.
- **Fixing only the mailbox row.** The action row is the same component one
  translation or one added filter away from the same bug.
- **A bot tool.** It rearranges a surface and selects a filter already
  reachable by tapping (ADR 0215's reasoning for a gesture-only setting).
