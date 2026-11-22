# 0290 — A list is ticked off; a save is kept

**Status:** accepted · 2026-10-22

## Context

Prod, 2026-10-22, in the owner's personal chat:

> "can you move my entire restaurant list to saves" → the bot said it could
> not, but could save each one → "yes" → two places saved → "that moved two.
> move all others too" → three `save_place` calls, all "already saved"
> (Khasiyat, Social Hub, Sarvana Bhavan) → done.

The prod log shows no `get_list` call in either turn. The model saved the
names it could see in its prompt and stopped. Four things composed:

1. **The snapshot was a sample presented without real numbers.** The
   "Group's record" block shows at most 12 lists × 8 open items and 30
   saves, and its counts were the length of those capped arrays. A model
   asked to act on "the entire list" had nothing to tell it the preview was
   short.
2. **In the personal chat the snapshot covered the personal group only.**
   ADR 0096 widened the read *tools* across the user's groups but not this
   block, so a list kept in the family group was not in the prompt at all.
3. **No tool moved a list.** The only way was one `save_place` per item,
   with the model doing the enumeration, and nothing ever took the items off
   the list.
4. **The routing rule put places on lists in the first place.** The prompt
   sent any named destination ("save X to my restaurant list", "places to
   eat") to `add_list_item`, on the grounds that the Saves tab did not group
   by tag. It has had tag filter chips with counts for some time, so the
   reason no longer held.

## Decision

**One rule for where a thing goes: a list holds things you tick off and are
then done with; a save holds things you keep and come back to.** Groceries,
packing, errands and things to buy go on lists. Places, recipes, links to
keep, books/shows/movies and contacts are saves. This holds when the user
says "list": "add Khasiyat to my restaurant list" is `save_place` with
`tags=["restaurant"]`, and the bot says it is in Saves under that tag. A
user who insists on the list after being told gets the list. The quick test
the prompt gives the model: once it's done, would they delete it or keep it?
A restaurant you have been to is still worth keeping.

**Moving a list is one server-side call.** `moveListToSaves`
(`services/list-to-saves.service.ts`) reads every item itself, saves each
in the list's own group (a URL line becomes a link, a line over 200
characters keeps its full text in the note), tags each with the list's name
minus the word "list" (`saveTagForListName`), and then deletes the list. It
is shared by:

- `POST /api/v1/lists/:id/move-to-saves` (`MoveListToSavesRequest`,
  membership-checked, 404 for non-members like every entity-id route);
- the bot tool `move_list_to_saves { listName, kind?, groupName? }`, which
  finds the list the way `get_list` does (every group from the personal
  chat, this group only in a shared one) and whose description forbids
  doing it with one `save_place` per item;
- a "Move to Saves" action on each list card in To Do's → Lists, which
  guesses the kind from the name (`saveKindForListName`: books/shows/movies
  are media, links/articles are links, everything else a place) and confirms
  first, since the list goes away.

The list is deleted only after every item is saved, so a failure part-way
leaves items in both places, never in neither. It is not one transaction:
`createSaveWithDedup` swallows a failed catch-up fan-out, and inside a
Postgres transaction that error would abort it.

`get_list` may read the oldest of two same-named lists in different groups
(ADR 0094's tie rule). A move deletes, so it does not: two lists with the
same name in reach return `reason: "ambiguous"` with each candidate's group,
and the bot calls again with `groupName`.

**A repeat save adds its tags.** `createSaveWithDedup` used to return the
existing save untouched. Now the new tags are merged into it (case-folded,
at most 20). This is how a moved list labels a place that was already saved,
and how the two-turn "save this" → "yes, under date night" now works: the
bot saves again with the tag instead of adding the link to a list.

**The bot sees exact counts.** `loadRecordCounts`
(`services/record-counts.service.ts`) counts in SQL over the whole scope:
every list with its open and done item counts, saves by kind and by tag,
and open tasks. The snapshot prints those numbers with the samples beside
them ("restaurant [Doe Fam] — 12 open: …(+4 more — call get_list)", "Saves
(47): by kind: link 35, place 12; by tag: restaurant 12"). In the personal
chat the scope is every group the user belongs to, and each line names its
group (ADR 0096's rule, now applied to the snapshot too); in a shared group
it is that group only (ADR 0004). The header now says the counts are exact,
the titles are samples, and never to act on a whole list from the samples.
`get_list`'s saves fallback returns `savesTotal` and up to 50 rows (was 20).

## Consequences

- Places stop accumulating on lists. Existing restaurant lists stay as they
  are until someone moves them (button or chat); nothing is migrated.
- A save's tags can now change on a repeat save. Callers that compared tags
  after a "duplicate" result would see the merged set; none did.
- The snapshot costs four aggregate queries per turn more than before. The
  saves count reads `kind` and `tags` for every save in scope, which is
  small for a family but grows with the record.
- The personal-chat snapshot now shows tasks, lists and saves from shared
  groups. That is within ADR 0096's rule (reads widen from the personal 1:1,
  writes do not) and each line says which group it came from.

Found while sweeping, not fixed here: there is **no chat tool to tick off or
remove a list item** ("check off milk", "clear the grocery list"). The bot
cannot do it even one item at a time. It needs its own change, and the same
server-side reading: "clear the list" must not depend on what the model can
see.

## Rejected

- **A prompt rule alone** ("call `get_list` before acting on a whole
  list"). The model would still make one call per item and could still stop
  early; this was the shape that failed.
- **Moving saves back into a list.** Nothing asked for it, and under the
  rule above a place on a list is the wrong home.
- **Migrating every existing list of places.** Guessing which lists hold
  places is a judgement the owner should make per list.
- **Uncapped samples.** A family's whole record does not belong in every
  prompt; exact counts plus a read tool answer "how many" and "what is on
  it" without that.
- **Picking the oldest of two same-named lists for a move**, as `get_list`
  does. Fine for a read, wrong for an action that deletes.
