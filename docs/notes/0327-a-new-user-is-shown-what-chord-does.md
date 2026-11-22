# 0327 — A new user is shown what Chord does

**Status**: accepted
**Date**: 2026-11-06

## Context

A new user signs in and goes straight to the AI consent screen (ADR 0283).
That screen explains what data goes to the model, but nothing said what Chord
is FOR. So the first question the app asked was "may we read your mail?",
before the person knew why they would want that. Nothing in the app showed the
mailbox features (action items, calendar, school mail, drafted replies,
sharing with a partner, the chat, shared lists) until someone found them.

## Decision

- **Twelve animated pages after sign-in, before the consent screen** (`/intro`):
  bring your mail, never miss an ask, dates go on the calendar, school mail
  sorted, clear out the clutter (mass unsubscribe), replies written for you,
  pass it to your partner, just ask Chord, shared lists, trips, saves, and
  much more (added 2026-11-11). Copy and the show/skip rule live in
  `kernel/src/first-launch-intro.ts` (`INTRO_SLIDES`, `shouldShowIntro`).
- **Animated drawings, not screenshots.** Each page is a small scene drawn with
  plain React Native views and `@expo/vector-icons`, driven by one looping
  clock (`mobile/src/intro-art.tsx`). Core `Animated` only: no native module,
  so it ships over the air and draws the same on iOS, Android and the web.
  Screenshots go stale with every UI change and say nothing at phone size.
  With Reduce Motion on, the finished picture is shown still.
- **Shown once per device, only to someone new.** "New" is "AI consent not
  answered yet", which is what a first sign-in looks like to the app. An
  update does not put twelve pages in front of existing users, and someone who
  answered on another device is not shown it again on a new phone. The seen
  flag (`app.introSeen`) is kept on sign-out (ADR 0269's allow-list): it says
  nothing about the person.
- **Skip and Get started both go on to the consent screen**, with the same
  return path the app would have used. Settings → Account → "What Chord does"
  plays it again (`replay=1`, back to Settings).
- The copy makes no promise the product does not keep: replies are DRAFTED
  and sent by the person (ADR 0197), events are added with a tap (ADR 0009's
  confirm), and only Google and Microsoft sign-in bring the mailbox with them
  (ADR 0230/0293); other providers are added in Settings.

No bot tool: the intro changes nothing (CLAUDE.md's rule covers mutating
capabilities only). No iOS-only code, so nothing to add to ADR 0263's list.

## Consequences

- One more screen between sign-in and the app for a new user (skippable).
- A family member who signs in on a second device after answering consent
  never sees the intro there unless they open it from Settings.

## Rejected

- **Screenshots or a recorded video**: stale after the next UI change, heavy,
  and unreadable at phone size.
- **Lottie / Rive animations**: a native module (not OTA-safe) and an asset
  pipeline for eight short scenes.
- **Showing it before sign-in on the landing page**: the web landing page
  already explains Chord; on phones the person has already chosen to sign in.
- **Showing it to every account that has not seen it on this device**: would
  hit every existing user on the next update.
- **A server-side seen flag**: the question is whether THIS device showed it,
  and an `AsyncStorage` key answers that without a round trip.

## Addendum 2026-11-11

- **On a phone it is the first thing after install, before the sign-in page.**
  Signed out with the intro not yet seen on this device, the root route sends
  the phone to `/intro?signin=1`, which returns to the sign-in page when done;
  the seen flag then stops it playing again at sign-in. Signed in, the old rule
  holds (only while consent is unanswered), so an update still does not show it
  to existing users. The web is unchanged: its signed-out page is the marketing
  site, and the intro plays at sign-in as before. `shouldShowIntro` takes
  `signedIn` and `native`.
- **Four more pages**: clear out the clutter (mailing lists never opened, left in
  one tap or sent to Trash; ADR 0307/0308), trips (confirmations become one trip,
  flights on the calendar, a night with no hotel is pointed out; ADR 0158/0190),
  saves, and a last "and much more" page (briefing, birthdays, packages,
  receipts, WhatsApp).
- Reaching people who already have the app needs the next store build: the
  intro is JavaScript and ships over the air, but builds that predate it only
  get it when they take an update.
