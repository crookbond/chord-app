# ADR 0081 — Android Google sign-in rides the web client via an App Link redirect

**Status:** Accepted · 2026-07-28
**Extends:** [0041](./0041-native-ios-oauth-client.md) (native iOS OAuth client),
[0048](./0048-native-deeplinks-for-invite-links.md) (App Links)

## Context

Android was never wired for Google sign-in. `mobile/src/google-auth.ts` read an
`EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID` that nothing ever set, and the server's
`clientForRedirect` only knew the web and iOS clients — so an Android build
would have sent a `chord://` redirect to the confidential web client and been
rejected. The obvious fix looked like "do what ADR 0041 did for iOS: register an
Android OAuth client, redirect to its custom scheme, teach the server the third
client id."

That fix is not available. Google no longer supports custom URI schemes on
Android OAuth clients ("Custom URI schemes are no longer supported on Android
and Chrome apps" —
[OAuth 2.0 for Mobile & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)).
The Android client type is now reachable only through Play services'
Authorization API (`AuthorizationRequest` + `requestOfflineAccess(serverClientId)`),
which returns a server auth code the backend exchanges with the **web** client's
id and secret.

So the choice is not "which client id" but "which auth mechanism."

## Decision

**Android uses the web OAuth client and the same `expo-auth-session` browser
flow as web.** Google redirects to `<EXPO_PUBLIC_WEB_BASE>/nativeauth`, an https
URL the app claims with a verified Android App Link.

Consequences that fall out of that:

- **No Android client id, no new env var.** `GOOGLE_CLIENT_ID` resolves to the
  web client on both `web` and `android`.
- **No server change at all.** `clientForRedirect` already maps an https
  redirect to the web client (id + secret), `verifyIdToken` already accepts the
  web client's audience, and refresh tokens land bound to the web client — the
  same row shape web logins have produced since ADR 0014. The ADR 0041 client-id
  binding machinery is untouched.
- **A distinct path, `/nativeauth`, not the web flow's `/oauthredirect`.** The
  App Link intent filter claims whatever paths it declares, for every browser on
  the device. Pointing it at `/oauthredirect` would mean an Android user signing
  in through their *mobile browser* gets yanked into the app mid-flow, where no
  PKCE verifier matches the code. Separate paths keep the two flows disjoint.
- **`EXPO_PUBLIC_WEB_BASE` becomes a hard requirement for Android builds**, since
  the redirect must be an exact string registered on the web client. When it's
  missing, `GOOGLE_AUTH_ERROR` says so instead of letting `makeRedirectUri` fall
  back to `chord://` and fail at Google's consent screen with an opaque
  `400 invalid_request`. (This also means Android sign-in can't run against a
  LAN dev server: Google accepts https or `http://localhost`, not
  `http://192.168.x.x:8081`. Point Android dev builds at the deployed base —
  all three `eas.json` profiles already do.)

## Alternatives considered

**Play services Authorization API** (via `@react-native-google-signin/google-signin`)
— Google's blessed path, and immune to App Link verification problems. Rejected
for now: it's a native module with a config plugin, it needs an Android client
registered against both the EAS keystore *and* Play App Signing fingerprints,
and it doesn't run on web — so the four `useAuthRequest` call sites in
`index.tsx` / `settings.tsx` would fork into two auth implementations, one for
Android and one for everything else. Worth revisiting if App Link verification
proves flaky in the field, or if Chord ever wants the native account picker.

**Reusing the iOS client's reversed-client-id scheme on Android** — Google can't
easily tell which OS is calling, so it would probably work today. Rejected as
deliberate misuse of a client type that is bundle-id-scoped; it would break
without warning and leave refresh tokens bound to a client the Android build has
no legitimate claim to.

## Consequences

The dependency this buys is real: **Android sign-in does not work until
`assetlinks.json` carries the release keystore's SHA-256 and is deployed.** That
was already a tracked prerequisite for `/join` invite links
([`docs/ops/native-deeplinks.md`](../ops/native-deeplinks.md)), so it's a
sequencing constraint rather than new work — but it is now a *login* blocker,
not just a nice-to-have, and `autoVerify` is all-or-nothing per host, so a
malformed `/nativeauth` datum breaks `/join` too.

`mobile/app/nativeauth.tsx` covers the unverified window on a best-effort basis:
if the redirect lands in the browser instead of the app, the page bounces to
`chord://oauthredirect?<query>` — Google won't accept a custom scheme as a
*redirect_uri*, but Android routes it app-to-app fine. Whether
`WebBrowser.openAuthSessionAsync` resolves off a deep link whose scheme differs
from the declared redirect is not guaranteed, so treat this as a fallback that
may only get the user back into the app, not necessarily back into a completed
sign-in. Verification is the fix; this is the cushion.
