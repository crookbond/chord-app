# 0263 — Android is brought level with the iPhone app

**Status**: accepted
**Date**: 2026-10-13
**Relates to**: [ADR 0241 — billing in the browser on an iPhone](./0241-on-an-iphone-billing-is-managed-in-the-browser.md), [ADR 0081 — Android sign-in via App Link](./0081-android-oauth-via-app-link-redirect.md), [ADR 0043 — account deletion](./0043-account-deletion.md), [ADR 0065](./0065-deterministic-contact-discovery.md) / [0157](./0157-inviting-someone-to-an-event.md) / [0212](./0212-the-bot-asks-your-phone-for-one-contact.md) (contacts)

## Context

The Android app was deferred on 2026-09-10. The code is one codebase, so most
of it already runs on Android, but nothing had been done for a Google Play
submission: `eas.json` had no Android build or submit profile, the app had no
launcher or notification icon for Android, it requested permissions it never
uses, it sold plans through a Stripe checkout inside the app, and two of the
three places that ask for Contacts did so with no explanation first.

## Decision

Changes inside the app and its build config only. Console work (Play listing,
signing fingerprint, Firebase) is the owner's and is listed under Consequences.

- **Billing is managed in the browser, as on an iPhone.** Google Play requires
  Play Billing for a subscription sold inside an app, and Chord has none. The
  AI Plan card on Android now shows what ADR 0241 shows on an iPhone: the plan,
  its dates, and one **Manage billing** button that opens the browser. The
  switch is `ANDROID_BILLING_LINK_OUT` in `plan-card.tsx`, separate from
  `IOS_BILLING_LINK_OUT`; both feed one `BILLING_LINK_OUT`. Connect OpenRouter
  follows the same switch and returns on `chord://settings?byok=`.
- **Contacts are explained before they are asked for.** Play wants an in-app
  explanation of what is read and where it goes before the system prompt, with
  the person agreeing. `ensureContactsAccess(what)` (`mobile/src/contacts-access.ts`)
  shows it on Android and then asks; iOS is unchanged because its system prompt
  already carries the app's usage text. Used by the bot's contact lookup (ADR
  0212) and the invite-a-guest picker (ADR 0157). Find friends already had its
  own explanation screen.
- **A public account-deletion page** at `/delete-account`, linked from the
  landing page footer. Play's Data safety form needs a web address where
  deletion can be requested without the app. It gives the in-app and web steps,
  an email address for people who cannot sign in, and what is deleted and kept
  (ADR 0043's teardown, the privacy policy's 10 days).
- **Only the permissions the app uses.** The generated manifest carried
  `RECORD_AUDIO` (image picker default), `WRITE_CONTACTS` (contacts module
  default) and the two legacy storage permissions. None is used: the app takes
  photos, never video; reads contacts, never writes them; and uses app-private
  storage and the system pickers. `ACCESS_FINE_LOCATION` (added by
  `expo-location`, ADR 0258) is removed too: the app asks only for low accuracy,
  and ADR 0258 promises an approximate location. They are removed
  (`microphonePermission: false`, `android.blockedPermissions`). Each one left
  in would need its own line in the Data safety form.
- **Icons.** `assets/adaptive-icon.png` (the icon at 74% on white, so the
  launcher's mask does not cut it) and `assets/notification-icon.png` (white
  shape on transparent, which is all Android draws in the status bar).
- **Build and submit profiles.** `preview` builds an APK for direct install;
  `production` builds an app bundle; `submit.production.android` uploads to the
  internal track as a draft using `mobile/play-service-account.json`, which is
  git-ignored.
- **Push config is read when present.** Android push goes through Firebase.
  `app.config.js` sets `android.googleServicesFile` from the EAS file variable
  `GOOGLE_SERVICES_JSON`, else from `mobile/google-services.json` if it exists.
  With neither the build works and push does not.

No server change and no new capability, so no bot tool.

## Consequences

