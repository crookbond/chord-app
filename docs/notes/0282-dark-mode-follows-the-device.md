# 0282 — Dark mode follows the device, and can be forced

**Status:** Accepted, 2026-10-20.

## Context

The app had one light palette (`mobile/src/theme.ts` `colors`), imported by
name in 55 files: about 1,300 `colors.x` reads, almost all inside
module-level `StyleSheet.create({...})` blocks, plus about 70 hardcoded
`#fff`s, most of them text on the near-black accent. `app.json` already said
`"userInterfaceStyle": "automatic"`, so the phone was offering dark mode and
the app ignored it.

A module-level `StyleSheet.create` reads its colors once, when the file is
first imported. On the web, react-native-web also turns each sheet into CSS
classes at that moment. So a dark palette cannot be swapped in later by
changing values; something has to rebuild the styles.

## Decision

- **Two palettes, one live `colors` object.** `theme.ts` holds a light and a
  dark palette with the same keys. `colors` is an object of getters that read
  the active palette, so a value read during render follows the scheme.
  New keys: `onAccent` (text and icons on a filled accent button, white in
  light, near-black in dark, since the accent turns light in dark mode) and
  four pale status tints (`warnBg`, `redBg`, `greenBg`, `amberBg`) that
  replaced hardcoded `#FEE2E2`-style backgrounds.
- **`themed((colors) => ({...}))` replaces `StyleSheet.create({...})`.** It
  builds the sheet once per scheme on first use and returns an object whose
  properties are getters, so `styles.row` at a use site is unchanged and
  returns the active scheme's style. The conversion was mechanical (62
  sheets); no screen's JSX changed for it. Colors copied into a module-level
  constant are the one thing that does not follow; a scan found one (the
  email wrapper CSS, deliberately fixed to paper colors) plus `group-chips`,
  converted to a `themed` sheet.
- **A scheme change remounts each screen's content, not the navigator.**
  Getters only help if components render again, and React Navigation does
  not re-render every screen when the root re-renders. The root `Stack` gets
  a `screenLayout` that wraps each screen in a fragment keyed on an `epoch`
  that changes with the scheme (the update banner, outside the Stack, is
  keyed the same way). Keying the `Stack` itself was tried first and fails
  on web with "Another navigator is already registered for this container":
  the new navigator registers before the old one unregisters. With
  `screenLayout` the navigator, its history and the current route survive;
  scroll position and an open disclosure are lost, and only when the theme
  actually changes.
- **System by default; Settings overrides.** Settings → Appearance → Theme:
  System / Light / Dark, stored per device in AsyncStorage
  (`app.colorScheme`, kept on sign-out like the other layout choices in
  ADR 0269). On native the override is also passed to
  `Appearance.setColorScheme`, so alerts, keyboards, pickers and web views
  match. In System mode an OS change is applied only while the app is active,
  because iOS flips the scheme while backgrounded to take its snapshots. On
  web the preference is read synchronously from localStorage so the first
  paint is right; `prefers-color-scheme` drives System; the document's
  `color-scheme` and background follow too. Native waits for the stored
  choice (one AsyncStorage read) before drawing the navigator.
- **Status bar** is set explicitly from the resolved scheme rather than
  `auto`, which would follow the OS, not the override.
- **Email HTML stays on white paper.** Most HTML mail is written for a white
  page and never sets a background; inverting it, or drawing it on a dark
  background, makes dark-on-dark text and breaks logos. In dark mode the
  reader puts the HTML body on a white rounded card with the light palette's
  text and link colors. Plain-text mail is ours to draw and follows the theme.
- **Colored marks keep their own colors.** Avatars, email category tiles,
  action badges, the trip orange and the RSVP buttons are colored chips that
  read on both backgrounds.

## No bot tool

Every UI capability normally gets a chat equivalent. This one does not: it is
a per-device display preference that changes nothing in Chord's data, and
the server never learns it, so a bot tool would have nothing to write. A user
in WhatsApp has no Chord theme at all.

## Consequences

- New code should use `themed` instead of `StyleSheet.create`, and
  `colors.onAccent` instead of `'#fff'` on accent fills. A plain
  `StyleSheet.create` still works but stays in whichever scheme was active
  when it was first read.
- An email that styles itself with `@media (prefers-color-scheme: dark)` can
  switch to light text inside a web view in dark mode while sitting on our
  white paper. Rare; not handled.
- The sign-in page (`app/index.tsx`) is themed, including the demo username
  field and buttons. Google's button keeps its own white style (Google's
  branding rules allow it on dark), and the black Apple button gets a border
  so it does not disappear into a dark page.
- Header back arrows needed `headerTintColor` on the root Stack; before, they
  took the navigation library's default and were dark on dark.

## Rejected

- **A `useTheme()` hook in every component.** Correct, but means touching
  every component and every helper that reads a color, by hand, across 55
  files.
- **Reloading the app on a theme change.** Works with no remount logic, but
  native needs the preference before any module evaluates, which AsyncStorage
  cannot give synchronously.
- **Inverting email HTML** (as some mail apps do with color heuristics):
  unpredictable on logos and brand colors; white paper is always readable.
