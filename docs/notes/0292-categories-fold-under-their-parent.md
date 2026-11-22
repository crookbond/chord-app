# ADR 0292 — Categories fold under their parent in Feed and Cards

**Status:** Accepted, 2026-10-23
**Amends:** ADR 0146/0147 (Feed and Cards dropped the Map's grouping), 0266
(user order), 0287 (unread first)

## Context

The Map view (ADR 0068) groups mail two levels deep — a parent category
(School, Shopping) holding its subcategories (Ms. Park class, Orders). Feed
and Cards (ADR 0146/0147) dropped that for a flat list, one card per
subcategory, which with a real classifier tree is a long scroll: most of the
cards are subcategories already read through.

Options drawn and compared (mockups shown to the owner, 2026-10-23):

1. **Folded groups.** One header per parent category with its unread total;
   under it only the subcategories that need the user; the rest folded into a
   "+ N more in Shopping" row; a group with nothing in it starts as one line.
2. **Stacked cards.** Each parent's subcategories drawn as a deck that fans
   out on tap. Most compact, but the user's order inside a deck is hidden
   until it is opened.
3. **Parent chips.** A row of parent categories across the top; tapping one
   shows only that group. Fast to jump to one area, hides everything else.
4. **Sidebar tree.** Outlook-style folders beside the cards. Web only; too
   wide for a phone.

Dividers alone (headings between groups) were also drawn: they label the
groups but the list is exactly as long.

## Decision

Option 1, in both Feed's recent-mail section and Cards. Feed's decision list
(dated items, then To-dos/Events/Lists) is untouched: it is ranked by urgency
across categories on purpose (ADR 0146), and grouping it would undo that.

- **Grouping.** A category's parent is its top-level ancestor in the tile
  tree (`categoryParents`, read from the same deep tiles fetch the recent
  lines already make). A top-level category with no children is its own
  parent. A category with no place in the tree ("Unsorted") is a group of
  its own. A group of one is drawn as that card alone, with no header.
- **What is shown.** In an open group: the subcategories with unread mail
  (Cards: or an open decision); the rest behind "+ N more in <parent>", with
  "Show fewer" to close it. A group with nothing active starts folded, its
  header saying how many it holds; opened by hand, it shows them all.
- **Fold state** is per device (AsyncStorage `email.categoryFold.<user>`),
  shared by Feed and Cards, and only records what the user changed by hand,
  so a group that gets new mail opens by itself unless they folded it.
- **Order.** ADR 0287 at both levels: groups holding unread first, then
  read; inside each band the user's order. Inside a group, the same rule over
  its subcategories. Pins stay ADR 0266's one flat list of titles: a group's
  place is its parent title's pin if pinned, else its highest-pinned
  subcategory's — so orders saved before this change still hold.
- **Dragging.** Hold a header to move the whole group; hold a card to move it
  inside its group (dropped outside, it stays at that end of its group). A
  card move also pins its group and every group above where they are, ADR
  0266's "at and above" rule, so moving a card never moves its group. Only
  real category names are saved (not "Unsorted"), at most the server's 40.
- **Chat.** `set_email_category_order` already accepts any category title,
  parents included, so "put School on top" moves the whole group. No new
  tool: folding is a display preference (no server state, like the view
  choice).

Logic is in `kernel/src/email-category-groups.ts` (tested); the list is
`mobile/src/email-category-groups.tsx`.

## Deferred: parent chips (option 3)

Liked, but the Email tab already carries several chip rows (AI/Traditional,
the view picker, filters), and another would add to the clutter this is
meant to remove. Revisit if folded groups are not enough to reach one area
quickly; it would sit above option 1, not replace it, and filter the same
groups.

## Rejected

- **Dividers only** — no shorter.
- **Stacked cards** — hides the user's order inside a stack.
- **Sidebar tree** — web only.
- **Grouping Feed's decision list** — it is an urgency ranking across
  categories by design.
- **A separate pin list for groups** — two orders to keep consistent, and
  every order saved so far would need migrating.
