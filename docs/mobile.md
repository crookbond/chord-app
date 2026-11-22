# Shipping Chord as a native app (iOS + Android)

> **Backend prerequisite:** done as of [ADR 0038](./notes/0038-sqlite-to-postgres.md) — the server runs on Postgres. Earlier drafts of this doc gated the iOS work on that migration; that's no longer a blocker.

This is a real Expo + React Native app (not a PWA / homescreen bookmark). The
`mobile/` workspace already declares the iOS bundle id (`app.chord.demo`),
calendar permissions, and new-architecture flag in `app.json`. The build
pipeline is configured — `eas.json` declares development/preview/production
profiles — leaving only some release hygiene.

## Build options

### Option A — EAS Build (recommended, no Mac required)

Expo compiles the `.ipa` on their cloud Macs.

```bash
npm i -g eas-cli
eas login                      # free Expo account
cd mobile
# eas.json is already committed (development/preview/production profiles)
```

| Goal | Command | Notes |
|---|---|---|
| Try on own iPhone fast | `eas build --profile development --platform ios` | Dev Client install via QR/link |
| TestFlight / testers | `eas build --profile preview --platform ios` | Internal distribution |
| App Store release | `eas build --profile production --platform ios` → `eas submit -p ios` | App Store Connect |

**Hard requirement:** Apple Developer Program membership (**$99/yr**). Required
for running on a physical device beyond the 7-day free-provisioning window, and
for TestFlight / App Store. EAS manages certs/provisioning once logged in.

### Option B — Local build with Xcode (needs a Mac)

```bash
cd mobile
npx expo prebuild -p ios       # generates native ios/ (managed -> bare, ~one-way)
npx expo run:ios
```

Only if you need native-module control. Prefer Option A otherwise.

## Android

Same profiles, same commands, `--platform android`:

| Goal | Command | Output |
|---|---|---|
| Sideload / testers | `eas build --profile preview --platform android` | APK from the EAS link |
| Play Store | `eas build --profile production --platform android` → `eas submit -p android` | AAB |

No Apple-style paid membership needed to install a preview APK; Play Store
distribution needs a one-time $25 Play Console account.

### Android prerequisites, in order

1. **Signing keystore.** First `eas build` generates one. Grab its fingerprint
   afterwards — `eas credentials` → Android → production keystore.
2. **App Links (blocks sign-in).** Put that SHA-256 into
   `mobile/public/.well-known/assetlinks.json` and deploy the web app. Google
   sign-in redirects through `https://chordapp.ai/nativeauth`
   ([ADR 0081](./notes/0081-android-oauth-via-app-link-redirect.md)), so an
   unverified App Link means nobody can log in. Full procedure + validators:
   [`ops/native-deeplinks.md`](./ops/native-deeplinks.md).
3. **Register the redirect.** Add `https://chordapp.ai/nativeauth` to the **web**
   OAuth client's Authorized Redirect URIs. There is no Android OAuth client —
   see the ADR for why.
4. **FCM, if you want push.** Expo push on Android needs an FCM V1 service
   account key uploaded to EAS and a `google-services.json` in the build.
   Without it, ADR 0054 notifications silently no-op on Android while iOS keeps
   working.

## Release hygiene before a real build

- Version is `1.0.0` in `app.json`; build numbers auto-increment via
  `eas.json` (`autoIncrement`).
- App icon (1024px) is configured (`app.json` `icon` → `./assets/icon.png`);
  splash screen may still need configuring — App Store rejects without one.
- Server URL — a phone can't reach `127.0.0.1`. Build must point
  `EXPO_PUBLIC_*` at a deployed HTTPS server, not localhost.

## Architecture reminder

Chord is client + Express/Postgres server. The iPhone app is only the front end;
it needs the server reachable over public HTTPS. "Convert to iPhone app" = two
tracks: (1) build the client for iOS, (2) host the server with a public URL and
point the build at it.

---

## TODO before / during device testing

- [ ] **Calendar sync (read + write)** — verify `expo-calendar` read/write works
      on a real device (simulator calendar behavior differs). Permission strings
      already set in `app.json` (`NSCalendarsUsageDescription`).
- [ ] **Phone-number-only signup** — add a signup path that needs only a phone
      number (no Google account). Currently auth is Google-only (ADR 0014).
- [ ] **Age gate (13+)** — user must attest they are over 13 at signup.
- [ ] **Re-scope Google Calendar** — potentially drop the group-calendar
      scoping (ADRs 0030/0015) and keep Google **only for signup**, decoupling
      calendar sync from Google. Revisit those ADRs if we go this route.
