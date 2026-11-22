# 0232 — Personal first, fan-out next

**Status**: accepted
**Date**: 2026-10-09

## Context

ADR 0040 §7 fans a group event out to every member, each copy on that member's
own calendar. On top of it ADR 0040 also let a calendar named in a prompt be
**remembered as the group's default** (`groups.default_calendar_id`), and every
later event in that group followed it. Three consequences nobody chose:

- **Flights went to "Family".** Trip legs resolve their calendar the same way
  (`trips.service`), so once anyone said "put it in Family" in a group — the 1:1
  chat is a group too — every flight in it landed there. The owner noticed
  ("I am positive my events go to family for flights").
- **Fan-out used one calendar id for every member.** The pre-resolved default
  was a single id applied to all non-creator copies. A personal calendar's id
  means nothing to anyone else, and a shared one would have produced N copies
  of the same event.
- **A one-off request became a standing rule**, silently.

A shared Google calendar was considered to fix the family case and **scratched**:
fan-out already puts the event on every member's own calendar and works, and a
shared calendar would need an organizer-only push, a way to avoid duplicates
(ADR 0181), ownership handling and its own test matrix to buy the same result.

## Decision

**Personal is the default; fan-out comes next, by choice.**

- **No group-level default calendar.** `resolveTargetCalendarId` is: a name
  requested for *this event* → the user's own default (`users.default_calendar_id`)
  → primary. `setGroupDefaultCalendar` is deleted and nothing reads
  `groups.default_calendar_id` any more. The column stays (no destructive
  migration); rows the old behaviour wrote are inert. Existing events do not
  move.
- **Fan-out copies resolve their own calendar.** Each member's copy goes to that
  member's own default, else their primary — never one id for everyone.
- **A 1:1 event is one copy on the asker's calendar.** `create_event` gains
  `withGroupName` (personal chat only, the same exact-name-or-ask resolver as
  `create_task`/`add_list_item`): "add dinner Friday with the family" creates
  the event *in* that group, where it fans out. The asker's own name is not a
  group (ADR 0164's rule). It is implemented by re-entering the executor with the
  resolved group, so every existing guard (past dates, dedup, trust, repeats)
  runs unchanged. `calendar` still names a calendar, for that event only.
- **Flights and trips follow the same rule**: they land on the creator's own
  calendar. Trips are useful to the family — see "Not done" for how that gets
  suggested.
- **The offer.** When a personal event's title names someone in one of the
  asker's shared groups — a member's full or first name, or a managed family
  member on the roster (ADR 0151) — `create_event` returns a `fanoutSuggestion`
  and the bot asks once. It never shares by itself. The signal is deterministic
  (whole-word name match, no model call); the asker's own name is no signal;
  names under three characters are ignored; a person in several groups gets all
  of them offered so the bot asks which; only the asker's own groups are consulted
  (ADR 0032) and only names leave the function, shown the way the user sees them
  (an unnamed two-person chat is the other person's name, ADR 0101 — offering
  "Direct message" would be a name the resolver cannot accept). Not offered for
  repeating events, events with an external uid, or inside a shared group chat.
- **The yes.** `share_event` re-creates the just-offered event in the chosen
  group (fan-out) and then removes the personal original — created first, so a
  failure in the middle leaves the event rather than nothing. It takes no event id:
  `bot/pending-fanout.ts` is the server's record of what was offered (the ADR
  0093/0166 reasoning — a tool result does not survive a turn, so a bare "yes"
  has nothing to point at), keyed to the personal chat, TTL one hour, and read
  back into the system prompt each turn until answered. It refuses an event that
  repeats or has invited guests rather than drop them in the move, and says so.

## Consequences

- **Behaviour changes, on purpose.** Anything relying on "name a calendar once,
  group remembers it" now has to say it each time, or set a personal default.
  Group chats still fan out; only *which calendar each member's copy lands on*
  changed (their own, not one shared id).
- **Every test that pinned the old behaviour was flipped, not deleted**
  (`calendar-device-target`, `events-fanout`, `travel-leg-calendar-sync`,
  `create-event-calendar-honesty`), and new ones pin the replacement: a stored
  group default is ignored, naming a calendar remembers nothing, a flight goes to
  its creator's calendar. The honesty test was confirmed to fail against the old
  behaviour.
- **The move is delete-and-recreate**, so the creator's event is deleted and
  re-made on Google rather than edited in place. Fine seconds after creation;
  the refusals above exist because it would not be fine for guests or a series.
- **Name matching is a heuristic.** A title naming a common first name that is
  also a group member will offer. That costs one sentence; the alternative
  (silent sharing) costs a private event on other people's calendars.

## Not done

- **Trips and flights are not yet offered to a group** — done in
  [ADR 0233](./0233-a-trip-is-offered-to-the-family.md).
- **No shared Google calendar** (scratched, above).
- **No backfill or cleanup** of events already on a "Family" calendar, nor of
  `groups.default_calendar_id`.

## Rejected

- **A shared Google calendar per family** — see Context.
- **Keeping the group default but only for group chats** — the same surprise,
  one surface over; fan-out already reaches everyone.
- **Offering before creating** — adds a question to every event that names a
  person; create-then-offer keeps the default fast and the offer optional.
- **An LLM judging "is this a family event"** — a name match is testable and
  explainable; a model's guess about privacy is neither.
- **Editing the original in place on "yes"** — would mean reaching into the
  fan-out internals of `createEvent` to mint copies for the other members;
  rejected for risk in a hot function, at the price of the recreate above.

## Addendum 2026-10-12 - a name that is no group never blocks, and the chat list is never read back

