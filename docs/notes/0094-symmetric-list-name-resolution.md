# 0094 — One list-name rule: a write resolves before it creates

**Status**: accepted
**Date**: 2026-08-22
**Relation**: fixes the duplication [0058](./0058-no-list-consolidation.md) is
often blamed for (it removed *display*-time consolidation; this is about
*write*-time identity); the ambiguity response follows the ask-don't-guess
pattern [0077](./0077-user-declared-email-routing.md) set for group names.

## Context

Reading a list and writing to a list used different notions of what a name is.

`get_list` tokenized: lowercase, strip punctuation, drop the filler word
"list", stem trailing plurals, then prefix-match each token. So "restaurant
list", "Restaurants" and "restaurants" all found one list.

The write behind `add_list_item` went through `findOrCreateListByName` →
`getListByName`, which was `.where('name', '=', name)` — exact and
case-sensitive. So the same three phrasings created three lists.

`rename_list` had a third rule (`trim().toLowerCase()`), matching neither.

The result compounds daily. The model does not emit a stable casing, so an
ordinary week of "add X to my restaurants list" leaves a user with
`Restaurants`, `restaurants`, and `Restaurant list` — and, because the To Do's
Lists tab renders items only when a card is expanded and offers no search, the
item they are looking for is behind whichever of the three cards they did not
open. That is how a saved restaurant became unfindable in the app while the bot
answered questions about it without hesitation.

The pattern is not unique to lists — `saves` and `list_items` both dedup on
normalized text, and `tasks` dedup on nothing at all — but lists are where it
shows, because a list is a *container* the user navigates rather than a row
they read.

## Decision

**One rule, in the kernel, used by every read and every write.**

`kernel/src/list-name.ts` owns it:

- `listNameTokens` — the tokenizer `get_list` used to keep private.
- `listNameKey` — canonical identity. Two names sharing a key ARE the same
  list. Names that tokenize to nothing ("List", "!!!") fall back to
  `normalizeText`, so they collide only with themselves.
- `listNameLooseMatch` — prefix match in either direction, for offering
  candidates.
- `resolveListName(lists, query)` → `resolved` | `ambiguous` | `none`.

Server-side, `resolveOrCreateListByName` replaces `findOrCreateListByName`, and
`getListByName` is **deleted** rather than left available — an exact-match
lookup sitting next to the resolver is an invitation to reintroduce the split.

### Ambiguity is a result, not an error

An exact key match always wins, so "books" picks `Books` over `Books to read`
instead of reporting a conflict. Only when several lists match loosely and none
exactly is the name genuinely ambiguous — and then the tool returns
`{ added: false, reason: 'ambiguous', candidates }` so the model asks which one.

Creating a third list on ambiguity is what the old code did, and it is the
worst available option: it is silent, it is wrong, and it makes the *next*
query ambiguous too. Picking one silently is worse still — an item lands on
"Books to buy" when the user meant "Books to read" and nobody finds out.

### Ties resolve oldest-first

`resolveListName` takes the first row it is handed, and both call sites pass
oldest-first. This only matters for rows that predate migration 042, but it
matters in the right direction: the original list keeps growing, not the fork.

### A rename that collides merges

Renaming "restaurants" to "Restaurants" when "Restaurants" already exists would
leave two rows sharing one key — and since resolution takes the older, the
other list's items become unreachable by name. **Renaming a list is not asking
to lose it.** So the collision folds: the oldest of the colliding set keeps the
rows, takes the name the user typed, and absorbs the others' items under the
same dedup rule everything else uses.

