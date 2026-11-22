# 0105 — A cross-group screen needs a cross-group stream

**Status**: accepted
**Date**: 2026-08-24
**Relation**: uses the `onBroadcast` seam [0054](./0054-expo-push-notifications.md)
introduced for the push publisher, and respects the one-stream-per-screen
posture of [0082](./0082-sse-streams-follow-app-foreground.md).

## Context

Reported: *"an action taken on web app should sync to mobile and vice versa …
my mobile app has everything still needing to do."*

The To Do's hub **subscribed to nothing**. Tasks, lists and saves broadcast on
their group channel (`sseHub.broadcast(groupId, SSE.taskUpdated, …)`), which is
right for a chat screen — but the hub is not one group, it is every group the
user belongs to, and it never opened a stream of any kind.

So the only things that refreshed it were:

- mounting the screen,
- a pull-to-refresh,
- a real background→foreground round trip (ADR 0082's `useScreenRefresh`),
- a tab change **after** the 30-second `CACHE_FRESH_MS` module cache expired.

Nothing pushed. A task ticked off on the web app was invisible on the phone
until one of those happened, which in practice meant the phone showed
everything as still to do. The same held in reverse, and between two phones.

Worth naming precisely because the obvious diagnosis — "the stream is slow" or
"the cache is too long" — is wrong. There was no stream.

## Decision

**Mirror the To Do's events onto each member's user channel, and let the hub
open one stream.**

`todos-mirror.ts` registers on `sseHub.onBroadcast`, watches the four
group-channel events the hub renders (`task.created`, `task.updated`,
`list.updated`, `save.added`), resolves that group's members, and re-emits a
single `todos.changed` on each member's `user:<id>` channel. The hub subscribes
to `/me/stream`, which it shares with the email screens.

Three things follow from the shape rather than from taste:

**One stream, not one per group.** The alternative was for the screen to open a
group stream per membership. That is the per-socket battery cost ADR 0082 spent
a whole ADR reducing, multiplied by however many groups a family has.

**The event carries only `{ groupId }`.** The hub refetches whichever tab is
showing, so a faithful per-entity payload would be work nobody reads — and a
payload nobody reads is a payload that can leak. The tabs also read enough
different shapes that client-side merging would be its own source of drift; a
refetch is one request and cannot drift.

**It hangs off `onBroadcast`, not the write paths.** There are ~15 broadcast
sites across `routes/tasks.ts`, `routes/lists.ts`, the bot executor and the
proposal committer. Mirroring at each would be 15 chances to forget, forever.
The observer sees all of them and needs no cooperation.

Fan-out is to `group_members` only — everyone told about a change is already
entitled to read the thing that changed (ADR 0004), and nothing about it is in
the payload regardless.

Client side: the refetch is **coalesced at 250ms**, because one bot turn can
fire several writes in a row; and the subscription lives in `useFocusEffect`, so
a screen navigated away from holds no socket. On open — including a reopen after
the app was backgrounded — it refetches once, since a parked stream missed
whatever happened while it was parked.

## Consequences

- Every task/list/save write now costs one `group_members` read plus N tiny SSE
  frames. Cheap, but it is per-write rather than per-viewer, so a group with
  many members pays even when nobody is looking at the hub.
- `todos.changed` is a refetch trigger, not a data event. Anything that wants
  the actual change still reads it from the group channel.
- A user-channel broadcast is explicitly skipped by the mirror. Without that
  guard the fan-out would observe its own output and loop.

## Alternatives rejected

**Subscribe the screen to every group's stream.** Correct without any server
change, and exactly the battery profile ADR 0082 exists to avoid.

**Shorten `CACHE_FRESH_MS`.** Treats a missing subscription as a staleness
tuning problem. Polling faster still shows the wrong thing between polls, and
costs requests on a screen that is usually idle.

**Send the changed entity on the user channel.** Tempting, and it would let the
hub patch in place — but the four tabs render four different shapes with their
own clustering and sorting (ADR 0094), so the merge logic would have to be
written four times and kept honest against the loaders. A refetch is one
request and is definitionally consistent.
