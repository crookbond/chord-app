# 0229 — A repeat nobody asked for is ignored

Status: accepted (2026-10-09).

## Context

`create_event` and `update_event` take an optional `repeat` (ADR 0217). The
production model attaches one to plain one-time requests. Seen three times:

- twice in early October ("Call with AHF at noon tomorrow"), where the bot
  then refused the whole event because the spec contradicted itself;
- on 2026-10-09 ("add lunch tomorrow at noon to my Outlook calendar"), where
  the tool reply read "a repeat pattern was attempted but could not be
  stored: weekdays only applies to a weekly repeat".

The first two led to a guard (`81713d6`): when a repeat **fails validation**
and the triggering message has no repeat wording, drop it and create the
event. That guard only runs in the `catch`. All three specs happened to be
self-contradictory, which is the only reason anything caught them. The same
habit with a valid spec — `{ frequency: "daily" }` — went straight through
and made a daily series of a one-time event. `update_event` had the same
hole: a made-up valid repeat on "move lunch to 1pm" turned a one-off into a
series, and with `scope: "all"` rewrote how an existing series repeats.

## Decision

**Ask the conversation before looking at the spec.** `repeatWasAsked`
(`bot/executor.ts`) answers one of three ways:

- `no` — there is a triggering message, and neither it nor the messages just
  before it (the last 8 in that chat, within 30 minutes) contain repeat
  wording. The `repeat` is ignored, valid or not. The event is created or
  edited as the one-time event that was asked for.
- `yes` — repeat wording is there. The spec is built as before, and one that
  cannot be expressed still refuses and asks (ADR 0217).
- `unknown` — no message to read: ingest, a confirmed proposal, a scripted
  call. No signal either way, so the `repeat` is taken as given.

The window exists for one flow: the bot proposes a pattern, the user answers
"yes, that works". The answer has no repeat wording; the exchange before it
does.

`looksLikeRecurrenceRequest` now also matches plural day names ("on
Tuesdays"), `weekdays` / `weeknights` / `weekends`, `biweekly`,
`fortnightly`, `nightly`, `quarterly`, `each <day>`, `standing` and
`regularly`. It used to decide only whether to refuse or drop an invalid
spec; it now decides whether a valid repeat is kept, so missing "soccer on
Tuesdays" would lose a repeat the person asked for.

**When a repeat is ignored, the reply does not bring it up.** The tool result
says "one-off, does not repeat" and tells the model not to mention repeating.
The old wording asked it to mention that the event was one-time, to a person
who had asked for nothing else.

## Consequences

- A repeat asked for in words the check does not know becomes a one-off. The
  reply states "one-off, does not repeat" in its facts, and "make it weekly"
  then converts the same event in place.
- Repeat wording anywhere in the last few messages keeps the old behaviour
  for that turn, including the bot's own "does not repeat". That errs toward
  trusting the model, which is what happened before this change.
- The check is English. A request in another language reads as `no`.

## Alternatives rejected

- **Validation alone.** It only catches specs that contradict themselves.
- **A stricter prompt.** The tool description already says "only when the
  user said it repeats", and the model does it anyway (ADR 0100's precedent:
  the instruction alone was not enough).
- **Checking only the triggering message.** Loses the repeat on "yes" to a
  pattern the bot proposed.
- **Asking the user to confirm every repeat.** A question on every "weekly
  standup" to stop a rare made-up one.
- **Removing `repeat` from the schema unless the message has repeat
  wording.** Same information, but the model then cannot express a repeat
  the check missed, and cannot be told why.

## Addendum 2026-10-25: the parts of a repeat nobody asked for

A model-comparison run (gpt-4.1-mini and gpt-5.4-mini through OpenRouter,
both served by Azure) refused "add Maya swim class every Tuesday at 4pm" four
times out of four on each model. Through OpenRouter, OpenAI models fill
**every** optional field of a tool call, so the repeat arrived as
`{ frequency: weekly, monthlyWeek: 1, count: 1, until: <a made-up date,
often before the start>, weekdays: [TU] }`. Validation refused the
`monthlyWeek` and the bot asked about a monthly pattern nobody mentioned; had
it not refused, `count: 1` would have stored a series of one.

This ADR decided *whether* a repeat was asked for. The same reasoning now
applies to its parts: `trimRepeatToRequest` (`events/recurrence.ts`) keeps a
part only when the user's own recent words support it, read with the same
window as `recentUserText`:

- `interval` > 1 only with "every other", "every 2…", "biweekly",
  "fortnightly";
- `count` / `until` only with an end ("until", "through", "for 10 weeks",
  "the school year"…); an `until` before the first occurrence never, and a
  `count` of 1 never (a series of one is not a repeat);
- `monthlyWeek` only on a monthly repeat with "first", "second", "last"…;
- `weekdays` on a weekly repeat as given; on a daily one, turned into a weekly
  repeat on those days only when days were named ("every weekday"), else
  dropped.

With no message to read (ingest, a proposal confirm) the spec is left
unchanged, so a self-contradictory one is still refused there rather than
guessed at. Where the user's words do ask for a repeat, a contradictory
modifier is now dropped and the repeat kept, instead of the whole repeat
being refused; one older test that pinned the refusal was flipped.
Applied on `create_event` and both `update_event` repeat paths. A pattern proposed by the bot and accepted with a bare "yes"
loses an end date only the bot stated (bot messages are not the user's
words); the series then runs without an end, which the reply states.
