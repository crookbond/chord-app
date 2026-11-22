# 0254 — A launch opens on Action Items, and never on the sign-in page

**Status**: accepted
**Date**: 2026-10-16

## Context

Two things about opening the app, one a product choice and one a defect.

**Where it opens.** A launch (app or web) landed on the chat list, and the tab
bar ran Messages, Email, Action Items, Calendar, Settings. The owner wants the
app to open on what needs doing — Action Items (ADR 0070) — with Messages as
the centre tab.

**The sign-in flash.** Signed-in users saw the marketing page and sign-in card
every time. The root route rendered them from the first frame, then asked
`/health` and, only after that answered, `/me` — two requests in sequence —
and redirected once the user was known. Cold start on a phone makes that long
enough to read.

## Decision

- **Tab order**: Action Items, Email, **Messages (centre)**, Calendar, Settings.
  The route names and `chats` key are unchanged, so deep links and search hrefs
  still work.
- **Default landing**: the root redirect goes to `/catchup/actions` (a pending
  join code still wins, as before). Leaving a group, signing out and other
  in-flow returns are unchanged — they go where the context says.
- **No sign-in page for someone who is signed in.** A session token on the device
  is a cheap, local hint (an AsyncStorage read). `bootScreen` (kernel, tested)
  says: signed in -> the app; token present and the server not yet heard from ->
  a plain splash; no token -> the landing page immediately, with no added wait
  for visitors; a token the server rejects, or a server that cannot be reached,
  -> the landing page after all. `/me` now starts at the same moment as
  `/health` instead of after it.

## Consequences

- A returning user sees a spinner for the length of one `/me` call instead of
  a page they did not need, then Action Items.
- A signed-out visitor is unaffected (one local storage read before the page).
- If the server is slow and the token is good the splash lasts as long as that
  call; there is no timeout shortcut to the landing page, because showing the
  sign-in page to a signed-in user is the thing being removed.

## Rejected

- **Keep the landing page and redirect faster.** The page still flashes.
- **Skip `/health` for returning users.** It also carries the sign-in options
  and WhatsApp number the landing page needs when the token turns out dead.
- **Cache the last user and route optimistically.** A stale cache would open the
  app for a revoked session; the splash waits for the server instead.

## Addendum 2026-10-27: the web lands on Email

On the web a signed-in launch (and the AI-consent screen's default exit) now
lands on Email, not Action Items: the web app is used mostly as a mail reader.
Phones keep Action Items. One helper, `launchTab()` in `mobile/src/group-nav.tsx`,
decides for both callers. A pending join code still wins.

Found alongside: the Messages list could show a back button to whatever was
under it in the stack, though it is a tab root like the others (now
`headerBackVisible: false`, as Email, Calendar and Settings already had); and
inside a chat or its settings, tapping the Messages tab did nothing (it was
treated as a reselect of the screen in front). It now goes back to the chat
list (`MainBottomNav belowRoot`, `router.dismissTo('/groups')`).

## Addendum 2026-10-27 (later): phones land on Email too

The owner wants the iPhone and Android app to open on Email as the web does,
so `launchTab()` now returns `/email` on every platform and the platform split
is gone. Same two callers (root redirect, AI-consent default exit); a pending
join code still wins. Tab order, names and route keys are unchanged: Action
Items stays first in the bar, it just is no longer where a launch lands.
Reaches phones with the next OTA (JavaScript only, no native build).