- **Not run on an Android device.** The mobile app typechecks and the generated
  manifest was inspected (`expo config --type introspect`), but nothing here
  was exercised on a phone. Keyboard behaviour in the chat and composer screens
  (they pass no `behavior` to `KeyboardAvoidingView` on Android and rely on
  `adjustResize`) is the first thing to check on a real build.
- **The billing button is a review risk on Play, as it is on the App Store.**
  Play's payments policy allows an app to give access to a plan bought
  elsewhere; a link to where it is bought is allowed in the US and restricted
  elsewhere. If review objects, the fallback is ADR 0241's: no button, text
  only.
- The bot's `get_checkout_link` still returns a checkout link on Android, as it
  does on an iPhone.
- The first contact lookup from chat on Android now shows two dialogs (ours,
  then the system's) and will usually outlast the server's 8-second wait, so
  that first answer comes from saved People; later ones come from the phone.
- Sign in with Apple is offered on Android through the browser (addendum
  below), and only when the server has a Services ID (`/health.appleWeb`).
- Reminders sync stays iPhone-only; Android has no system reminders store.
- Removing the microphone text also removes it from the next iOS build, where
  it was equally unused.
- **Still to do outside the repo before a Play build works**: put the Play
  app-signing and EAS upload SHA-256 fingerprints in `assetlinks.json` (Google
  sign-in on Android does not work without it, ADR 0081); create the Firebase
  project, add `google-services.json` and upload the FCM key to EAS; create the
  Play service account key; decide the package name (`app.chord.demo` is
  permanent once published).

## Rejected

- **Google Play Billing** - the same work ADR 0241 shelved for Apple: products,
  a second seller on the server, a native module.
- **Keeping the in-app Stripe checkout on Android** - Play rejects it.
- **One switch for both stores** - the two stores can rule differently on the
  same button, and one may need the text-only fallback while the other does not.
- **A full-screen contacts explanation** - an alert that must be accepted
  before the system prompt meets the requirement and needs no new screen.
- **Blocking `SYSTEM_ALERT_WINDOW`** - development builds use it and it is not
  a sensitive permission.

## Addendum 2026-10-17 - an iPhone-by-iPhone pass

Every platform branch in the app was read against what the iPhone does. Seven
places behaved differently on Android without anyone choosing that:

- **Sign in with Apple.** iOS has a native sheet; Android has none, so someone
  who signed up with Apple could not sign in. Android now runs the web flow
  (ADR 0156 addendum) in a Custom Tab. Its state carries the prefix `android.`
  (`APPLE_NATIVE_STATE_PREFIX`), and the server's callback sends a marked state
  to `/nativeauth` (`appleReturnPath`) - the App Link Android already catches
  for Google (ADR 0081) - instead of the web app's root. Same origin either
  way, so it is not an open redirect; the state is still checked on the phone
  and the code is redeemed as the web client. Needs the same `assetlinks.json`
  fingerprint as Google sign-in.
- **The keyboard.** Expo 54 draws Android edge-to-edge, so the window no longer
  shrinks for the keyboard. The chat, composer, forward, reader and label-sheet
  screens passed no `behavior` to `KeyboardAvoidingView` on Android, so their
  text box sat under the keyboard. All use `padding` now; the chat's offset is
  the real header height on Android (80 stays on iOS).
- **The tab bar and bottom sheets.** Edge-to-edge also puts Android's system
  navigation bar on top of the app and its modals; with 3-button navigation the
  back/home buttons covered the tabs and the last row of the chat menu, attach
  sheet, mail-folder sheet and source sheet. `useAndroidBottomInset`
  (`mobile/src/system-bars.ts`) adds that room on Android only.
- **The task menu.** Its ⋯ alert had eight buttons; Android draws three and
  drops the rest, so Drop and Delete were unreachable. On Android the same
  actions open in the reader's `ActionSheet`.
- **Which phone calendar Chord writes to, and which it skips.** The "is this a
  Google calendar" test only knew an iPhone's CalDAV account; Android files
  Google calendars under the account type `com.google`. So Android wrote to a
  phone-only "Chord" calendar instead of the Google one (ADR 0057), and with
  Google connected it would mirror and ghost the connected account's own
  calendars - every Google event twice. One rule, `isGoogleBackedSource`, and
  `pickAndroidWriteCalendar` (Google primary, other writable Google, phone
  primary, then Chord's own) in `kernel/src/device-calendar.ts`, tested.
- **Notifications.** The Android channel was created at default importance -
  into the shade, no banner - and the server set no channel or priority, so a
  dozing phone could hold a message back. The channel is HIGH now and every
  push names it at `priority: 'high'` (`buildPushMessages`). iOS already went at
  Apple's immediate priority, so nothing changes there.
- **Opening a file, and opening a card's app link.** iOS shows Quick Look
  through the share sheet; Android's share sheet can only send a file on. Android
  now opens it with a viewer (`expo-intent-launcher`, ACTION_VIEW, share sheet as
  the fallback). And Android 11+ answers `canOpenURL` false for any app the
  manifest does not declare, so a card's `sms:` link (the family-invite text,
  ADR 0237) opened the invite web page instead of Messages; Android now tries
  the app link directly and falls back on rejection.

The privacy policy no longer says Apple sign-in is iPhone-only.

**Still different, on purpose or for want of an Android equivalent**: Reminders
sync (Android has no system reminders store); the EventKit external-id helper
(`modules/chord-eventkit`, Layer 0 of the device-calendar dedup) is iOS-only,
so an Android mirror relies on the source exclusion and the server's fuzzy
dedup; and the dormant App Store purchase path.

**Not run on a device.** Each change typechecks and the server-side ones are
tested (the Apple return path, the calendar rules, the push message), but none
has been exercised on an Android phone. The Apple flow in particular depends on
the Custom Tab handing the `/nativeauth` App Link back with its fragment, which
is the same unverified mechanism as Google sign-in on Android.

## Addendum 2026-11-23: R8 on release builds, and the edge-to-edge warning

Play Console flagged two things on Production release 7 (1.0.0).

**DEX obfuscation at 2% (Play wants 25%, by Feb 2027).** Release builds were
not minified. `expo-build-properties` now sets
`android.enableMinifyInReleaseBuilds` (R8 shrinks and renames; the Expo
template's `proguard-rules.pro` already keeps reanimated and the turbomodule
classes). Every native module Chord ships either needs no rule (React Native,
Hermes, screens, gesture handler and safe-area work through annotations RN's
own consumer rules keep) or brings its own consumer rules (expo-modules-core,
expo-updates, expo-notifications, reanimated, worklets). The extra rules keep
RevenueCat whole (`react-native-purchases` ships none of its own, and the
classes are iOS-only in use today, so the keep costs nothing that matters) and
keep file and line numbers in stack traces. Resource shrinking stays OFF: some
resources are found by name at run time (the notification icon), which the
shrinker cannot see. A preview APK is built `release`, so it is minified too
and is the device test. The R8 mapping file travels inside the app bundle
(AGP puts it in BUNDLE-METADATA, and Play reads it for crash reports); EAS also
keeps `mapping.txt` as a build artifact (`buildArtifactPaths`) for uploading by
hand if Play does not show it under App bundle explorer, Downloads.

**"Deprecated APIs or parameters for edge-to-edge" (recommended, no deadline).**
Not caused by Chord's code or config. The app is already edge-to-edge (SDK 54
default; `edgeToEdgeEnabled=true` in the generated project), and Play's scan
reads the compiled code, so a call guarded by an Android version check still
counts. The calls it finds are in libraries: React Native 0.81's
`WindowUtil.enableEdgeToEdge` and `StatusBarModule` (`setStatusBarColor`,
`setNavigationBarColor`, `LAYOUT_IN_DISPLAY_CUTOUT_MODE_*`),
react-native-screens' `ScreenWindowTraits`, and expo-image-picker's crop
screen. They clear when those libraries drop the calls (an Expo SDK upgrade),
not through anything in `app.json`. The generated theme also carries
`android:statusBarColor`, written by Expo's own splash plugin whatever the
config says, and ignored by Android 15+. `useAndroidBottomInset` and the
keyboard handling are unchanged.
