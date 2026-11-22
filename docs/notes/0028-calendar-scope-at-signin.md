# 0028 — Request Google Calendar scope at sign-in

**Status**: accepted
**Date**: 2026-05-16
**Supersedes (in part)**: [ADR 0015 — Server-side Google Calendar write](./0015-server-side-google-calendar.md), specifically the "Scope acquisition" bullet that said calendar scopes are *not* requested at sign-in.
**Amended**: 2026-06-04 — the *decision* (request full `calendar` at
sign-in) stands, but its *rationale* changed. Under
[ADR 0040](./0040-user-owned-two-way-calendar.md) we no longer create a
dedicated "Chord"/"Family" calendar (`calendars.insert`), so that is no
longer why we need the full scope. We keep full `calendar` because we
still enumerate the user's calendar list (`calendarList.list`) to offer a
selectable target calendar — and `calendar.events` cannot list calendars.
See the revised "Alternatives considered" and "Consequences" below.

## Context

ADR 0015 split Google consent into two flows:

1. Sign-in (`openid email profile`) — required to use Chord at all.
2. "Connect calendar" — a second incremental PKCE flow that adds
   `https://www.googleapis.com/auth/calendar` and persists a refresh
   token covering it (`POST /v1/auth/google/calendar`).

The reasoning was that calendar access is an opt-in surface and we
shouldn't force the consent on users who only want chat.

In practice every user we onboard wants calendar — it's the most
visible feature on day one. The two-step consent adds a confusing
"Connect Calendar" affordance in settings that the user has to
discover and click, and it surfaces the question "why am I being asked
again?" The Telegram-driven onboarding path (a shadow user signing in
to claim their bound group) makes this worse: the user lands in the
app, sees their group, but the calendar and event entities tied to it
look read-only until they hunt for the second consent.

## Decision

Mobile requests `https://www.googleapis.com/auth/calendar` as part of
the initial sign-in PKCE flow. One consent, both surfaces enabled.

Server side is unchanged:

- `POST /v1/auth/google` already calls `persistRefreshToken` with
  whatever scopes Google grants (`exchange.grantedScopes`), so a
  refresh token covering `calendar` lands automatically.
- `hasCalendarScope` already matches the full `calendar` scope, so the
  rest of the calendar stack (sync worker, calendar enumeration for
  target selection, write-after-commit) detects connectivity without
  further change.

The incremental `POST /v1/auth/google/calendar` route stays as a
fallback. If a user declined calendar at sign-in, or we later add a
scope (Gmail, Drive) that we want to acquire incrementally, the
existing route covers it.

## Alternatives considered

- **Keep the two-step consent (status quo).** Rejected for the
  reasons above: the second consent is friction with no upside given
  every onboarded user wants calendar.
- **Request `calendar.events` instead of `calendar`.** Rejected.
  *(Original reason, now obsolete: ADR 0015 provisioned a dedicated
  `Chord` calendar via `calendars.insert`, which needs full `calendar`.
  ADR 0040 dropped dedicated-calendar creation.)*
  **Current reason**: under ADR 0040 the target calendar is **selected**
  from the user's existing calendars (picker → group default → user
  default → primary; §5), which means we must enumerate the calendar list
  via `calendarList.list`. `calendar.events` grants event read/write on
  existing calendars but **cannot list calendars** — `calendarList.list`
  requires one of `calendar`, `calendar.readonly`, or
  `calendar.calendarlist.readonly`. We keep the single full `calendar`
  scope rather than pair `calendar.events` with
  `calendar.calendarlist.readonly`: it's one scope on the consent screen
  instead of two, and both `calendar` and `calendar.events` are
  *restricted* scopes that incur the same Google CASA verification, so
  narrowing buys no verification relief — only a marginally less alarming
  consent line, at the cost of losing calendar enumeration.
- **Two sign-in buttons (with/without calendar).** Rejected as
  needless complexity for a binary the user almost never wants the
  "without" half of.

## Consequences

- Users see one Google consent screen that lists email + profile +
  "See, edit, share, and permanently delete all the calendars you can
  access using Google Calendar." That last line is intimidating; the
  app's pre-consent copy on the sign-in screen should explain what we
  actually do — under ADR 0040: "we read your calendars and create,
  edit, and delete the events Chord manages, keeping them in sync with
  Google. We don't read or change events Chord didn't create." (Note:
  the *old* copy promising "we only create and write to a 'Chord'
  calendar; we don't touch your other ones" is no longer accurate now
  that there is no dedicated calendar — privacy-policy + sign-in copy
  must be updated to match.)
- Users who already signed in under the old flow still need to click
  "Connect Calendar" once. The fallback route handles them.
- ADR 0015's "no calendar at sign-in" bullet is no longer accurate;
  cross-link this ADR from there.
