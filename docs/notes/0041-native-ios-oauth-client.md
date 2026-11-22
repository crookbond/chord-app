# 0041 — Native iOS uses its own Google OAuth client (per-client refresh-token binding)

**Status**: accepted
**Date**: 2026-06-03
**Extends**: [ADR 0014 — Google-only auth](./0014-google-only-auth.md), [ADR 0015 — Server-side Google Calendar](./0015-server-side-google-calendar.md)

## Context

Sign-in and calendar consent run a PKCE authorization-code flow in the
mobile client; the server exchanges the code and stores the refresh token
(`oauth.service.ts`). Until now every platform used the **web** OAuth
client, and both `app/index.tsx` and `app/settings.tsx` picked the client
id as `WEB ?? IOS ?? ANDROID` with a `chord://oauthredirect` redirect.

That works on web (redirect is `https://chordapp.ai/oauthredirect`) but the
standalone iOS build (TestFlight) fails with **`400 invalid_request`**:
Google **web** OAuth clients reject custom-scheme redirects. Native clients
must redirect to the **reversed-client-id** scheme
(`com.googleusercontent.apps.<id>:/oauthredirect`).

The complication: **Google binds a refresh token to the client that issued
it.** A token obtained via the iOS client (a *public* client, no secret)
cannot be refreshed with the web client + secret — it returns
`invalid_grant`. So the server can't just "also accept" the iOS client; it
has to refresh each token with the same client that minted it.

## Decision

- **Native iOS uses a dedicated public OAuth client.** The mobile app
  selects the client id by platform (`src/google-auth.ts`) and, on iOS,
  redirects to the reversed-client-id scheme — registered as an extra
  `scheme` in `app.json`. Web and Android behaviour is unchanged.
- **The server selects the client from the redirect_uri.** A redirect
  starting `com.googleusercontent.apps.` → the iOS client (`GOOGLE_CLIENT_ID_IOS`,
  no secret); otherwise the web client (id + secret). The `id_token`
  audience check accepts either client.
- **The issuing client id is persisted with the refresh token**
  (`users.refresh_token_client_id`, migration `008`). `getAccessToken`
  refreshes with that client — web id → send the secret, anything else →
  public client, no secret. Null (legacy rows) means web.

## Consequences

- iOS login + calendar connect work on the standalone build; web users are
  untouched (web branch unchanged, new column nullable = web).
- The iOS OAuth client must carry bundle id `app.chord.demo`; the server
  needs `GOOGLE_CLIENT_ID_IOS` set (added to `example.env` + deploy env).
- A URL-scheme change is native, so it requires a fresh EAS build, and the
  new column requires a server redeploy + `npm run migrate`.
- Android would need the same treatment (its own client + scheme) before
  native Android auth works; not done — no Android client is configured.
