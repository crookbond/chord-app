# ADR 0082 — SSE streams follow the app's foreground state

**Status:** Accepted · 2026-07-28
**Extends:** [0002](./0002-sse-over-websockets.md) (SSE over WebSockets),
[0054](./0054-expo-push-notifications.md) (push is the background delivery path)

## Context

iOS Screen Time / Battery reported the app accruing ~23 hours of background
activity per day. The app declares **no** `UIBackgroundModes` in `mobile/app.json`
— no audio, no location, no `remote-notification` — so it is granted no
sanctioned background execution at all. The time was coming in through the one
door left open: outstanding network requests.

Three things combined:

1. **The group stream was mount-scoped, not focus-scoped.** `openGroupStream`
   ran in a plain `useEffect` keyed on the group id, closing only on unmount.
   expo-router's `Stack` keeps a pushed-away screen mounted, so a group chat you
   had navigated *past* still held its socket.
2. **Nothing closed any stream on background.** The email screens used
   `useFocusEffect`, which is better, but `useFocusEffect` does not fire on an
   `AppState` transition — background the app from any of these screens and the
   stream stayed open.
3. **The server pings every 25 seconds** (`sse.hub.ts`). An app with an
   outstanding `NSURLSession` task does not get to stay suspended when bytes
   arrive; the OS resumes the process to service the socket. ~3,400 resumes a
   night, for a screen nobody is looking at.

Compounding it, `react-native-sse` re-polls on a **fixed** `pollingInterval`
(we passed 3000ms) with no backoff and no ceiling — so once the backgrounded
socket died, the retry loop ran at 20 requests/minute until the app was
foregrounded again.

A stream left open in the background is not a stream that keeps working. It
cannot deliver anything to a UI that is not on screen, and ADR 0054 already
makes push the background delivery path.

## Decision

**A stream's lifetime is bounded by the app being in the foreground AND its
screen being focused.**

- `manageStream` in `mobile/src/api.ts` wraps both `openGroupStream` and
  `openUserStream`. It registers each live stream, closes them all on an
  `AppState` transition to `background`, and reopens them on `active`. The
  handle returned to callers is a proxy: its `close()` unregisters for good,
  while backgrounding merely parks the underlying connection.
- Reopening re-runs the original opener, so a resumed stream gets a **fresh
  token** and re-fires the caller's `onOpen` backfill — the group screen already
  re-fetches the last 50 messages there, which is what makes park/resume lossless
  against ADR 0002's no-replay hub.
- The group screen moved from `useEffect` to `useFocusEffect`, so a
  pushed-away-but-mounted chat holds nothing.
- `attachBackoff` gives the reconnect exponential backoff (3s → 60s ceiling),
  resetting only after a connection that stayed up at least 10s — so a server
  that accepts and immediately drops doesn't reset the ladder.

Two deliberate non-choices:

**`'inactive'` does not tear down.** On iOS it fires for the app switcher,
Control Centre, and an incoming-call banner. Treating it as background would
churn every stream on a glance. Only a real `background` transition closes.

**We kept `react-native-sse`'s reconnect driver rather than replacing it.**
Hand-rolling reconnection looks cleaner but is a correctness regression: when
the server closes a stream cleanly (200 + `readyState DONE`), the library
dispatches **no** `error` event — it just re-polls silently. A hand-rolled
driver keyed on the error callback would miss that case and the stream would
die unnoticed. Instead `attachBackoff` mutates the live `interval` field, which
the library re-reads on every re-poll. Backoff without owning the driver.

Web is exempt (`manageStream` passes straight through): browsers throttle hidden
tabs and the native `EventSource` reconnects itself. This is an iOS
process-lifecycle problem.

## Addendum — refresh, manual and automatic

Parking streams on background exposed a gap that predated this ADR: **nothing
in the app refetched on foreground.** `useFocusEffect` is a navigator event, so
returning to an already-focused screen does not re-run it, and the hub has no
replay (ADR 0002) — a screen left open overnight showed yesterday's fetch until
you switched tabs. There was also no pull-to-refresh anywhere: `RefreshControl`
appeared zero times in the codebase.

`mobile/src/refresh.tsx` supplies both halves:

- `useForegroundRefresh(load)` — re-runs `load` on a real background→active
  round-trip, and only for the **focused** screen, so every mounted screen
  doesn't stampede the API at once. `'inactive'`→`'active'` (app switcher,
  Control Centre) is not a return from anywhere and does not fire, mirroring the
  stream rule above.
- `useScreenRefresh(load)` — the above plus a ready-made `refreshControl` to
  spread onto a scrollable. The pull is floored at 350ms: a refresh that
  resolves instantly reads as "nothing happened".

Wired into Chats, Email (list + tile map's thread sheet), Calendar (day/week/
month), People, and To Do's. Where a screen's loader already does real work the
pull inherits it — Email pulls an actual mailbox sync, Calendar pulls Google.
The group chat is deliberately excluded: its list is inverted (pull-down there
means "older messages"), and its `onOpen` backfill already covers foreground.

The one screen that still refreshes on mount only is To Do's — it has no focus
effect, and adding one would double-fetch against its existing
`useEffect([selectedTab])` load. Tab switches remount it (`router.replace`), and
pull + foreground now cover the rest.

## Consequences

- No sockets, no ping-driven wakes, and no retry loop while the app is
  backgrounded. Background delivery is push, as ADR 0054 intended.
- A resumed stream costs one reconnect plus one backfill fetch per focused
  screen — paid on foreground, where the user is waiting for fresh data anyway.
- A single connection no longer lives for hours, which also bounds the
  `responseText` the library accumulates per connection (it re-scans the whole
  buffer on each chunk and never truncates within a connection).
- If a future screen opens a stream by some path other than `openGroupStream` /
  `openUserStream`, it will not be managed. Both exported openers are the seam;
  keep it that way.
