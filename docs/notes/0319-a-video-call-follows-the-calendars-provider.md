# 0319 — A video call follows the calendar's provider

Status: accepted (2026-11-05)

## Context

Owner, 2026-11-05: "for meetings / calendars in Outlook / 365 — don't make
Google Meet default. For IMAP — no default. Google driven mailboxes have
Google Meet default."

ADR 0317 gave Chord one video call it can create: a Google Meet, patched onto
a Google Calendar event through `conferenceData`. It is reachable three ways —
`videoCall: true` on `create_event` / `update_event`, `POST
/api/v1/events/:id/video-call`, and an "Add Google Meet" button in the event
editor — and every one of them behaved the same wherever the event landed.

Four things combined to make Meet the de-facto default on every calendar.

1. **`videoCall` had no "was it asked for?" guard.** `repeat` has one
   (`repeatWasAsked`, ADR 0229) and the mail search filters have one
   (`dropUnaskedMailFilters`, ADR 0279) for the reason ADR 0229's addendum
   records: through OpenRouter, OpenAI models fill every optional field of a
   tool call. So "set up a meeting with Sarah tomorrow at 3" arrives with
   `videoCall: true`, and the executor acted on it unconditionally
   (`executor.ts` create and update paths). ADR 0317 shipped "Only set it when
   asked" as a prompt instruction alone, which ADR 0100/0102/0229 each record
   as not enough by itself.
2. **On a non-Google calendar nothing wrong was written** — `addVideoCall`
   refused `not_google` — **but the turn still reported the refusal.** An
   Outlook / 365 user got "NO Google Meet link was added: Google Meet can only
   be added to a Google calendar event (say so; do NOT claim a link)" about a
   Google Meet nobody had mentioned.
3. **The provider test was two ad-hoc `isOutlookCalendarKey` calls**, with no
   notion of the other kinds. An attached Gmail's calendar (`gacct:`, ADR
   0313) worked only by accident of the bare-vs-prefixed routing; a
   phone-mirrored calendar got the vaguer `not_on_calendar`; a mailbox with no
   calendar of its own carried `primary` as its target and so read as Google.
   Nothing in `kernel/` stated the rule.
4. **The editor offered the button on every event**, including ones on an
   `outlook:` calendar and on a mailbox with no calendar, where it could only
   fail. `EventGuestsResponse` carried nothing saying which calendar the event
   was on, so the editor could not have known.

## Decision

**One rule, in kernel, asked by every surface.** `kernel/src/video-call.ts`:

- `videoCallDefaultFor({ calendarId, provider? })` → `'google_meet' | null`.
  A Google-driven calendar (the login account's own, and an attached Gmail's
  `gacct:` ones) gets a Meet; `outlook:` gets none; a `provider` of `device`
  or `outlook` gets none whatever the key looks like; no calendar at all gets
  none. A Google calendar id never holds a colon (it is an address, or
  `primary`), so **any other prefixed key gets no default** — a provider added
  after this was written has to decide for itself rather than inherit Meet.
- `looksLikeVideoCallRequest(text)` — does the person's own wording ask for
  one? Generous on purpose: a false "they asked" costs an honest refusal on a
  non-Google calendar, a false "they did not" silently drops a link someone
  wanted.

In kernel because three surfaces ask the same question and the third (the
event editor) has no test harness of its own — the ADR 0085/0127 reasoning,
and the same reason ADR 0120/0121 put their predicates there.

**A default is not a request.** `videoCallNoteFor` (`bot/executor.ts`): when
the conversation did not ask, `videoCall: true` is treated as the default and
followed only where the calendar has one — so a Google-driven mailbox still
gets its Meet (what the owner asked for), and on Outlook / 365 or a mailbox
with no calendar nothing is written **and nothing is said**, the posture ADR
0229 took for an ignored repeat. An explicit ask is still honoured, and
refused in plain words where it cannot be met (ADR 0102's shape, which
`addVideoCall` already used): "this event is not on a Google calendar, and a
Google Meet is the only video call Chord can add (it cannot create a Teams
meeting)". With no message to read (ingest, a confirmed proposal, a scripted
call) the field is taken as given, as `repeat` is.

The "was it asked" window is now **one reader**, `askedInConversation`
(trigger plus the 8 messages / 30 minutes before it, the bot's own included so
"yes, that works" counts), which `repeatWasAsked` also calls — a second copy
of that read is how the two would stop agreeing.

