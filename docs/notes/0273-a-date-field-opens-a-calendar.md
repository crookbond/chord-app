# 0273 — A date field opens a calendar

**Status:** Accepted, 2026-10-19

## Context

Every date in the app and web app was typed as `YYYY-MM-DD` into a text box:
the event edit modal, a person's important dates, a persona's birthday (add
and edit), and the task due date (which also had Today / Tomorrow / Next week
presets). The owner asked that picking a date in the UI open a calendar as
well as allow typing.

No date-picker library was installed, and `@react-native-community/datetimepicker`
is a native module: adding it needs a new native build and store review, and
an over-the-air update to an older build would crash on it.

## Decision

A pure-JS calendar, shared by web, iOS and Android:

- `kernel/src/date-picker.ts` — `parseYmd`, `formatYmd`, `addMonths`,
  `monthGrid` (six Sunday-first weeks), `pickerYears`. Tested in
  `server/src/services/__tests__/date-picker.test.ts` (mobile has no harness).
- `mobile/src/date-field.tsx` — `DateField` (the same text box plus a calendar
  button) and `CalendarPicker` (the sheet on its own). The sheet has month
  arrows, a tappable title that opens a year list (so a 1985 birthday is two
  taps, not 480), Today, Cancel, and optionally Clear.
- `allowUnknownYear` adds a **Year unknown** switch that writes `0000-MM-DD`,
  the existing convention for People birthdays.

Wired into all five date fields. The task due-date picker gains a
**📅 Pick date** button beside its presets; a picked day is stored at local
09:00 like the presets.

Typing still works everywhere, unchanged. Time-of-day fields (event start/end,
quiet hours, briefing time) stay typed — the request was about dates.

No server change and no new capability, so no bot tool.

## Rejected

- **`@react-native-community/datetimepicker`.** Native module (new build, not
  OTA-safe), and its web support is not the same UI.
- **`<input type="date">` on web only.** Two behaviours, and nothing on the
  phones, which is where most dates are entered.
