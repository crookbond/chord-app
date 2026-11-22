# 0264 — A category is walked, then left

**Status:** Accepted, 2026-10-17

## Context

The email reader's next/previous followed only the Traditional list's order
(`email-thread-nav.ts`), and only Traditional published one. An email opened
from a category in the AI view (Feed, Cards, Sections) had no order of its
own: "next" either did nothing or, if Traditional had been open earlier in
the session, borrowed that stale list and walked into unrelated mail.
Deleting an email jumped the same way.

## Decision

Opening an email from a category line in Feed, Cards or Sections starts a
**category walk**:

- The order is the tapped email first, then the category's other **unread**
  inbox mail, newest first (`categoryNavOrder`, kernel, tested). Read mail
  is left out on purpose: the walk is for getting through what is waiting,
  and a category's full history could be hundreds of emails long.
- The order is fixed when the walk starts, so opening an email (which marks
  it read) does not pull it out from under the walk.
- **Next** past the last email, or archiving/trashing the last one, returns
  to the view the walk started from (`router.back()`; the Email tab keeps
  its Feed/Cards choice). Removing one mid-walk goes to the next, never back
  to the previous one, which was already seen.
- The nav store gains a `scope` (`list` | `category`). The AI view clears any
  order on focus, so an email opened there outside a category (the urgent
  strip, a decision) can never borrow the Traditional list's order.
- An email archived or trashed from the reader drops out of the category
  lines at once (`removedAt` in the store), instead of showing until the next
  tiles fetch lands.

The category's mail is read with the existing `?mode=category&category=`
list (subtree, inbox, keyset pages), up to 4 pages, so there is no server
change. No bot tool: this is navigation and changes nothing.

## Consequences

- A category with more than about 200 emails is walked through only its
  first 200 (newest first).
- Map's tile sheet is unchanged; it opens threads without a walk.

## Rejected

- Walking every email in the category, read or not (no natural end).
- Rebuilding the order on each step (an email marked read on open would
  vanish from the walk mid-way).
- Going to the previous email after removing the last one (the reader
  already passed it).