**`addVideoCall` asks the kernel rule, twice**: on the event's stored calendar
key before anything is written, and again on the key the transport resolved.
`calendarKeyOf` reads that key by the convention `calendarColorResolver` /
`calIdOf` already use (an explicit `google_calendar_id`, else a `gcal:` /
`outlook:` `external_uid`).

**`eventVideoCallOption(db, eventId)`** is the one lookup of "what can this
event be given", used by the executor's default decision and by the guests
route. A Google-shaped key also needs a Google connection behind it
(`hasCalendarWriteScope`): an IMAP-only mailbox carries `primary` as its
target while its events live in Chord alone, and that is **no calendar**, not
a Google one.

**The editor only offers what works.** `EventGuestsResponse.videoCall` carries
the option, and "Add Google Meet" is drawn only when it is `google_meet` — no
button at all on Outlook / 365 or a phone calendar, rather than one that can
only fail.

**The tool descriptions state the rule**, prompt and choke point together as
ADR 0100 requires: set `videoCall` only when asked, never because something
reads like a meeting; a Google Meet is the only video call Chord can add and
only on a Google calendar; never claim one either way.

## Consequences

- A 365 user asking for a video call is told plainly that Chord cannot make
  one, naming Teams. Chord does not create Teams meetings, and this does not
  start: it would need Graph's `onlineMeeting` and a tenant that has Teams.
- A phone-mirrored calendar now answers `not_google` rather than
  `not_on_calendar` when asked, which is the truer reason: Chord reads those,
  it does not write them. A phone calendar that is really a Google calendar
  folds into its Google row (ADR 0072) and is judged by that row.
- A real request misread as "not asked" on a non-Google calendar is dropped
  silently. That is the accepted direction: the alternative is a refusal about
  a Meet nobody asked for, every time a model fills the field.
- Nothing is stored. The option is derived from the event's calendar on every
  read, so a reconnect or a moved event needs no backfill.

## Addendum 2026-11-05 — `confirmPast` is the user's answer, not the model's

The bug-class sweep named `confirmPast` and this fixes it. ADR 0100 refuses a
past `create_event` / `update_event`, has the bot read the date back, and takes
`confirmPast: true` as the user's "yes, I mean last March". Nothing enforced
the middle step: it is one more optional boolean, so the single flag that
switches ADR 0100's guard off could arrive on a first attempt and file a
stale-year event silently — the guard was bypassable by exactly the mechanism
it was written to catch.

