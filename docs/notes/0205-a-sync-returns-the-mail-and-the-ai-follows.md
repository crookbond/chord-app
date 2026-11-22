# 0205 - A sync returns the mail, and the AI follows

**Status**: accepted
**Date**: 2026-09-24

Follows ADR [0204](./0204-the-load-test-found-the-database-doing-bookkeeping.md), whose findings listed two latencies as "needs a decision". The owner made it. Amends ADR 0144 (the mirror/full depth split) and ADR 0180 (the read-time check).

## Context

`POST /me/email/sync` (the Email tab opening, a pull to refresh) returned only after the AI passes had run over what it fetched: classification, attachment import, event and to-do extraction, people extraction. Its latency was the sum of every model call, 3.9 s mean at 10 operations per second with a half-second mock model, and several seconds per call with a real one. What a person opening the tab is waiting for is their mail.

Opening a thread had the same shape. ADR 0180 runs one LLM check (spam and phishing caution, suggestions) the first time each thread is opened, and the response waited for it.

## Decision

- **A user-triggered sync returns after the mirror.** The route runs its round at `mirror` depth (body excerpts, the new-mail notification, the vacation responder: provider fetches, no model) and returns. The AI layer starts when the response is sent, and when it finishes the server emits `email.synced` so the client refetches threads and decisions; classification's own `email.tiles.updated` still fires. The mobile app already refetched on both events, so no client change. Same for the per-account sync route. `withMirrorSyncThenAi` (gmail.service) is the helper; `syncAllAccounts` takes a depth because a nested `full` round would deepen the outer one back into the AI layer (ADR 0144's rule).
- **A caller asking only for the mirror does not wait on an AI run that is already in flight.** The post-sync coalescer let a caller join the running pass and await it, so a second pull, or a pull that arrived while the sweep was classifying, sat behind the whole thing. A mirror-depth caller now returns at once; its rows are covered by the trailing pass the coalescer already schedules. A caller asking for `full` still joins and awaits, and now deepens a run that was opened for the mirror only.
- **Opening a thread waits for the check only up to `EMAIL_READ_TIME_WAIT_MS` (default 1500).** Inside that, the first response carries the caution banner and suggestions as before. Past it, the email is shown at once, the check finishes behind the response, and the server emits `email.thread.updated` for that thread; the open screen already reloads on that event and re-serves the stored advisory and any staged suggestions. The check still runs once per thread.

## Alternatives considered

- **Leave sync awaiting the AI.** Every screen that pulls waits on the slowest model call, and the wait scales with what the model provider is doing that minute.
- **Return the mirror and run the AI on a timer instead of straight away.** The sweep already runs every five minutes; a pull that waited for it would show unsorted mail for up to that long. Starting when the response goes out costs nothing extra and lands in seconds.
- **A separate "sync then classify" endpoint.** The client would have to call two things and reason about the gap; one route with an event is what the client already handles.
- **Never wait on thread-open.** The caution banner exists so it is there before the first tap. Waiting a bounded 1.5 s keeps it on the common fast answer and gives up only when the model is slow. `0` turns the wait off for anyone who prefers the other side of the trade.
- **Await the mirror-depth join anyway.** Correct in the narrow sense that everything is done when the response returns, and exactly the wait this removes.

## Consequences

- Right after a pull, new mail is stored but unclassified: it shows without a category or action badge and without suggestions until the passes finish, seconds later, when the client refetches. Before, it arrived already sorted.
- On a slow model, opening a message that looks like phishing can show it without the caution for up to the length of the model call; the banner appears when the check completes. Bounded by nothing but the model, since the check runs after the wait. This is the cost of the choice and is why the wait is configurable.
- If the app is not connected to the user stream when the passes finish, it learns on its next refetch (any pull or foreground refresh), the same as every other `email.*` event.
- Tests that read what the passes produce right after a sync must wait for them (`__settleAfterSyncForTests`), as the client does for the event.

## Addendum 2026-10-19: the limit counts from when the open arrived

An open in prod took 2.36 s with the 1.5 s limit. The limit started only after
the thread had been read, and the open's other lookups (provider link,
images, unsubscribe, flight/parcel) ran one after another after the wait, so
an open cost the thread read + the limit + every lookup. Recent changes made
the check's prompt bigger (several items per email, labelled calendar
context), so it now runs past the limit almost every time and the full sum
was paid on every open that was not pre-loaded.

Now the limit counts from when the request arrived, and those lookups run
during the wait (only the suggestion read waits for the check, since a check
that finished in time may have staged cards). An open is about the longer of
the thread read and the limit, plus one lookup, instead of the sum. Each open
logs one `email thread opened` line with its total and where it went
(`thread`, `wait`, `rest`), so the next regression is measured, not guessed.
The limit itself is unchanged.

**The next email is checked before it is opened** (amends ADR 0218's "a
prefetch skips the check"; owner decision, accepting a model call for a
neighbour that is never opened). When the reader pre-loads the next or
previous email (`?prefetch=1`), the server starts that email's check in the
background without waiting on it (`prefetchReadTimeMagics`), so the open
finds it done and shows at once, caution included. An open that arrives while
that check is still running joins it (`runReadTimeEmailMagics` keeps one
check per thread in flight) rather than asking the model again. The prefetch
follows the warm-up's mail rule (`warmUpCandidates`, shared with ADR 0219):
unread or recent, not bulk, not coupons/newsletters. Checking old,
already-read mail nobody opened is what staged the burst of stale to-dos in
ADR 0221, so opening such an email still waits for its check as before.
`EMAIL_PREFETCH_READTIME_ENABLED` (default on) turns it off.
