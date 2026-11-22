# 0278 — Every calendar has its own color, and the user can change it

**Status**: accepted
**Date**: 2026-10-19

## Context

ADR 0072 colored calendar events by their source calendar, using the color
the provider stores (`calendar_sources.color`: Google's `backgroundColor`,
Outlook's `hexColor`, EventKit's color). Three gaps:

- A calendar with no provider color showed the plain accent, so several such
  calendars looked identical, and two calendars sharing a provider color (a
  common Google default) did too.
- The user could not change a color in Chord.
- An event block said nothing about which calendar it was on: no hover text
  on web, and the event sheet opened by a tap did not name it either.

## Decision

**A calendar shows, in order: the user's pick in Chord, else the provider's
color, else the next free color of Chord's palette.** One pure function,
`assignCalendarColors` (`kernel/src/calendar-colors.ts`), decides it for both
the Settings list and the events the calendar screen draws, so the two cannot
disagree.

- **Palette**: the app icon's five colors, then a darker and a lighter set of
  the same (15), then ever-slighter shades without end.
- **Distinct unless the user says otherwise**: a pick is kept exactly, so two
  calendars may share a picked color. A provider color already shown by
  another calendar is shifted to the nearest slight shade. A calendar with
  neither takes the first palette color nobody is using.
- **Stable**: calendars claim colors primary first, then by `first_seen_at`,
  so connecting a new calendar never repaints the existing ones.
- **Stored**: `calendar_sources.color_choice` (migration `115`), its own
  column because every provider sync rewrites `color`; a pick survives a sync.
  Any calendar can be colored, read-only ones too. Display only: the color is
  never written back to Google or Outlook.
- **One writer**, `setCalendarColor`: by row id (Settings, `PATCH
  /me/calendar/sources/:id { colorChoice }`, now a partial patch beside
  `countsForBusyOverride`) or by name (chat). A hex code or a named color
  (`CALENDAR_COLOR_CHOICES`); null or empty clears the pick. Name matching is
  exact-or-ask (ADR 0137) over ALL the user's calendars, not only writable
  ones.
- **Chat**: `set_calendar_color { calendar?, color? }`, personal 1:1 only (its
  candidates name the asker's calendars); omitting `calendar` reads every
  calendar's color.
- **Events carry `color` and `calendarName`** (`GroupEvent`), so the app can
  say which calendar an event is on. A Chord-only event (no synced calendar)
  keeps both null and draws in the accent.
- **App**: on web an event block's hover tooltip gives the event, its time
  and its calendar (the browser's own `title`, set on the element because
  React Native Web drops a `title` prop); tapping an event opens the event
  sheet, which now names its calendar beside a dot of its color. Month view
  draws one dot per calendar with an event that day (at most 3). Settings →
  Calendars: tap a calendar's color square for the color choices + Default.

### Mailboxes and email actions use the same rule

- **Every mailbox has a color** by the same `assignCalendarColors`: the
  user's pick, else the Chord palette (mailboxes carry no provider color),
  primary Gmail first then accounts by `created_at`.
  `mailboxColors`/`setMailboxColor` (`email/mailbox-colors.service.ts`);
  picks are the per-user default `mailbox_colors` (`users.defaults`, keyed
  `'primary'` or account id - no migration). `EmailStatus.mailboxColors` +
  `mailboxColorsPicked`; `PUT /me/email/mailbox-color { mailbox, color }`;
  personal-only `set_mailbox_color { mailbox?, color? }`, resolved by the
  same matcher as `set_default_mailbox` (`matchMailboxByName`, extracted).
  Traditional view: each mailbox chip is outlined in its color and fills
  when selected; each row has a colored left edge and a colored mailbox tag.
  Settings → Mailbox names: a swatch beside each name opens the choices.
- **Each action has a color** (`ACTION_COLOR`): To do and Reply badges are
  solid with white text (the pale chips were hard to see), and the To do /
  Reply / FYI filter chips use the same colors.

## Rejected

- **Chord's palette before the provider's color**: the user already chose
  colors in Google; matching them makes Chord read like the calendar they know.
- **Writing the pick back to Google/Outlook**: a second writer of someone
  else's setting for a display preference.
- **Persisting auto-assigned colors**: computing them is free and cannot go
  stale; removing a calendar can shift later palette colors, which is rare.
- **A custom hover component on web**: the browser tooltip needs no layout
  work and is not clipped by the block's `overflow: hidden`.
