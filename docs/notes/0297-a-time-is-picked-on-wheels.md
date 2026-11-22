# ADR 0297 — A time is picked on wheels, in a time zone, and the end follows the start

- **Status:** Accepted (2026-10-25)
- **Amends:** ADR 0273 (whose date field left time fields typed)

## Context

Every time field in the app was a free-text box read by `parseTimeOfDay`:
the event editor's start and end, the briefing time and quiet hours in
Settings. Three problems came back from use:

- A time had to be typed in a shape the parser knew, or saving failed with
  "start a time like 3:30 pm".
- The keyboard covered the editor, and with the modal fixed in the centre
  there was no way to reach Save without dismissing it.
- Moving an event's start left its end where it was, so a 3:30-4:15 meeting
  moved to 5:00 became a 5:00 start with a 4:15 end (read as overnight).

The editor also had no notion of time zone: times were the device's clock,
so an event for a trip could not be entered in the destination's time.

## Decision

**Times are picked on three wheels, hour / minute / AM-PM**, as on an
iPhone (`mobile/src/time-field.tsx`: `TimeField`). Tapping the field opens
the wheels, which settle on a row; tapping a row also picks it. No keyboard
opens. Pure JS, like `DateField`, so it ships over the air and is identical
on iOS, Android and web (the web has no momentum-end event, so the wheel
snaps itself after scrolling stops). An optional field offers "None".
Used in the event editor and for the Settings briefing time and quiet hours.

**The event editor has a time zone** (`TimeZoneField`), defaulting to the
device's, with a searchable list of common zones (device zone first). The
times are clock times in that zone; changing the zone keeps the clock time
and moves the instant, as iOS does. Conversion is `instantOfWallTime` /
`wallTimeIn` in `kernel/src/time-picker.ts` (Intl only, no library); a
clock-change day is tested. The server is unchanged: the editor sends UTC
instants as before.

**Moving the start moves the end** by the same amount
(`moveEndWithStart`), measuring an end at or before the start as overnight,
the same way save reads it. Changing the end on its own sets a new length,
which the next start move then keeps. No end stays no end.

**An event opens in its own zone, and the zone is saved.** Events already
carry one: `events.start_tz` (set by the Google pull) and the offset in
`starts_at`. `GroupEvent.timeZone` now exposes `start_tz`; the editor opens
in it, else, when the time's offset is not the device zone's at that moment,
in the first common zone with that offset (`zoneForEvent`; Denver before
Phoenix for -07:00), else the device zone (`Z` and floating times say
nothing about a place). Saving sends `timeZone`, which `updateEvent` writes to
`start_tz`/`end_tz`, so Google gets the zone too (it already sent
`start_tz` as `timeZone`). Chat parity: `update_event { timeZone }` (IANA
name); `anchorModelTimes` puts that call's times on the named zone's clock,
ahead of every other rule.

**No text box is left behind the keyboard, anywhere** (`mobile/src/keyboard.tsx`).
Two pieces: `KeyboardScrollView` pads its bottom by the keyboard and scrolls
the focused box above it; every `TextInput` from `@/text-input` inside one
reveals itself on focus through a context, so no box needs wiring. The
amount is `keyboardRevealDelta` (kernel, tested): a box taller than the room
left keeps its top in view. `KeyboardModalBody` wraps a Modal's content in a
`padding` `KeyboardAvoidingView` (both platforms; Android draws edge-to-edge,
ADR 0263) so a centred sheet rises. Used by every screen with a text box in a
scroll view (Settings, To Do's, chat About, People, the sign-in page, group
settings) and every text-entry popup (event, task and save editors, bridge
rename, time-zone search). Screens with their own handling (chat, email
reader and composer, label sheet) are unchanged. The web is left alone.
Not checked on a device.

## Rejected

- **`@react-native-community/datetimepicker`**: a native module, so not
  OTA-safe, and different on each platform (ADR 0273's reason).
- **Keeping the text box and loosening the parser**: still needs a keyboard
  and still fails on what it cannot read.
- **Always the device zone**: events do carry a zone (`start_tz`) or an
  offset, so opening a Paris dinner in New York time was a choice, not a limit.
- **`react-native-keyboard-controller`**: a native module (not OTA-safe).
- **iOS `automaticallyAdjustKeyboardInsets`**: iOS only, and Android is the
  platform that does nothing for the keyboard.
- **A `KeyboardAvoidingView` around every screen**: shrinks the whole screen
  but does not scroll the focused box into view on long forms.
- **Moving the end only when the length is "short"**: one rule is easier to
  predict; the end is always one tap away.
