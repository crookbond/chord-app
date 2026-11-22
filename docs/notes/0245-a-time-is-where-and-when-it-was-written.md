# ADR 0245 — A time is where and when it was written

**Status:** Accepted (2026-10-13)
**Amends:** [0244](./0244-one-email-one-outcome-whichever-pass-reads-it-first.md)
(weekday names, the offset fix on the text-fence path, the reply drafter),
[0240](./0240-a-flight-time-is-on-the-clock-of-its-airport.md) (closes its
open item: a time in another city),
[0197](./0197-a-reply-is-written-for-you-and-sent-by-you.md) (availability
now knows where the user is)
**Related:** [0074](./0074-timezone-anchoring-and-invite-reconciliation.md),
[0091](./0091-briefing-as-a-whatsapp-template.md) (weather location),
[0168](./0168-a-cancelled-trip-is-cancelled-not-silent.md),
[0171](./0171-a-deleted-trip-is-recoverable.md),
[0190](./0190-a-trip-is-a-travelers-chain-not-a-date-window.md)

## Context

Three follow-ups to ADR 0244, all the owner's.

1. ADR 0244 left weekday names unparsed ("this Sunday", "tomorrow"). The
   owner: "we should". The recorded potluck email, sent Monday 2026-10-12,
   says "this Sunday at noon"; nothing resolved it to Sunday 18 October 12:00,
   so that time got no free/busy verdict.
