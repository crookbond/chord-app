# 0073 — Email delete/archive convergence: proposals die with the email

**Status**: accepted
**Date**: 2026-07-18

## Context

Chord mirrors Gmail opportunistically (sync on view-open + before the
briefing, throttled to `GMAIL_SYNC_THROTTLE_MINUTES`, default 5). Before
this ADR, a Gmail-side delete converged only partially:

- The **category tile sheet** listed threads without the `is_archived`
  filter, so trashed/archived mail stayed visible inside its tile even
  though the main list, digest, and classifier already excluded it.
- **Pending magic proposals** (ADR 0063) never noticed their source email
  was gone: the briefing's "Waiting on you" and the To Do's Action Items
  read pending proposals with no thread-existence check, so a suggestion
  from a deleted email lingered until its 72h TTL (ADR 0009) or a manual
  dismiss.
- A delete that happened while the stored **history token was stale**
  (Gmail expires them after ~a week of no syncing) was *never* observed:
  the full re-backfill fallback only upserts, and Gmail omits
  trashed/deleted mail from `messages.list` — absence was invisible. The
  same gap existed (and was fixed) on the calendar side: ADR 0040's
  full-sync `reverseDeleteAbsent`.

The product rule (owner decision, 2026-07-17): **deleted or archived mail
shows up nowhere; the email→proposal flow is `email → proposal → accepted
or rejected`; deleting the email before the decision kills the proposal;
anything accepted before the delete stays in Chord.**

## Decision

1. **Archived (incl. trashed) mail is hidden from every listing surface.**
   `listThreads` now applies `is_archived = 0` in *both* modes (the
   category sheet had no filter), and the tile queries (`loadTree` direct
   counts, unread/attention counts, preview lines, the magic-proposal
   thread join) all exclude archived threads. Direct thread-open by id
   still works — hiding is about listings, not a tombstone.

2. **Trash or permanent delete retracts the thread's pending proposals.**
   New `retractByProvenance(db, userId, keys)` in `proposals.service.ts`
   flips *pending* rows to `expired` (same shape as the `expireStale`
   sweep). `recomputeThread` calls it with `gmail:<threadId>` when the
   thread's messages are all gone (permanent delete) **or all carry
   `TRASH`** (whole-thread trash only — one trashed reply in a live
   thread retracts nothing). Because every proposal surface (reader
   docking, briefing, Action Items) reads `status = 'pending'`, they all
   converge with no per-surface filtering.

3. **Plain archive keeps the proposal.** Archiving is "I've dealt with
   the email", not "this suggestion is wrong" — the common case is
   archiving an invite after reading it while still wanting the event
   proposal. Only trash/delete expresses rejection of the artifact.
   (Considered retract-on-archive; rejected for silently dropping useful
   suggestions.)

4. **Decided proposals are never touched.** `retractByProvenance` filters
   `status = 'pending'`, so a confirm/reject that happened before the
   delete keeps its outcome, and entities created from a confirm are
   Chord's own rows — deleting the source email never cascades to them.

5. **Full re-backfill reverse-deletes absent messages** (mirrors the
   calendar fix): after a **complete** (non-truncated) backfill, local
   messages inside the backfill window whose gmail id was not in the
   snapshot are deleted, and their threads recomputed — which cascades
   into thread deletion + proposal retraction above. A truncated backfill
   skips the pass (absence proves nothing when you haven't seen
   everything); messages older than the window are out of judgeable range
   and left alone.

## Consequences

- End-to-end latency for "deleted in Gmail → gone from Chord" is one sync:
  ≤5 min while the app is in use, else the next open or morning briefing.
- Proposals no longer outlive their emails; the 72h TTL is now only the
  backstop for *undecided* proposals whose email still exists.
- A stale-token gap no longer strands deletes (trash also converges this
  way, since `messages.list` omits it from the full snapshot).
- Retraction reuses the `expired` status — Action Items history shows the
  row as expired, not rejected, which matches "the offer lapsed" better
  than imputing a user decision.

Tests: `email-delete-convergence.integration.test.ts` (trash → hidden +
retracted; permanent delete → thread gone + retracted; archive → hidden
but proposal pending; pre-delete confirm survives; category-mode hiding).

## Addendum 2026-10-02 — a retraction is announced

Trashing a thread expired its pending proposals but told nobody, so Action
Items and the AI views kept showing them until their next refetch — which
read as "deleting the email did not delete its to-do". `retireFromDeletedThread`
now broadcasts `proposal.resolved` (`expired`) on the proposal's group and
`email.tiles.updated` to the user, and the To Do's mirror (ADR 0105) watches
`proposal.created` / `proposal.resolved` so Action Items refetches on any
proposal change, not only this one.
