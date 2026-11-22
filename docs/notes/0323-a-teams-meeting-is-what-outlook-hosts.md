# 0323 — A Teams meeting is what Outlook hosts

Status: accepted (2026-11-05)

## Context

Owner, on reading ADR 0319: "outlook: → none; could be Microsoft Teams."

ADR 0319 made the video-call default follow the calendar's provider and gave
an Outlook / Microsoft 365 calendar **none**, for one reason: Chord could
create exactly one kind of video call, a Google Meet (ADR 0317), and putting a
Meet on a 365 event is a link to a service the organiser never chose. So a 365
user who asked for a video call was told plainly that Chord could not make
one, naming Teams.

0319's own Rejected section had already been corrected on this point after the
owner raised it. The first draft of that note overstated the cost — it claimed
a Teams meeting would need Graph's separate `onlineMeeting` resource — and
checking the API showed otherwise. Re-verified against the current Graph v1.0
documentation before anything was written here:

- `isOnlineMeeting: true` + `onlineMeetingProvider: "teamsForBusiness"` are
  **writable properties of the event itself**. The PATCH body is exactly those
  two fields. No separate resource, and no scope beyond the
  `Calendars.ReadWrite` that ADR 0228's Outlook calendar grant already holds.
- `onlineMeeting` is **read-only**: Graph initializes it in response to those
  two fields, and `onlineMeeting.joinUrl` is the link. (`onlineMeetingUrl` is
  documented as deprecated and is not used.)
- **Once enabled it cannot be changed or turned off**: "you cannot change the
  **onlineMeetingProvider** property, nor set **isOnlineMeeting** to `false`".
- A calendar says whether it can host one at all: Microsoft's own guidance is
  to read a calendar's `allowedOnlineMeetingProviders` (and
  `defaultOnlineMeetingProvider`) to see which providers it supports. A
  personal (consumer) Outlook account does not list `teamsForBusiness`, and a
  tenant without the licence refuses.

Two of those four were not in the brief this was built from, and both changed
the design. So this is not a flag on 0319: it widens the kernel rule's return
type and every surface reading it, and it has a real failure mode that has to
be honest rather than assumed.

## Decision

**An Outlook / 365 calendar gets a Teams meeting.** `VideoCallKind` becomes
`'google_meet' | 'teams'`, and `videoCallDefaultFor` returns `'teams'` for an
`outlook:` key (ADR 0228) or a caller-supplied `provider: 'outlook'`. The half
of 0319 that does not move: **the kinds are never crossed** — no Meet on a 365
event, no Teams meeting on a Google one — and a phone-mirrored calendar, which
Chord reads and does not write, still gets neither.

The kernel rule answers what the **provider offers**, not what one mailbox is
entitled to. Whether a tenant licenses Teams is a question only Graph can
answer, and it is answered at the write.

**One transport verb, both providers implement it.** `CalendarTransport` gains
`addOnlineMeeting(calendarId, eventId, { requestId, notify })` →
`{ok, joinUrl} | {ok: false, reason: 'unsupported' | 'error'}`. Google's
implementation is 0317's `conferenceData` create request with
`conferenceDataVersion=1`; Outlook's is the calendar pre-check, the two
fields, and the join-link read-back. A verb rather than a conference-shaped
body each provider reinterprets, because the two write nothing alike and only
the provider knows whether its own answer really happened — and it is a verb
on **both** sides, not an Outlook-only extension beside an inline Google
patch, so a reader does not have to ask why they differ.

`GoogleEventResource.hangoutLink` becomes **`videoCallLink`**. The engine's
shape is Google's as a lingua franca (ADR 0228), and `map.ts` settles the
differences — but the only thing that reads this field asks "does this event
already have one", and a field named for Google carrying a Teams URL is how
that answer starts to lie. Google's transport fills it from the wire's
`hangoutLink`; `graphEventToResource` fills it from `onlineMeeting.joinUrl`.
It is also what makes "already has one" correct on Outlook, which matters more
there than on Google: Graph will not let a Teams meeting be changed or removed,
so an event that has one is answered with the link it has and nothing is
written.

**The write is verified, not trusted.** Graph is reported to answer 200 with
`isOnlineMeeting: false` and provider `unknown` where the provider is not
allowed — accepted, and nothing happened. That is the ADR 0137 shape (Meta
accepting a message and failing delivery into a warn nobody read), so a
response with no join link is re-read once and then **refused**, never passed
on as pending. Unlike a Meet, a Teams join URL comes back with the write, so
there is nothing to wait for; `videoCallNote`'s "not returned yet" line is
therefore reachable only for Google, and says so.

A calendar that **cannot be read** is not taken as a yes. Guessing there costs
a write that reports a meeting nobody can join, which is the whole failure this
ADR is written to avoid.