2. ADR 0244 listed two gaps in its offset fix: the text-fence tool path, and
   a reservation or event in another city (ADR 0240's open item). The owner:
   "yes", close them.
3. A new rule, in the owner's words: "in case person is traveling, no reason
   to offer an inperson time unless city overlaps". The reply drafter read
   only the calendar's busy blocks, which say when someone is occupied, not
   where they are. With a Denver trip on 20–24 November it would offer coffee
   in New York on the 21st.

## Decision

### 1. Weekday names are dates, counted from the day the text was written

`mentionedDays` / `mentionedSlots` (utils/date-mentions.ts) resolve relative
words against `anchorDay`: the email's sent date in the reader's zone (ADR
0074), never the server clock and never the day the thread is opened.

| Written | Resolves to |
|---|---|
| "today", "tonight" | the sent day |
| "tomorrow" | the day after |
| "Sunday", "this Sunday", "coming Sunday" | the next Sunday after the sent day |
| "this Sunday", written on a Sunday | that day |
| a bare "Sunday", written on a Sunday | **nothing** (today or a week on: the words do not say) |
| "next Friday" | **both** the coming Friday and the one after are listed; no time is asserted on either |
| "next Friday", written on a Friday | a week on |
| "last Friday", "past Friday" | nothing |
| a weekday beside a written date ("Saturday the 24th") | the date only |

"Next Friday" is the genuinely ambiguous one: said on a Monday or a Thursday
it is this week's Friday to some writers and the following week's to others.
Listing both days costs two calendar lines; asserting a verdict on the wrong
one would be a wrong answer, so `mentionedSlots` skips any day that is not
certain.

Abbreviations count only capitalised and where they read as a day ("Fri at
3", "Sat.", "Sun, Oct 18"), so "we sat at the back" is not a Saturday.

A time with no AM/PM ("Friday at 3") is read only where one reading is the
ordinary one: 8–11 is the morning, 1–6 the afternoon. "at 7" and "at 12" are
not guessed. This reverses ADR 0244's "a bare 'at 9' is not guessed at".

### 2. A time at a place is on that place's clock

- `placeTimeZone` (kernel) reads a city, an airport or a street address
  ("650 15th St, Denver, CO") against the existing metro table.
- `placeDatetime` puts a time on that zone's offset **for that date**. Same
  rule as a travel leg: a bare time or one carrying the reader's own offset
  (today's or that date's) is moved; any other offset was chosen and is kept.
- Applied to:
  - chat `create_event` / `update_event` when the call carries a `location`,
    and `add_reservation` with an `address` (`anchorModelTimes`, the one step
    both tool paths now share);
  - `add_reservation` with no usable address: the stay it falls within, then
    the trip's destination (executor, live turns only);
  - email suggestions whose event has a location;
  - restaurant and movie confirmations filed from an attachment.
- **The text-fence path** now runs `normalizeDatetimes` + `anchorModelTimes`
  on every fenced call before execution, so mock and text-only providers get
  the ADR 0244 offset fix as well.
- **When the place's zone cannot be determined** (not in the table), the time
  is read on the reader's clock for that date, which is the only clock
  known. For a reservation the tool result says so: `timeZone: null` and an
  instruction not to call it local time there and to ask if the place is in
  another zone. Nothing is guessed from a city name the table does not hold.
- Not applied when the user named a time zone in the turn, or the email names
  one (`namesATimeZone`), and never to stored values (`normalizeDatetimes` is
  still untouched).

### 3. Travelling: no in-person time unless the city overlaps

**Where the user is** comes from trip data only (`whereabouts.service.ts`),
per local day:

- a leg's departure day through its arrival day is a **travel day** between
  its two ends;
- from the day after arriving somewhere that is not home until the day before
  the next leg leaves (or the trip's last day when no leg brings them back),
  the user is **in that city**;
- a stay's check-in day through check-out day is in the stay's city, unless
  that city is home.

**Whose trip:** a trip in a group the user belongs to counts when the user is
named as a participant, or named on a leg (their persona, or a passenger name
that is theirs), or, when nobody is named anywhere on it, when they created
it. A trip whose tickets all name other people is someone else's travel.
Cancelled legs, stays and trips (ADR 0168) and deleted trips (ADR 0171) are
excluded in the query.

**Home:** the weather location the user set themselves (ADR 0091, source
`user` only: one derived from an IP address follows them and may be the trip
itself), else a confirmed `home_airport` fact, else **unknown**, in which
case each trip's own first origin stands in for home (a chain closes where it
began, ADR 0190). A trip with no legs and no known home counts every stay as
away.

**What the drafter is given** (`userAvailability`, shared with chat's
`get_my_availability`):

- each away day's calendar line ends `| AWAY: in Denver` or
  `| AWAY: travelling New York → Denver`;
- a time that was asked about on an away day reads
  `AWAY that day (in Denver), in person only if the meeting is there;
  calendar FREE (…)`. Away comes first on the line: with "FREE" first a live
  model agreed to coffee in New York on a day in Denver;
- a `Travel` block: "The user is away Fri, Nov 20 to Tue, Nov 24 (Denver),
  back from Wed, Nov 25";
- the first two days at home after the trip are listed, so "after I am back"
  has real days behind it.

**How the meeting's place is read:** by a parser (`meetingHints`), reported
as what the text says and nothing more: whether it names a city the user will
be in, whether it reads as a call ("zoom", "call", "phone"…), whether it reads
as in person ("coffee", "lunch", "in person"…), or that it does not say.

**What the draft does.** When the asked-about time is on an away day and the
text establishes neither a call nor that city, the note beside the
instruction says: do not confirm it in person; say the user is travelling
(city and dates); offer a call at that time or in-person times from the day
they are back. When the text names that city or reads as a call, the
ordinary ADR 0244 answer applies. The system rule covers the general
"suggest times" case the same way.

The same away days are skipped in the "Times the user appears FREE" line the
email pass puts in a "reply with times" to-do.

ADR 0197's rule stands, widened by one source: availability comes from the
calendar and the user's trips, never from the model.

## Alternatives rejected

- **Resolve "next Friday" to one day.** Either choice is wrong for a real
  share of writers, and a verdict on the wrong day is worse than none.
- **Resolve weekdays against today.** A thread opened a week later would move
  "this Sunday" by a week.
- **Geocode an unknown place to get its zone.** A network dependency and a
  guess; the table is curated on purpose (ADR 0133's asymmetry).
- **Put the place rule in `normalizeDatetimes`.** Same objection as ADR 0244:
  it runs over stored values at confirm.
- **Treat trip days as busy blocks.** Busy hides the reason. The user may
  well take a call from Denver, and a meeting in Denver should be offered.
- **Let the model decide whether the meeting is in person or where.** That is
  a guess presented as fact; the parser reports the words, and "does not say"
  is an allowed answer.
- **Use the IP- or zone-derived weather place as home.** It moves with the
  user.
- **Require a known home.** Most users have set none; the trip's own origin
  is right for every round trip.

## Consequences

- "Friday at 3" now gets a 3 PM verdict; a 3 AM meeting would be misread.
- A capitalised "Sat" or "Sun" at the start of a sentence followed by "at"
  ("Sat at the bar all night") lists a stray day.
- A chat event whose `location` is a city in another zone is now taken as
  that city's local time. Someone who says "3 PM, location London" meaning
  3 PM their own time for a call with the London office gets 3 PM London;
  naming their zone ("3 PM ET") keeps it.
- `update_event` with a new time but no `location` in the same call does not
  look up the event's stored location; the reader's clock is used.
- The metro table is the limit of both features: a city not in it has no
  zone (reader's clock, said so) and cannot be matched to "home" except by
  identical text.
- A passenger name is matched to the user by name tokens; a user known only
  by a first name that another traveller shares could be read as away.
- A one-way trip marks the user away until the trip's end date.
- A day of travel is marked for both cities; the drafter does not reason
  about the hours before a flight.
- The slot time on an away day is still read on the user's home clock.
- The fence path's wiring is covered through the shared function
  (`anchorModelTimes`), not by a whole fenced turn.

## Not verified

- Against production; and no real mailbox was used. Integration tests are
  built from the demo account's shapes and were shown failing without the
  change; the travel rule was also run twice against a live model.
- The attachment filer's restaurant/movie change has no test of its own.