**The licence is recorded where the question is asked** (`bot/pending-past-dates.ts`).
Every refusal writes the local day it refused, keyed on (chat, user) in
`bot_pending_state` (ADR 0280, kind `past_date`, an hour's TTL), and
`confirmPast` is believed only against one of those. Two properties make it the
user's confirmation rather than the model's assertion:

- **A different turn.** The ADR 0005 loop re-streams up to 20 times inside one
  turn, so a refusal followed immediately by `confirmPast: true` is the model
  answering its own question. Honouring only a refusal recorded against an
  earlier `turnId` (ADR 0093's key) is what makes the user's reply the thing
  that licensed the write.
- **The same day.** The user confirms a date, not a flag. A `confirmPast`
  carrying some other past date was never put to them.

Deliberately NOT solved by stripping the field (`INTERNAL_TOOL_FIELDS`, how
`alreadyInGoogle` and `closesOnReply` are handled): the model has to be able to
pass it, because passing it is how ADR 0100's conversation ends. The licence is
what tells a real answer from a filled-in field.

Scoped to the chat: a date confirmed in the family chat does not license the
same date in a 1:1, since that is a different conversation and nobody was asked
in it. Both tools share one licence, though — the user is asked about a DATE,
not about which tool will write it, so a `create_event` refusal licenses the
same day on `update_event`. The licence is left on record after a successful
write: a confirmed past date whose call is then refused for an unrelated reason
(an ambiguous title, a repeat the server cannot express) is re-sent in the same
breath, and asking twice for one answer is the nag ADR 0100 was written
against. The ADR 0100 exemptions are untouched — no `turnId` (ingest, ICS
import, proposal confirm) and any `externalUid` never reach the guard.

**One existing test flipped** rather than deleted (ADR 0108/0139's treatment):
ADR 0155's file path now does NOT honour `confirmPast`. That path tells the
model not to ask, so no answer can exist behind the flag — and a term schedule
refused thirty times in one turn would otherwise hand the model thirty licences
to file history on the next one, which is the harm 0155 exists to prevent. The
user can still record a past date from a document: they say so in a plain
message, Chord asks, and that question licenses the confirm.

Known residue: the licence cannot read the answer. A user who is asked and
replies about something else entirely, on a turn where the model calls again
with `confirmPast` and the same date, is still taken as having agreed. That is
far narrower than "any first call carries it", and closing it would mean a
second affirmative-wording regex whose false negatives loop a user who did
confirm back into the same question.

## Addendum 2026-11-05 (2) — the last two fields of the sweep

The two fields the first addendum named are fixed, and investigating them
corrected both of its claims about them. Each needed a DIFFERENT rule, which is
the point worth keeping: "a field the model filled in" is one bug class with
several right answers, and which one applies depends on who else sets the field
and what it contradicts.

**`create_event.allDay` is honoured only when it agrees with the time.**
`createEvent` reads `input.allDay ?? <floating-midnight sniff>`, so the field
overrides that sniff and a `true` beside a 3pm start files the meeting as an
all-day, non-blocking row — invisible to free/busy, and pushed to Google as
all-day.

The first attempt was to treat it as an ingest field and strip it from the
advertised schema the way `alreadyInGoogle` is stripped. A probe written to
explain a failing test killed that: `applyToolCall` runs `normalizeDatetimes`
over every call, which stamps the user's offset onto the floating midnight the
prompt asks an all-day event to be written as, so by the time the sniff runs
the value is `…T00:00:00+00:00` and no longer looks all-day. **The field is the
model's only way to say "all day"** — the first addendum called it "an ingest
concern a user never expresses", and that was wrong. Stripping it would have
broken every all-day event asked for in chat, silently, in exactly the way
these ADRs are written about.

So the rule is AGREEMENT, not absence: on a conversational turn `allDay: true`
is honoured only when the start is midnight in its own offset (which is the
user's, since the normalizer put it there; bare-Z is not the all-day convention
and the prompt forbids it), and anything else falls back to the sniff. Ingest,
the .ics import and proposal confirm carry no `turnId` (ADR 0093) and are taken
as given — a trusted caller passing `allDay` against a timed-looking start is
the case the field was added for. A test pins the stored start as
offset-qualified, so the reason for this shape cannot be quietly refactored
away.

**`add_mail_filter.alsoExisting` has to be asked for.** The first addendum said
the card "does not say that existing mail will move": also wrong — both the
chat card and the To Do's card read "new and existing mail". That makes this
the weakest case of the three, and still worth closing, because the user taps
on the strength of a main sentence that is exactly right ("File mail from the
school into School") while the quiet half of the card moves two hundred
messages out of their inbox. `askedInConversation` (the reader ADR 0229 and the
video-call default already share) now gates it against the user's own words,
via `looksLikeExistingMailRequest` in `email/filing.service.ts`; unasked falls
back to ADR 0309's own default of new mail only. Decided at staging, so the
card states what will actually happen.

Both are generous matchers for the same reason `looksLikeVideoCallRequest` is:
a false "they asked" costs a card that honestly describes a bigger move and
still needs a tap, while a false "they did not" costs one more sentence.

## Rejected

- Keeping `addVideoCall`'s own refusal as the whole answer (today's
  behaviour): it reports a failed Google Meet nobody asked for, which is noise
  on the one hand and, after enough of it, a reason to distrust the reply.
- Deciding by the calendar key's shape alone: a phone calendar stores a bare
  id in the same column, indistinguishable from a Google one, so a caller that
  knows the provider says so.
- Defaulting an unrecognised prefixed key to Meet: a provider added later
  would inherit a video call nobody decided it could have.
- A per-user "video call by default" setting: the owner asked for a rule that
  follows the calendar, and a knob would need a Settings surface, a chat tool
  and an answer for the user whose calendars span two providers.
- Adding a `calendarProvider` field to `GroupEvent` for the editor: the editor
  already reads the guests endpoint for this event, and a field on every event
  of every list pays for a question only the editor asks.
- Creating a Teams meeting: a separate capability, not a default. Checked
  2026-11-05 after the owner raised it, and it is cheaper than this ADR first
  claimed — Graph takes `isOnlineMeeting: true` + `onlineMeetingProvider:
  "teamsForBusiness"` on the event itself and hands back
  `onlineMeeting.joinUrl`, so it needs no separate `onlineMeeting` resource and
  no scope beyond the `Calendars.ReadWrite` ADR 0228 already holds. What is
  left is still a capability rather than a flag: `videoCallDefaultFor` would
  return `'teams'` instead of null, which changes the kernel rule's type and
  every surface reading it; a personal (consumer) Outlook account has no Teams
  for Business and an unlicensed tenant refuses, so the refusal path has to be
  real and honest (ADR 0102) rather than assumed; and nothing here has
  round-tripped it against a live tenant. Its own ADR.
