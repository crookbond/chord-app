# 0334 - A slow mailbox is not an offline phone

**Status:** accepted, 2026-11-12. Amends ADR 0080 (lazy bodies on thread
open), ADR 0302/0304 (device mail window) and ADR 0311 (what "offline" means).

## Context

Prod, 2026-11-12: one Hotmail thread ("reservation mada", newest mail 11/3,
older replies back to September) opened to "You're offline. Chord will
catch up when the network is back." Every other thread opened. The phone
was online.

What happened:

- From about 17:00 UTC, Microsoft Graph answered 502/503/504 on most calls
  for every Outlook mailbox (getMessage, delta, move, setRead,
  calendars.list), each after a long wait. 7 errors that hour, 44 the next,
  58 the one after; none the day before.
- Opening an Outlook thread fetches every message whose body or part list
  is not stored, **one after another**
  (`getOutlookThread`, `outlook.service.ts`), and each request went through
  `graphFetch` with three tries and **no time limit**. A long thread is
  many calls in a row; the `email thread opened` log showed opens of 52 to
  283 seconds.
- `getThreadWith` waited for every fetch before answering, for every
  provider (Gmail already fetched 4 at a time, but also without a limit).
- The app gives a read 25 seconds (`REQUEST_TIMEOUT_MS`) and called any
  timeout "offline", even when the server answered its health check.
- A message whose fetch failed stays unstored, so every later open, and
  every device-cache download, asked Graph again.

Not traced to one earlier change: the serial loop dates from ADR 0080, the
"timeout = offline" rule from ADR 0311.

## Decision

1. **Every Gmail and Graph request has a time limit.** One shared helper,
   `fetchWithTimeout` (`server/src/utils/fetch-timeout.ts`, 15s per
   attempt), used by the Gmail client, the Graph mail client and the Outlook
   calendar client. A request that hung is not retried (the next try would
   hang the same way); 429/5xx answers keep their existing retries.
2. **Outlook fetches a thread's missing bodies 4 at a time**, as Gmail
   already did.
3. **A thread open waits at most 8 seconds for missing bodies**
   (`getThreadWith`, all providers). Past that, it answers with what is
   stored (the reader shows each message's preview with "The full email
   hasn't come through from your mailbox yet") and `bodiesPending: true`.
   The fetch keeps going in the background; when it lands, the thread is
   recomputed if the mailbox changed and `email.thread.updated` is sent, so
   an open reader reloads. The event is sent **only when a body actually
   arrived or the mailbox changed**: the reader reloads on it, and a reload
   that asks a still-failing provider again must not cause another event.
4. **A thread with pending bodies is not kept on the device.** Its newest
   message has not changed, so the device-cache pass would never fetch it
   again and the phone would keep the preview-only copy.
5. **A timeout while the server answers is "slow", not "offline".**
   `SlowServerError` (a subclass of `OfflineError`, so saved copies and the
   send queue treat it exactly as before) is thrown when the app's own
   timeout fired and the health check then succeeded. It says "This is
   taking longer than usual. Try again in a moment." and shows no offline
   bar. Over a stored copy the reader says "Your mailbox is slow to answer".
6. **The device keeps 30 days of read mail, not 14** (owner request). Unread
   mail is still kept at any age; the list pages a pass reads go from 6 to
   12 so the 30-day line is reachable.

## Consequences

- A provider outage now makes opens slow (up to ~8s) and incomplete, not
  broken. Nothing makes the provider faster.
- An open that gave up still costs the background fetch; four at a time,
  each at most 15s per attempt.
- The 30-day window would not have helped this thread (its newest mail was
  inside 14 days); it is a separate owner choice, made here.

## Rejected

- **Raising the app timeout.** Turns a 25s failure into a 60s one.
- **Never fetching bodies on open.** Old Outlook rows rely on it.
- **Sending `thread.updated` whenever the background fetch finishes.** The
  reader reloads on it and asks again, so a failing provider would loop.