Prod: "Add to calendar move Car on Thursday at 8 AM" in the 1:1 was refused four
times running. The model sent `withGroupName: "/personal"` on every turn (the
user had named no group), the log read `group "/personal" did not resolve -
nothing was created`, and the refusal carried every chat the asker is in, which
the bot read back as "which calendar".

Three gaps, all closed:

- **"Me" was an exact-match word list.** `"/personal"` failed on the slash.
  `utils/self-reference.ts` (`isSelfReference`) reduces the name to its words,
  drops filler ("calendar", "group", "my", "own", "default"...) and compares what
  is left, so "/personal", "personal calendar", "my own default calendar" and
  "just me" all mean the asker. The `calendar` field uses it too, after real
  calendar names have had their chance (a calendar called "Personal Projects"
  still wins).
- **A miss returned the whole roster.** `resolveGroupByName` fell back to every
  shared group when nothing matched. It now returns near misses only (the name
  is part of a real group's name), at most five, and none when nothing is near.
  A user can be in hundreds of chats; no path enumerates them.
- **A miss refused.** Personal is the default, so on `create_event` a name that
  is no group creates the event on the asker's own calendar and the summary
  says no group is called that. Near misses are OFFERED through the existing
  `fanoutSuggestion` / `share_event` path (the event moves on a yes, so no
  twin). `create_task` / `add_list_item` / `save_place` follow the same rule
  (owner decision: anything made from the personal chat is personal, with
  suggestions): saved personally, and the near misses are named once in the
  reply as where it could also go. A "yes, that group" adds a copy there and
  keeps the personal one - deliberately (owner decision): the same item in
  two groups is resolved VISUALLY, not by moving or deleting. The To Do's hub
  already merges copies into one row (tasks and list items by normalized
  text, saves by link or title) and acts on every copy together; the row now
  names every group holding a copy ("John + RDMS") where tasks and saves
  used to show one name and a count.

`withGroupName` was never required; the tool description now says to omit it
unless the user's own words name a group.

Rejected: ignoring an unasked-for `withGroupName` by checking the conversation
for the group's name (ADR 0229's shape) - with the fallback above an invented
name is harmless unless it exactly matches a real group, and a word test
against group names is a guess of its own.

## Addendum 2026-10-25: an item is created in the chat it was asked in

The premise above did not hold. With the asker's groups in the prompt,
gpt-4.1-mini through OpenRouter (prod's model) sent `withGroupName: "Doe
Family"` three times out of three for "add milk to the Costco list" and for
"add soccer practice for Ben", said in the personal chat. OpenAI models there
fill every optional field (ADR 0229's addendum), and a real group name is the
likeliest thing to fill this one with. Both items went into the family's group.

Owner decision: **an item is created in the chat it was asked in, whatever the
model sends.** Asked in the family group, it goes to the family; asked anywhere
else, it is personal. `withGroupName` is removed from `create_task`,
`add_list_item`, `save_place` and `create_event` (so a value the model sends
anyway is dropped by the schema), along with `resolveWriteGroup`, its "no
group is called X" note and the near-miss offer it fed. Saying "add milk to
the family list" in the personal chat now keeps it personal; the tool
descriptions tell the model to say the item belongs in that group's chat.

A word check on the conversation (built first, then dropped the same day) was
rejected: it is a guess about language, and the rule above cannot be fooled.

Still able to put a personal item into a group, both behind an explicit yes to
an offer the SERVER computed: `share_event` (this ADR's `fanoutSuggestion`) and
`share_trip` (ADR 0233). Posting to a group the user named
(`message_group`, `share_email_with_group`, ADR 0234) is a post, not an item.

## Addendum 2026-11-10: a shared event is the same event

`share_event` re-created the personal event in the group from its title, times
and location only, then deleted the original. Everything else was lost on the
way to the family: the calendar the user had put it on (a fresh
`resolveTargetCalendarId` sent it to their default instead), the ADR 0162
context note and email link, the ADR 0297 time zone, the all-day flag,
free/busy, the ADR 0151 family member it was for, and the provenance.
Found in an audit of later code paths that skip what earlier ADRs added.

Owner decision: copy everything, do not refuse. The re-create now reads the
original row and passes:

- **calendar**: the original's `google_calendar_id` while the user can still
  write to it (`isWritableCalendar`); otherwise the usual resolution, and the
  reply says the original calendar could not be used.
- **description**: passed explicitly, even when null, so ADR 0162 does not
  build a second excerpt from the provenance.
- **`source_raw_context`, all-day, transparency**: as they were.
- **time zone**: `createEvent` gains `startTz` / `endTz`, written on every copy
  (so each member's copy sends the same `timeZone` to their calendar).
- **family member**: personas belong to a group, so the original's persona is
  found again in the target group by the People row it stands for, else by an
  exact name; none = the event is shared unlinked (its stored title still names
  them) and the reply says so. A member assignee in the 1:1 can only be the
  asker ("just for me"); saying yes to the share is them changing their mind,
  so that one is dropped and the group copy fans out. Anyone else stays the
  assignee if they are in the group.
- **video call**: cannot be carried. The Meet / Teams link belongs to the
  provider event that the move deletes, and Chord stores no link (ADR 0317).
  The share reads the original's provider copy once (`providerEventPeople`, now
  also returning `videoCallLink`); when it had a link, a new one is asked for on
  the shared copy (`addVideoCall`, same rules as ADR 0319/0323) and the reply
  gives the new link and says the old one no longer works, or says no link was
  added and why.

The re-create also passes `mergeOnlyInGroup`: an event that does not fan out
(one for a family member) let ADR 0223's same-event merge find the personal
original, fold into it, and the share then deleted that row, losing the event.
The merge now looks only in the target group.

Kept: the refusals for repeating events and events with guests.
