# 0287 — Unread is the band, the user's order governs within it

**Status:** accepted · 2026-10-22 · amends [0266](./0266-a-user-can-order-their-email-categories.md)

## Context

ADR 0266 let people pin the email categories they care about, and the AI
view's category cards (Feed's recent-mail list, Cards) end with:

```ts
applyCategoryOrder(byDefault, (g) => g.title, pinned)
```

`applyCategoryOrder` is absolute — **pinned first, everything else after** —
so a pinned category the user had already read through sat above an
unpinned one holding mail nobody had opened. The default order underneath
it does sort unread first, but pinning overrides that completely, which is
the one thing an ordering must not do: new mail ends up below rows the user
has already dealt with, and the further they pin, the deeper it goes.

Neither view showed how much unread mail a category held, so there was
nothing on the card to contradict the position either.

## Decision

**Unread is the outer band; the user's order governs inside each band.**
`applyUnreadFirstOrder` (kernel, beside `applyCategoryOrder`, which it still
uses for each half) splits the cards on "holds unread mail" and applies the
user's order to the two halves separately:

- a pinned category with unread mail is at the very top;
- an unpinned category with unread mail still beats everything read;
- once a category is read it falls back to **exactly** where the user put
  it — with no unread anywhere, the result is `applyCategoryOrder`'s,
  unchanged.

The rule lives in kernel because `mobile/` has no test harness (ADR
0120/0121) and because both views must order the same way — two copies of
an ordering is how Feed and Cards would come to disagree about where a
category belongs.

`items` arrives in the view's own default order (most unread first, then
whichever received mail last), which is what the unpinned tail of each band
keeps — so inside the unread band the busiest category still leads.

**The count is on the card.** One shared `UnreadBadge` across both views
reads `3 unread` rather than a bare `3`: a Cards header can also carry a
count of open decisions in the category's own colour, and two unlabelled
numbers side by side say nothing about which is which. It uses Chord's
accent rather than the category colour for the same reason.

Sections is untouched: ADR 0147 groups it by decision KIND, not category,
so it has no categories to band.

## Consequences

- A card dragged to sit below some unread rows records those rows as pinned
  too — ADR 0266's drag takes "everything at and above where it landed" as
  the new pinned order. Not new (the default order already floats unread
  categories to the top, so dragging below them already pinned them), but
  banding makes it structural rather than incidental.
- A read card dragged to the very top shows at the top of the **read** band
  while unread categories exist. That is the rule doing its job, and the
  pin is recorded correctly — it just becomes visible once the unread mail
  is read.

## Rejected

- **Most-unread-first across the whole list**, ignoring the pins. Sorting
  here is user-governed by design (ADR 0266/0147); this removes that for a
  signal that only needs to decide which half a card is in.
- **A separate "Unread" section with its own heading.** Two lists to scan
  where one ordered list says the same thing, and a category would move
  between sections as it is read — a bigger jump than moving down one band.
- **A bare number for the count.** Ambiguous next to Cards' decisions
  badge, which is also a number on the same header row.
- **Banding Sections too.** It groups by decision kind; there is no
  category card there to raise.
- **Keeping unread out of the ordering and only showing the badge.** The
  complaint is that unread mail is hard to find, and a badge on a card
  three screens down is still three screens down.
