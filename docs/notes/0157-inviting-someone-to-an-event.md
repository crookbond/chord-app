# 0157 — Inviting someone to an event

**Status**: accepted
**Date**: 2026-09-11
**Amended by**: [0295](./0295-guests-live-on-the-calendar.md) — guests are no longer kept in `event_attendees`; they are added and removed on the provider event directly.
**Relation**: gives `create_event` the guest list [0104](./0104-an-invitation-is-answered-not-filed.md)
assumed on the *reading* side (RSVP to an invite you received); writes the
`event_attendees` table (migration `005`, "rsvps successor") for the first time;
name→email resolution follows [0065](./0065-deterministic-contact-discovery.md)'s
sender-scoped rule and [0076](./0076-email-derived-people-and-family-facts.md)'s
`people.email`.

## Context

"Add meeting with Kevin Wednesday 9:30, invite guest.two@gmail.com"
created the meeting on the asker's own calendar and **silently dropped the
invite**. `create_event` has no attendee field, and the Google push
(`localRowToGoogleBody`) never emits an `attendees` array for a Chord-authored
event — the only code that touches `attendees` is ADR 0104's RSVP patch, and
only to set *your own* response on an event *you were invited to*. So Chord
could answer an invitation but never send one.

The user is handing us an email address explicitly. There is no ambiguity to
protect against.

## Decision

**`create_event` and `update_event` take `invitees: string[]` — each entry an
email OR a person's name.** The executor splits them:

- contains `@` → validated as an email, used directly;
- otherwise a name → resolved **sender-scoped** (never a global lookup, ADR
  0065): the asker's `people` rows by name → `people.email` (ADR 0076), then the
  asker's Chord contacts with an email on file;
- unresolved → the event is **still created** (one missing guest must not sink
  the whole request), the result carries `unresolvedInvitees: ["Kevin"]`, and
  the executor attaches a **`kind: 'contact'` `BotCard`** per unresolved name.

Resolved emails are written to **`event_attendees`** (`ical_uid` + `email`,
`user_id` NULL, `role='viewer'`, `response_status='needsAction'`). The event is
marked dirty and `pushDirtyEvents` sends the invitations: `localRowToGoogleBody`
gains an `attendees` array loaded per `ical_uid`, and the insert/patch URL gets
`?sendUpdates=all` **only when the event has attendees** (a plain event keeps
today's silent write). On a patch Google replaces the whole array, so the full
current list is always sent.

### The model never invents an email

`invitees` entries that are names are resolved by the *server*, from the asker's
own data. The tool description forbids guessing an address; the `@`-check plus
the resolver are the choke point (ADR 0100/0102's precedent — a prose rule needs
a server backstop). An unresolved name produces a card, not a fabricated
address.

### The `contact` card and the native picker

A `kind: 'contact'` card carries `contactName`. Mobile renders it as "Add
Kevin from Contacts" → `expo-contacts` `presentContactPickerAsync()` (the OS
picker, no custom UI; new `NSContactsUsageDescription` / `READ_CONTACTS`) → the
chosen email is posted back as a plain chat message ("Kevin's email is …").
The bot's next turn still has the original request in its context window (ADR
0035) and calls `update_event` with `invitees: ["…@…"]`. Bridged surfaces
(Telegram etc.) get the card as text ("reply with Kevin's email"); they have
no picker.

### The device-calendar conflict bug, fixed alongside

Diagnosing "why did a read-only school event trigger a conflict nudge" found
`eventBlocksTime` knows only two `external_uid` shapes — `gcal:<calId>:<uid>`
and "everything else → Chord-native → always blocks". Device-calendar copies
(ADR 0057/0136) carry `device:<calId>:<uid>`, which fell into "always blocks",
so an event on a `counts_for_busy = 0` subscribed calendar counted as busy.
`eventBlocksTime` gains a `device:` branch mirroring `gcal:` — `ctx.busy`
already holds device-calendar ids (`busyCalendarIds` never filtered by
provider).

## Rejected

- **An `attendees` field of emails only** (no names). Forces the model to
  resolve, which it does by guessing — the exact failure this prevents. One
  field that takes either, resolved server-side, keeps the model honest.
- **Blocking the create until every guest resolves.** "Meeting with Kevin" is
  worth creating even if Kevin's email needs a follow-up.
- **A new `event_invitees` table.** `event_attendees` already has the exact
  shape (`ical_uid`, nullable `email`, `response_status`) and was built for
  this.
- **`sendUpdates=all` on every push.** Would email every guest on an unrelated
  edit. Gated on the event actually having attendees.
- **A custom in-app contact list.** `presentContactPickerAsync` is the OS
  picker — no UI to build, and no contact data reaches Chord beyond the one
  email the user picks.

## Consequences

- `event_attendees` goes live. Reading external RSVP responses back from Google
  (`attendees[].responseStatus` on the pull) is a follow-up — the column is
  there.
- Removing a guest is not built; `update_event` only adds.
- A guest with no email in the asker's contacts always costs one round-trip.

## Addendum 2026-10-27 — a name is looked up on the asker's phone, and the editor adds guests

Reported: "invite Karl Dale" answered "still need an email for Karl Dale"
although Karl is in the phone's contacts and Contacts is allowed. Cause:
`resolveInvitees` (`bot/executor.ts`) tried saved People and Chord contacts
only; the ADR 0212 phone lookup was wired into `get_contact_info` and role
search, never into invitees. And the event editor had no guests at all.

**Chat.** A name the server cannot place is now asked of the asker's phone
(`requestDeviceContact`, all names side by side, `CONTACT_LOOKUP_TIMEOUT_MS`),
on a live chat turn only: no turn id (ingest, proposal confirm) or a turn from
WhatsApp/Telegram (`sourceBinding`) asks nothing, since no app is listening.
`pickInviteeFromDevice` (kernel) settles the answer: one contact whose full
name is exactly the name asked, else the only contact with an address, is
invited at its first address and the reply names it; several fit = the result
lists them and the bot asks which, never picks; none = `unresolvedInvitees`
and the contact card as before. It now also runs in a shared chat, so the
`contact.lookup` request carries **`forUserId`** and the app answers only when
it is that user's phone; the server already refused an answer from anyone but
the asker. An app from before this update answers a lookup meant for someone
else (the answer is refused, but on Android an undecided permission would show
its explanation), which the over-the-air update closes.

**Editor.** `GET`/`POST /api/v1/events/:id/guests` (`API.eventGuests`) read and
change the guests through the same `changeEventGuests` as the bot's
`update_event { invitees, removeInvitees }` (ADR 0295): only the organizer may,
a refusal returns `reason` and invites nobody, addresses only. The editor's
Guests box is the composer's recipient field, so it suggests from mail, People
and the phone's contacts; a typed name that was not picked is pointed out, not
guessed (`parseGuestAddresses`). Chat equivalent: `update_event` invitees,
which already existed.

Rejected: uploading the address book, guessing among several matching
contacts, asking the phone from a bridged chat.
