# 0316 — The web app never holds its own session, and email is drawn in a sealed frame

Status: accepted (2026-11-01)
Amends: ADR 0269 (session tokens), ADR 0120/0136/0225 (email images), ADR 0294 (suspect senders)

## Context

The 2026-11-01 audit found two weaknesses that only matter together. On the
web, the session token lived in `localStorage` (AsyncStorage on web), was sent
as `x-chord-token`, and was put in the two live-update URLs as `?token=`. And
the web reader put the cleaned email HTML straight into the app's own page
(`dangerouslySetInnerHTML`). Any gap in the HTML cleaner, or a flaw in the
cleaning library, would run script in the page that holds the token: one
bad email, and the account is gone. Phones were already safer: the email is
drawn in a separate WebView, and native storage is not reachable from it.

## Decision

**1. On the web the session is only the httpOnly cookie.** The server already
set `chord.sid` (httpOnly, SameSite=Lax, Secure in production) at every sign-in
and `loadSession` already accepted it. Now the web client:

- stores no token (`setToken` deletes any stored copy, `getToken()` is null),
- sends no `x-chord-token`, and no `?token=` on the two stream URLs (same
  origin, so EventSource sends the cookie),
- decides "signed in" by asking `/me` instead of looking for a stored token
  (kernel `deviceMayHaveSession`, `bootScreen`/`enterWithSavedUser` take a
  `web` flag); a saved user plus an unreachable server still opens offline
  (ADR 0311),
- moves existing users over with `POST /api/v1/session/adopt`, which takes a
  stored token in the header only, checks it, and sets the cookie for the same
  session; the stored copy is deleted after. A network failure keeps it for the
  next load, so nobody is signed out.

Phones keep the stored token and the header: there is no page script there to
steal it, and native requests do not carry cookies reliably.

**Cross-site requests.** A cookie is sent by the browser on its own, so a write
(anything but GET/HEAD/OPTIONS) authenticated ONLY by the cookie must also
carry `x-chord-csrf: 1` (`CSRF_HEADER` in kernel); without it the request runs
as signed out and `requireSession` answers 403. Another site cannot add a
custom header without a CORS preflight, which the allow-list refuses. SameSite=Lax
already keeps the cookie off cross-site subresource requests; the header covers
what Lax lets through. Header and bearer clients are unaffected. Account deletion
now clears the cookie (logout already did). GET routes that change something
while signed in were checked: starting a mail sync and the one-time read-time
check when a thread opens, both idempotent background work; left as they are.

Dev web points the API at the page's own host (`<page host>:4000`) so page and
API are the same site and the Lax cookie is sent.

**2. On the web, email HTML is drawn in a sealed frame.** The reader renders the
same document the phone builds (same cleaner output, `emailBodyCsp`, proxy and
inline-image URLs carrying the image token, never the session) into
`<iframe srcdoc sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox">`
with **no `allow-same-origin`**: the frame has an opaque origin and cannot read the
app's storage, cookies or page. The only script inside is Chord's height probe,
allowed by a fresh nonce per document (`emailBodyCsp(..., { scriptNonce })`);
the frame also inherits the app page's policy (`mobile/public/index.html`).
Everything that used to reach into the email's page now arrives as a message
from the frame: the height, and a click on a link. The app acts on a message only
when it comes from that frame's window and kernel `parseEmailFrameMessage` accepts
it (a height, rounded and capped; or an http/https/mailto link under 8 KB);
anything else is ignored. The quote toggle, the plain-text view for suspect
senders, the white paper card in dark mode and print/share sit outside the
frame and are unchanged.

## Consequences

- A flaw in the cleaner now runs, at worst, inside a frame that can reach
  nothing. Even script in the app page itself can no longer read the session.
- The server still accepts `?token=` on the two stream paths, for web tabs still
  open on an older build; it can be removed once those are gone.
- An email taller than 100,000 px is clipped at that height.
- A Ctrl/Cmd-click on a link opens through the sandbox's popup, so the browser
  follows the link without Chord's scheme check. The cleaner already limits link
  schemes to http, https, mailto and cid.
- Checked in the real dev web app (demo sign-in, mock mail), 2026-11-01:
  - Sign-in, the AI-consent write, the inbox and the live-update stream work.
  - Nothing token-like is in localStorage, and `document.cookie` does not show `chord.sid`.
  - A cookie-only write without the header gets 403, and 201 with it.
  - Sign-out returns to the landing page and `/me` answers 401.
  - In the reader, an HTML email shows on a white card in dark mode and fits its height with no inner scrollbar.
  - A 900px table is shrunk to fit.
  - The email's `<script>` and `onerror` are removed, and the page cannot read the frame.
  - Showing the quoted text grows the frame.

  Not checked:
  - Link clicks inside the frame: the browser tool cannot dispatch into a scaled frame. They are covered by `email-frame.test.ts` and an earlier test page.
  - Google, Apple and Microsoft sign-in.
  - Images through the proxy.
- The click-through found that `.env`'s `EXPO_PUBLIC_API_BASE=http://127.0.0.1:4000`
  (and example.env's LAN address) put the dev API on a different site from a
  page on `localhost:8081`, so the Lax cookie never came back. `webApiBase`
  (kernel) now uses the page's host name when both are this machine or the local
  network; a public API host is never rewritten.

## Rejected

- **Token kept in memory only on web**: still readable by script in the page.
- **A CSRF token round-trip**: a fixed custom header is enough when the CORS
  allow-list refuses other origins' preflights, and needs no state.
- **`allow-same-origin` on the frame** (simpler height reading): it would give the
  email's page the app's origin, which defeats the frame.
- **A shadow DOM instead of a frame**: styles are isolated but script is not.