The fold lives in `renameList` rather than in the bot tool, because the app's
`PATCH /lists/:id` can collide exactly the same way. The result carries
`merged`, so the bot can say what happened ("merged with the existing
'Restaurants' — 4 items moved over") and the To Do's tab can refetch instead of
replaying a merge against an optimistic patch: the surviving row may not be the
row the client addressed.

Refusing the rename was the alternative. Rejected — the user has *already* told
us these are one list; making them do it in two steps, with the second step
being a manual copy of every item, is a worse answer than doing it.

### Migration 042 heals what is already there

Symmetry stops new forks; it does not merge the ones in the database. `042`
groups every list by `(group_id, listNameKey)`, keeps the oldest, moves over
only the items the keeper does not already have (compared with `normalizeText`,
the same rule `addItem` dedups on), and deletes the emptied duplicates. It also
clears their `catchup_assignments` rows, which carry no foreign key and would
otherwise point at a list that no longer exists.

It is extracted as `mergeDuplicateLists` rather than inlined, the same shape
`hardenCalendarIdentity` uses — this is data movement, not DDL, and the case
worth asserting is an item that exists on both sides. It sits in
`db/list-merge.ts` beside the per-pair `mergeListInto` that `renameList` calls,
so the migration and the rename cannot drift on what a merge does; `db/` rather
than `services/` because the migration runner must not import upward through
the layering.

## Consequences

**A rename can now destroy a list row.** The merge is not reversible: the
absorbed list is deleted and its duplicate items are dropped rather than moved.
That is the intended behaviour — the user said the two names are one list — but
it makes rename a heavier operation than its name suggests, and there is no
undo. The blast radius is bounded by the dedup rule (no item is lost, only
duplicates of items the keeper already had).

**The stemmer is crude and now load-bearing.** `(es|s)$` turns "gas" into "ga"
and "Chris" into "Chri". It was already the read-side rule, so nothing
regresses, but it is applied on writes now too. Because both sides share it,
a bad stem is at worst a wrong *match*, never a silent fork.

**Test fixtures gained `ensureList`.** `resolveOrCreateListByName` returns a
union, and unwrapping it in every arrange block would bury the resolution
semantics in noise. The helper throws on ambiguity, which no fixture should
ever hit.

## Alternatives considered

**Lowercase both sides of the existing `=`.** One line, fixes casing. Rejected:
it leaves "restaurant list" and "Restaurants" as different lists, which is the
half of the problem the user actually hits, since the model varies phrasing
more than it varies case.

**A unique index on `(group_id, lower(name))`.** Enforces at the database, no
resolver needed. Rejected: it turns a duplicate into a 500 at the worst moment
(mid bot-turn), still does not unify "restaurant list" with "Restaurants", and
gives no path to the candidates the ambiguity response needs.

**Fuzzy matching by edit distance.** Handles typos. Rejected as premature: the
observed failures are casing and phrasing, both deterministic; edit distance
would start merging "Costco" with "Costcos" *and* eventually with something the
user meant to keep separate, with no clean rule for where to stop.

**Merge duplicates lazily on read instead of a migration.** No migration to
write. Rejected: the merge would then be invisible and unrepeatable, and the
same code would run on every list read forever to fix a bounded, one-time mess.

## Addendum 2026-08-22 — the stemmer folded the wrong way

`listNameTokens` stemmed with `w.replace(/ies$/, 'y').replace(/(es|s)$/, '')`,
which fails on the commonest shape in English: a noun whose stem already ends
in `e`. "Notes" lost two characters and keyed as `not`, while "Note" kept its
`e` and keyed as `note`, so the pair the stemmer exists to unify never
matched. `ies → y` broke the `-ie` family the same way — "Movies" became
`movy`, never meeting "Movie". A possessive also left a bare `s` token that
stemmed to the empty string and padded the key with a double space.

The rule cannot be written as "strip the plural suffix", because nothing in
the surface form says whether a trailing `es` is the suffix ("boxes") or an
`e` stem plus `s` ("notes"). So `foldWord` stops trying to recover the
singular and instead pushes **both** forms to the same lossy stem: drop a
trailing `s`, then a trailing `e`, then map `y` to `i`. note/notes → `not`,
movie/movies → `movi`, story/stories → `stori`, grocery/groceries →
`groceri`. The stem is never displayed, so being a non-word costs nothing.

The `s` step takes no length guard, because "do"/"dos" must fold together for
"To-do"/"To-dos" — which is the name in the data. The price is that a short
`-us` word does not match its plural ("bus" → `bu`, "buses" → `bus`);
acceptable, since list names are not bus-shaped, and the alternative loses the
case that actually occurs.

Migration `043_merge_duplicate_lists_refold` re-runs `mergeDuplicateLists`
under the corrected key: 042 folded under the broken stemmer, so any
"Notes"/"Note" fork survived the migration written to heal it. Same function,
idempotent, a no-op wherever 042 already left one list per key.

**Still not collapsed:** a closed compound and its open form ("watchlist" vs
"watch list") remain distinct keys. Stripping a trailing `list` from a token
would unify them, and would also merge "Specialists" into "Specia" — a
plausible family list, and a merge moves rows. Left alone deliberately.

## Addendum 2026-08-22 — same-named lists across groups share a card

Four cards titled "To-dos" were four groups, and nothing on the card said so
except a group name at the end of a meta line. Reading that as four unrelated
lists is the user's problem, not the data's — the rows are correctly separate.

So the Lists tab clusters by `listNameKey`, the same rule the bot resolves
with, and renders **one card per key** across every group. This is a view, not
a write: `mergeListInto` still never crosses a group boundary, because group
scope is a security boundary (ADR 0004) and the whole point of ADR 0097 was
that we stop moving people's data between groups on our own judgement.

Inside the card, items dedup on `normalizeText` — the rule `addItem` already
uses within one list — and each row carries a chip per group holding it, so
"Renew passport · RDMS · John-Ashu" is visibly one thing in two places while
"Book dentist · John-Ashu" is visibly not. Chips are suppressed when the card
spans a single group; the meta line already said it.

Consequences that needed deciding:

- **Toggle, edit and delete fan out** across a merged row's copies, the same
  shape the Tasks tab has used since it started merging by title. A row that
  acted on one copy would lie: you would tick "Renew passport" and watch it
  come back. The toggle coerces every copy to one target state computed from
  the lead rather than flipping each — two copies in opposite states would
  otherwise swap on every tap and never settle. Delete across groups asks
  first, naming them ("Remove this from RDMS and John-Ashu?"); a
  single-group delete stays immediate, as before.
- **Rename and delete-list leave the header** when a card spans more than one
  list, and reappear in the expanded footer, one row per real list with its
  group beside it. One `×` in a header that stands for four groups' lists is
  not a button worth having.
- **Adding an item to a spanning card picks a target**, defaulting to the
  list that names the card. This is the one write the card can't infer, and
  silently choosing a group is exactly what ADR 0097 removed from the email
  path; it should not reappear here.
- The card is named by its **oldest** member (the `mergeListInto` tiebreak) but
  sorted and dated by its **newest**, so "Latest" still means what it says.
- The tab badge counts merged rows, matching what is now on screen.
