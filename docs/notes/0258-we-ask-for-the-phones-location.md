# 0258 — We ask for the phone's location, and use it when it is given

**Status**: accepted
**Date**: 2026-10-16
**Supersedes in part**: ADR 0091 (the "without a location permission" premise),
amends ADR 0148 (what the "you seem to have moved" check compares against)

## Context

ADR 0091 chose to find a user's weather location *without ever asking* for one:
the network address looked up against GeoLite2, then the time zone. The privacy
screen said "Chord never asks for your device location". It was a consistent
position and it cost accuracy: an address lookup is wrong on a VPN, a carrier
gateway or a private relay, and the time zone spans a continent. Chord ended up
being careful never to ask while still wanting the answer — an IP-derived city
is a location, just one the person did not get to decide about.

The owner's call on 2026-10-16: **ask, use it if it is given, fall back to what
we do now.**

## Decision

The weather location now has four tiers, best first:

1. **`user`** — an explicit Settings choice. Unchanged and still outranks
   everything: it has to survive travel, which is exactly when the automatic
   tiers move.
2. **`device`** — the phone's (or browser's) own fix, **only when the user
   allowed it.** New.
3. **`ip`** — GeoLite2 against the request address. Unchanged; now the fallback
   for people who said no or whose device cannot say.
4. **`tz`** — the city in the time-zone name. Unchanged.

- **The ask.** Once, on Action Items (where a launch lands, ADR 0254), a card
  explains the purpose and offers *Use my location* / *Not now*; the system
  prompt only appears after a yes. It is never repeated once answered, and
  Settings → Daily briefing → *Use my location* turns it on later or off.
- **Approximate, foreground, minimal.** The least precise fix the OS offers
  (`Accuracy.Low`), only while the app is open, refreshed at most every 30
  minutes. The server rounds coordinates to two decimals (about a kilometre)
  before keeping them, does not re-write a fix that has not moved, and keeps no
  history — one current fix per user.
- **A fix follows the phone.** `PUT /me/location` becomes the weather location
  unless the source is `user`; `DELETE /me/location` forgets it (and, if it was
  what the weather used, lets IP / time zone take over). The IP lookup never
  overwrites a `device` location. A fix that arrives with no name (a browser has
  no reverse geocoder) is named by the time-zone city when that is within 150 km,
  else "Your location".
- **ADR 0148's "you seem to have moved" check** now compares an explicit choice
  against the phone's fix first (up to three days old), then the IP city, then
  the time zone. A `device` location needs no question: it moves with the phone.
- **Revoked in the phone's settings?** The next foreground notices, stops using
  the fix and tells the server.
- **Old builds survive.** `expo-location` is native, so a build made before it
  shipped does not have it; the module is loaded lazily and every call degrades
  to "unsupported". An OTA of this JavaScript will not crash an older binary.
  Location itself works only on a build that includes the module.

## Consequences

- **A native build and store review are required** for phones to use it. The web
  works on the next deploy (browser geolocation).
- **Store paperwork**: an iOS usage description (`NSLocationWhenInUseUsageDescription`,
  added), the App Store privacy label ("Coarse Location", used for app
  functionality, not tracking) and Google Play's Data safety form
  (approximate location) must be updated by hand. Android requests
  `ACCESS_COARSE_LOCATION` only.
- **The privacy screen and `chord-privacy-policy.txt` are rewritten**: Chord now
  asks, says what it keeps, and credits Open-Meteo (CC BY 4.0 — the attribution
  ADR 0257 found missing).
- **No bot tool is added for the permission.** Granting location is an OS gesture
  that cannot be said in chat. A *place* can still be set by chat
  (`set_weather_location`), and the bot is told when the weather is following the
  phone.
- GeoLite2 stays (attribution and refresh duties in ADR 0257 still apply); it
  becomes the second choice rather than the first.

## Rejected

- **Retire GeoLite2.** Many people will say no, use WhatsApp only, or be on web
  without granting; the IP tier is the better of the fallbacks.
- **Always-on or background location.** A city is all a forecast needs; background
  access would be a larger permission, a worse review, and a bigger promise.
- **Device location overriding an explicit choice.** That is how a typed city
  gets silently replaced while travelling (ADR 0148's whole point).
- **Storing a location history.** Nothing needs one.

## Addendum 2026-10-26: a lazy import is not a guard

The PR 171 OTA loaded `expo-secure-store` the way this ADR loads `expo-location`: `await import(...)` inside try/catch. The installed iPhone build had no `ExpoSecureStore` native module, the package threw while loading, and Metro's loader reported that as a fatal error (`guardedLoadModule` calls `ErrorUtils.reportFatalError` for a module loaded outside another module's load) before the catch ran, so tapping the Email tab closed the app. `expo-location` only worked because every build since this ADR includes it. Optional native packages now load through `importIfNative(nativeName, load)` (`mobile/src/optional-native.ts`, rule in `kernel/src/optional-native.ts`), which asks `requireOptionalNativeModule` first and never loads the package when the module is absent. `server/src/__tests__/optional-native.test.ts` runs Metro's real loader to show both the failure and the fix.
