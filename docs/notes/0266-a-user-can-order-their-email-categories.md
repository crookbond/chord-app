# 0266 — A user can order their email categories

**Status:** Accepted, 2026-10-18

## Context

The AI view orders categories by Chord's own rule. Cards: unread first (most
unread on top), then the category that got mail most recently, with ties
going to family categories before marketing ones. Feed: dated action items
soonest first, then To-dos / Events / Lists, then the "Recent mail" category
cards by the same unread-then-newest rule. A user who always wants Finance
and School on top had no way to say so; the order moved with every new email.

## Decision

A user's own order is kept per user and wins over the default:

- Categories they pinned come first, in their order. Every other category
  keeps the default order below them (`applyCategoryOrder`, kernel).
- **Press and hold a card, then drag it** (Cards, and Feed's recent-mail
  cards). The card and every card above where it landed become the pinned
  order (`pinnedAfterMove`), since pinning the dropped card alone would send
  it to the very top rather than where it was put. A line shows where it will
  land; nothing moves until it is dropped. A refused save puts the old order
  back.
- **In the 1:1 chat**: `set_email_category_order { categories?, mode?, clear? }`.
  `mode: "top"` (default) puts the named ones first and keeps earlier pins
  below; `"replace"` makes the list the whole order; `clear` goes back to the
  default; nothing given reads it. A name must match a category exactly
  (case and spaces ignored); otherwise nothing is saved and close names are
  offered, so the bot asks rather than guessing. Personal-only: the
  candidates are the user's own categories.
- Stored as category **titles** in `users.defaults` (`email_category_order`,
  the ADR 0255 key store, so no migration), because the views group by title
  and a title is what the user says. "Unsorted" can be placed too.
- One writer, `setCategoryOrder`, for the route (`GET`/`PUT
  /me/email/category-order`) and the tool.

This changes only the order on screen, not which emails go in which category
(that is the separate user-rules work).

## Consequences

- A category that is renamed by the classifier loses its place until it is
  pinned again (its old title no longer matches).
- At most 40 pinned categories.
- The drag itself was not exercised in a browser here (the browser tool
  cannot hold a pointer down); the drop maths is tested in kernel and the
  saved order was checked showing in both Feed and Cards.

## Rejected

- Storing category ids (the user names titles, and Cards groups leaves by
  title, so one id can stand for several cards).
- A separate "edit order" screen (the user asked for press-and-drag and chat).

## Addendum 2026-10-19

- **A drag scrolls the view.** Holding a dragged card within 80 px of the top
  or bottom edge scrolls the Feed/Cards view, slowly at the inner edge of that
  band and faster toward the edge (`edgeScrollStep` in kernel, at most 14 px a
  frame), so a card can be dropped anywhere, not only where it was visible.
  The view is a `DragScrollView` the list finds through context; the dragged
  card moves with the scroll so it stays under the finger.
- **Settings has a Reset** ("Category order in Feed and Cards"), which clears
  the pinned order (PUT with no titles). Chat already had this
  (`set_email_category_order { clear: true }`), so no new bot tool.
- Cards remembers which cards are open for the app run, per user, so opening
  an email and coming back finds the card still open.
- Feed and Cards show up to two sentences of each email under its subject
  (`EmailTilePreview.snippet`, the provider preview cut by `previewSnippet`).