**The refusals are real, and reworded.** `not_google` becomes
**`no_video_call`** — its old name was already a near-lie for a phone
calendar, and its copy ("a Google Meet is the only video call Chord can add
... it cannot create a Teams meeting") is now false wherever it appears. New
**`teams_unavailable`** says what actually happened: this Outlook calendar does
not offer Teams meetings, a personal account has no Teams for Business, a work
tenant needs the licence — and the bot is told explicitly **not to offer a
Google Meet instead**, which is the one wrong answer available to it.

**An unasked default that fails says nothing.** 0319 made an unasked
`videoCall: true` silent where the calendar has no option; it is now silent
where the attempt **fails** too. An Outlook calendar offers Teams but an
unlicensed tenant refuses, and reporting that refusal would be a complaint
about a meeting nobody asked for — the exact noise 0319 removed. An explicit
ask is still honoured, or refused in plain words (ADR 0102).

**Every surface reads the one rule.** The editor's button is *named* from
`EventGuestsResponse.videoCall` — "Add Google Meet" or "Add Teams meeting" —
rather than deriving the label a second time, and the route returns `kind` on
success so the app reports what was really added. Both tool descriptions say
which kind is the calendar's, never the asker's.

## Consequences

- **A 365 user gets a working video call.** The reply names Teams, and the
  link is the one Outlook's own "Teams meeting" toggle would have produced.
- **0319's "only offer what works" is weakened for Outlook, deliberately.**
  `eventVideoCallOption` runs on every read of an event's guests, and a Graph
  round trip there is the per-request cost ADR 0204 took out — so it answers
  from the calendar key and the mailbox connection, without asking Microsoft.
  The editor can therefore offer "Add Teams meeting" on a personal Outlook
  account where the tap will refuse. The refusal is honest and names why, but
  it is a dead button for that user, which 0319 set out to avoid. Caching
  `allowedOnlineMeetingProviders` on `calendar_sources` would close it: the
  calendar sync already lists calendars, so the value is one `$select` away and
  needs no extra call. It is not done here because it means a migration plus a
  `$select` change on a provider path nothing has verified live, in the same
  change as the capability itself. Named, not hidden.
- **Nothing has round-tripped against a live Microsoft tenant**, the same
  posture ADRs 0118, 0140 and 0228 state about their own unverified paths. The
  request and response shapes are Graph's documented ones and the tests pin
  them at the fetch boundary, including the failure paths — which is the right
  way round, since those are the ones that run when a shape is wrong.
- **Four tests flipped rather than being deleted** (ADR 0108/0139's
  treatment): the kernel rule's Outlook case now expects `'teams'`, and three
  refusal assertions that named Google Meet now name neither, because which
  kind was wanted is the calendar's to say. The `outlook:` key in 0319's own
  integration test has no mailbox behind it, so it keeps covering the
  no-connection case — a working 365 calendar has its own file, which is also
  where the Graph shapes are pinned.
- Nothing is stored and there is no migration. The option is still derived from
  the event's calendar on every read, so a reconnect or a moved event needs no
  backfill.
- **No platform-specific code.** The editor change is one button label and one
  refusal string in `mobile/src/event-guests.tsx`, which iOS, Android and web
  all render the same way, so the "every iPhone change is an Android change"
  rule is satisfied by there being nothing to branch on.

## Rejected

- **Leaving Outlook with no video call** (0319's position): it was right only
  while Chord could not make one, and the API check that prompted this ADR
  showed it can, at no new scope and no new consent.
- **Putting a Google Meet on a 365 event**: the organiser never chose that
  service, and on a work tenant their guests often cannot open it. This is the
  half of 0319 that does not move, and the `teams_unavailable` copy forbids the
  bot from offering it as a consolation.
- **Smuggling the Teams request through a Google-shaped `conferenceData`
  body**, translated in `map.ts` like every other field. It fits ADR 0228's
  design on paper, and it cannot carry the calendar pre-check at all — that is
  "does this calendar support Teams", which has no Google analogue to express
  it in. The verb carries the check, the write and the verification in the one
  place that understands Graph.
- **Keeping `hangoutLink` as the shared field** and letting Graph fill it. It
  is the smaller diff and follows the existing mapping pattern (`subject` →
  `summary`, `showAs` → `transparency`), but those are Google names for the
  same *concept*; `hangoutLink` names one specific product, and the field would
  then answer "does it already have a Meet" with a Teams URL.
- **Asking Graph inside `eventVideoCallOption`** so the button is never dead:
  that is a provider round trip on every event-editor open, the cost ADR 0204
  was written about. See the consequence above for the version that pays for
  itself.
- **Trusting the PATCH response because it returned 200.** The community
  reports of an accepted write that does nothing are not official, which is
  exactly why the link is read back rather than assumed — a claimed meeting
  nobody can join is worse than a refusal.
- **Reporting a failed unasked default**: ADR 0229's posture, and 0319's.
- **Teams on a Google calendar, or an `onlineMeetingProvider` the user picks**:
  the owner asked for a rule that follows the calendar, and a choice would need
  a Settings surface, a chat tool, and an answer for the user whose calendars
  span two providers.
- **`skypeForBusiness` / `skypeForConsumer`**, which the same two fields can
  also request. Nobody asked, Skype for Business is superseded by Teams by
  Microsoft's own documentation, and each one added is another kind every
  surface has to name.
