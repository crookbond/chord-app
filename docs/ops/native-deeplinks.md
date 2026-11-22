# Native deep-linking (invite links)

How `https://chordapp.ai/join/<CODE>` opens the Chord app on a device that
has it installed. Design rationale: [ADR 0048](../notes/0048-native-deeplinks-for-invite-links.md).

> **Android sign-in depends on this too.** Since
> [ADR 0081](../notes/0081-android-oauth-via-app-link-redirect.md), Google's
> OAuth redirect for the Android build is `https://chordapp.ai/nativeauth`,
> claimed by the same App Link verification. Until §2 below is done, Android
> users can't sign in at all — not just "invite links open the browser."

## One-time setup before it works

### 1. Apple Team ID — ✅ done

`apple-app-site-association` uses `appID` **`5YLAQB2ZQZ.app.chord.demo`**
(Team ID `5YLAQB2ZQZ`, "John Doe"). Nothing to do unless the Apple team or
bundle id changes. Find a Team ID at: Apple Developer portal → Membership →
**Team ID** (10 chars).

### 2. Android signing-cert SHA-256 — ✅ both keys

`mobile/public/.well-known/assetlinks.json` carries **two** fingerprints,
because an Android app is checked against whichever certificate actually
signed the copy on the device:

```
52:F6:A2:A4:E2:65:0F:74:EC:C4:6C:1C:CC:D5:06:45:54:BC:D5:22:06:7F:B6:18:81:DE:49:69:EA:32:3F:10  EAS upload keystore
CB:1E:92:A9:F9:94:98:91:98:5B:8F:BB:A8:82:74:92:85:4D:2F:07:E5:B6:CD:EE:B6:75:97:65:D8:D2:53:6A  Play app signing key
```

The first covers APKs installed directly from an EAS link. The second covers
**every Play install**: uploading an AAB makes Google re-sign it with its own
app-signing key, so a store install presents a *different* certificate. With
only the upload key listed, App Links — and therefore Google sign-in (ADR
0081) — work for sideloaded testers and silently fail for everyone who
installs from Play.

Both must stay. Removing either breaks one install path and nothing warns you.

The Play key was minted on the first AAB upload (28 Oct 2026). Don't transcribe
it by hand: **Play Console → Test and release → App integrity → App signing**
renders a ready-made **Digital Asset Links JSON** block at the bottom of the
page with the correct fingerprint already in it — that is the authoritative
source, and it avoids mistaking the upload key's fingerprint for the signing
key's (the page shows both as unlabelled copy buttons).

Reading the fingerprint back, in order of convenience:

```bash
cd mobile
npx eas-cli credentials     # Android → Build credentials → keystore (interactive TUI)
```

There is no non-interactive eas-cli command for this. If a terminal menu is not
an option, the fingerprint can be read off the signed artifact instead — an EAS
APK is v2/v3-signed, so the certificate is in the APK Signing Block, not
`META-INF`:
```powershell
# Downloads nothing; point it at an APK from `eas build:view <id> --json`.
scripts\read-apk-cert.ps1 -ApkPath <path-to.apk>
```

It parses the APK Signing Block with .NET only (no JDK — there is none on the
current dev machine) and prints the SHA-256 the way `assetlinks.json` wants it.
`keytool -printcert -jarfile` is the equivalent where a JDK exists.

## Deploy order

1. Make sure no placeholder is left in either well-known file.
2. Deploy the web app so `chordapp.ai/.well-known/*` serves the real files.
   **The fingerprint only takes effect once this deploy lands** — the file is
   served from the web build, so an edit in the repo changes nothing until then.
3. `eas build` (preview or production) — the new `associatedDomains` /
   `intentFilters` are baked into the binary at build time.

## Verify the well-known files are served correctly

```bash
# Must be 200, application/json-ish, and NOT a redirect.
curl -sSI https://chordapp.ai/.well-known/apple-app-site-association
curl -sS  https://chordapp.ai/.well-known/apple-app-site-association | jq .
curl -sS  https://chordapp.ai/.well-known/assetlinks.json | jq .
```

- No `Location:` header (no 301/302) on the AASA request.
- Apple validator: <https://app-site-association.cdn-apple.com/a/v1/chordapp.ai>
- Android validator: Google Digital Asset Links API, or
  `adb shell pm verify-app-links --re-verify app.chord.demo` then
  `adb shell pm get-app-links app.chord.demo` (expect `verified`).

## Test on device

1. Install the EAS build on a real device (Universal/App Links do **not**
   fire in the iOS Simulator or from Expo Go).
2. Send yourself `https://chordapp.ai/join/<CODE>` and open it from Notes /
   Messages (not by typing in the browser bar — iOS only honors the app
   hand-off when the link is *tapped* from another app).
3. Expect: the Chord app opens on the join screen.
   - **Signed in** → joins and lands in the group chat.
   - **Signed out** → stashes the code, runs Google sign-in, resumes the join
     (same path as web — ADR 0047).
4. **No app installed** → the link opens the web app in the browser. This is
   also the fallback whenever verification hasn't completed (placeholders
   still in place, files not yet deployed, or OS verification pending).

## Gotchas

- **iOS caches the AASA** at install time and via Apple's CDN. After changing
  the file, delete + reinstall the app to force a re-fetch (or wait out the
  CDN TTL).
- **Android `autoVerify` is all-or-nothing** per host: if any declared
  intent-filter datum fails verification, the link won't auto-open — and since
  ADR 0081 that takes sign-in down with it. Keep the filter scoped to
  `host chordapp.ai` and the three declared prefixes (`/join`, `/welcome`,
  `/nativeauth`).
- **Host must match everywhere.** `associatedDomains`, the intent-filter
  `host`, the well-known hosting domain, and `EXPO_PUBLIC_WEB_BASE` are all
  `chordapp.ai`. Changing to a subdomain means changing all four together.
