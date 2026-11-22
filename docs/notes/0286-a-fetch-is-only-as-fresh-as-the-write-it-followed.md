# 0286 — A fetch is only as fresh as the write it followed

**Status:** accepted · 2026-10-22

## Context

Reported: in the AI view (Feed or Cards), reading down a category's recent
mail and putting each email away one by one, then reaching the end of the
walk, brings you back to a view that is **still listing the emails you just
deleted**, and keeps listing them.

Three things compose, and only the third is the defect:

1. **The removal does not wait for the mailbox.** ADR 0218 made reader
   Archive/Trash navigate at once and let the provider round trip finish
   behind it (`void modifyEmailThread(...)` in `app/email/[threadId].tsx`),
   because waiting a round trip per email makes triaging forty of them feel
   broken. `applyThreadModify` calls the provider FIRST and only then writes
   the mirror, so for the length of that round trip the thread is still in
   the inbox as far as any query can tell.

2. **The walk ends by returning to the view**, which refetches on focus
   (ADR 0264 + `use-email-recents.ts`). That refetch is issued in the same
   moment as the last taps.

3. **`removedAt` was stamped only at the tap**, and the filter was
   `removedAt >= askedAt` — "was this removed after the data was asked
   for". So the focus refetch, issued a few milliseconds after the last tap
   and well before its write landed, looked NEWER than every removal while
   predating their writes. Its answer still carried those threads, the
   filter let them through, and nothing refetched again: the AI views listen
   only to `email.synced` / `email.tiles.updated`, never the
   `email.thread.updated` that arrives when the write lands.

Worth stating why the Traditional list does not show this: it patches one
row on `email.thread.updated` and drops it when the event says archived or
trashed (ADR 0218). It converges by being told; the AI views were not.

## Decision

**A fetch is trusted about a thread only once it starts after that thread's
removal was CONFIRMED.** Two parts, both in
`kernel/src/email-removals.ts` (`removedSinceFetch`, pure, tested — ADR
0120/0121's reason: `mobile/` has no test harness):

- a removal the mailbox has not answered yet hides the row outright, whenever
  the data was fetched (the `removing` set, which the recents filter never
  consulted);
- a removal it HAS answered hides the row in any data fetched before that
  answer — so `doneRemoving` re-stamps `removedAt` at the confirmation, not
  only `startRemoving` at the tap.

**A refused removal releases the row entirely** rather than staying hidden:
`doneRemoving(ids, failed)` deletes the stamp for `failed` ids, so the email
comes back everywhere at once and the reason is shown (ADR 0218). Every
caller now says which ids failed — the batch path from `EmailBulkModifyResult.failed`
(so a half-worked batch releases exactly the half that did not change), the
reader and `putEmailAway` from their own rejection.

**Known-stale data earns one more fetch.** The rows are filtered, but the
server would now send others in their place, so `fetchPredatesRemoval` drives
one coalesced reload once the writes land — debounced, and only while the
view is in front, so walking through a category does not refetch the whole
tile tree per email. This is what makes the view eventually RIGHT rather
than merely not-wrong, and it closes the `removedAt` pruning window (stamps
older than 10 minutes are dropped on the next removal, which would have
unmasked stale rows that were still on screen).

`openFromCategory` gets the same rule in place of its `removing`-only
filter: a walk through a category started right after deleting from it was
otherwise handed ids whose writes were still in flight.

Also fixed in passing, same class: `use-email-recents`'s `reload` had no
sequence guard, so focus and the stream both asking at once let an older
answer in flight replace the fresher list behind it.

## Consequences

- One extra deep-tiles fetch per walk-return, in the race case only.
- A category whose preview lines were all just deleted is briefly absent
  instead of showing its older mail — until that one reload lands.
- The rule is a timestamp comparison with a non-obvious reading ("recent" is
  not "fresh"), which is why it lives in one named kernel function with the
  reasoning on it rather than inline in each view.

## Rejected

- **Await the write before navigating.** Undoes ADR 0218, whose whole point
  is that the round trip must not sit between the tap and the next email.
- **Listen to `email.thread.updated` in the AI views** and drop the row, the
  way the Traditional list does. It removes the row the filter already
  removes and brings nothing back in its place, and the stream is closed
  while the walk is in front, so it would still need the stamp rule for
  everything that happened meanwhile.
- **Shorten or drop the recents cache.** Treats a stale-data rule as a
  tuning problem; a shorter cache still shows the wrong thing between
  fetches, and the cache exists so switching views does not paint "Nothing
  needs you right now".
- **Mark the thread archived in the client's cached tiles.** A second copy
  of what the mirror knows, needing invalidation nobody would write.

## Notes

- No new capability — a rendering correctness fix — so no bot tool (the
  every-UI-capability rule covers ways to CHANGE something).
- Nothing platform-specific: no `Platform` branch, so iOS, Android and web
  get the same fix.
- ADR 0149's gate: this is a correctness fix to the shipped Feed/Cards
  surface, not new mail-client work. The artifact it protects is the email
  decision queue the household acts from — an email already dealt with must
  not keep asking.

## Addendum 2026-11-19 — the Traditional list, and reads that share a request

Reported on the web: emails trashed from the reading pane came back in the
Traditional list and were deleted again and again. Two causes, both this
ADR's rule not reaching a place it applies:

- The Traditional list (`app/email/index.tsx`) only ever hid PENDING
  removals. It now filters with `withoutRemoved` against the time each list
  read was SENT (`threadsFetchedAt`; 0 for a stored copy of unknown age), and
  a confirmed removal newer than the last read asks for one more
  (`fetchPredatesRemoval`, coalesced, only while the screen is in front).
  Nothing re-read the list after a Trash from the reader before.
- `request()` made identical GETs on the wire share one request (added
  2026-10-26, after this ADR). A re-read after the Trash joined a read sent
  before it and got the old answer, which undid this ADR's own refetch too.
  The sharing is now `createSharedReads` (kernel `shared-reads.ts`, tested),
  and `apiFetch` ends it on every write, when the write is sent and when it
  is answered, so a read after any write (a mailbox sync included) is sent
  fresh. Reads already on the wire still answer their own callers.

`fetchPredatesRemoval` now skips removals still pending: they are hidden
already and their write has not landed, so a read then is just as stale;
the confirmation asks instead. The reading-pane column also stops showing
every row again once its last one is put away.
