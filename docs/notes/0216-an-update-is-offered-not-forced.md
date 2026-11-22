# ADR 0216 — An update is offered, not forced

**Status:** Accepted
**Date:** 2026-09-28

## Context

Chord's OTA updates use expo-updates' defaults. The app checks for an update
only when it launches from scratch, downloads it in the background during
that launch, and runs it on the *next* launch from scratch. Coming back from
the background is not a launch, so someone who never force-quits can run an
old build for days, until the OS happens to kill the app.

## Decision

1. **Check again on return to the foreground**, at most once every 10
   minutes (`OTA_CHECK_MIN_GAP_MS`). The clock starts at launch, because a
   launch already checks. A found update is downloaded in the background.
2. **Offer it, never apply it on its own.** When an update is downloaded
   (by this check or by the launch check), a small banner says "A new
   version of Chord is ready" with **Reload** and **Later**. Reload calls
   `Updates.reloadAsync()`, which restarts into the new version within
   seconds. Later hides *that* update; a newer one asks again.
3. **Phones only.** Web is served fresh on every page load, and dev builds
   have no update server, so the banner renders nothing there.

The two decisions (when to check, whether to show) are pure functions in
`kernel/src/ota-update.ts` so they can be tested; the component is
`mobile/src/update-banner.tsx`, mounted once in the root layout.

## Alternatives considered

- **Reload automatically on the next return to the app** — drops whatever
  is on screen, like a half-written message or a form, with no warning.
- **Apply silently at the next launch from scratch** — changes nothing the
  user sees, and still depends on a launch that may be days away.
- **Check on every return to the app** — a request to the update server
  every time someone switches back, for news that arrives a few times a
  week.

## Consequences

- The banner ships as an OTA itself, so each phone only starts showing it
  after picking up this update the slow way once.
- "Later" is remembered in memory only, so a launch from scratch runs the
  new version anyway (that is expo-updates' own behaviour).
