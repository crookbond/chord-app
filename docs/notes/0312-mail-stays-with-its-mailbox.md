# ADR 0312 — Mail stays with its mailbox

**Status:** Accepted (secondary-Gmail calendars are a follow-up, see
Consequences)
**Date:** 2026-10-30
**Amends:** ADR 0080, 0104, 0228, 0232, 0249

## Context

A user can connect several mailboxes (ADR 0080): the primary Gmail, other
Gmail accounts, Outlook/M365 and IMAP. A work mailbox and a family mailbox
are routine. Everything the email pipeline produces was scoped to the
**user**, and the mailbox an email arrived in was recorded only inside the
`gmail:<threadId>` provenance string (an attached mailbox's thread ids carry
its account id as a prefix, `scopedId`).

Two leaks follow, both found while answering "what happens when a mailbox is
disconnected":

1. **Events went to the user's calendar, not the mailbox's.** A confirmed
   `create_event` from email resolved its calendar like any chat request
   (`resolveTargetCalendarId`: the user's default, else the primary). A
   meeting from the work Outlook mailbox landed on the personal or Family
   Google calendar, with the ADR 0162 excerpt of the work email in its
   description.
2. **Invitations were answered from the wrong place.** `respondToInvite`
   (ADR 0104) tried every Google calendar first, then every Outlook mailbox,
   and its iTIP fallback always sent from the primary Gmail address. An
   invitation to the work address could be accepted on, or replied to from,
   the personal account, telling the organizer an address they were never
   given.

The owner's rule: a calendar or an answer from one mailbox must never cross
to another.

## Decision

**The mailbox an email came to decides where its calendar items go and which
account answers its invitations.** `services/email/source-mailbox.ts` reads
the mailbox off the provenance (`mailboxOfProvenance`: the thread row's
`account_id`, else the account-id prefix of the thread id, else the primary
Gmail) and names its calendar (`mailboxCalendar`):

| Mail arrived in | Calendar items go to |
|---|---|
| Primary Gmail | The user's default calendar when it is a **Google** calendar, else the Google primary. No Google calendar grant: the card asks. |
| Outlook with its calendar connected (ADR 0228) | That mailbox's own calendar, whatever the user's default is (owner rule). |
| Outlook without calendar access, IMAP, secondary Gmail | **The card asks.** It lists the user's writable calendars and nothing is preselected silently. |

- **No calendar anywhere = saved in Chord, not refused.** When the user can
  write to no calendar at all there is nothing to leak into and nothing to
  pick, so the event is kept in Chord as before.
- **A choice on the card wins**, and it is checked: the calendar must be one
  the user can write to (`isPushableCalendar`). A confirm that needs a choice
  and has none (a chat "yes", a WhatsApp tap) is refused with
  `calendar_required`, never placed on a guess.
- **Chat requests are untouched.** Only a call carrying `gmail:` provenance
  is routed by mailbox; "add dinner Friday" still follows ADR 0232.
- **Invitations are answered by the receiving mailbox only.** Primary Gmail:
  the Google calendar patch, then the iTIP reply from the primary address.
  An Outlook mailbox: that mailbox's calendar answer, then an iTIP reply sent
  **from that mailbox**. A secondary Gmail or IMAP mailbox: an iTIP reply
  from that mailbox. No route ever falls through to another mailbox; when the
  receiving one cannot answer, the result says so
  (`mailbox_cannot_answer`) and the card stays pending (ADR 0104).
- The proposal carries `calendarChoice` (`auto` with the calendar it will
  use, or `ask`) so the card shows where the event will go before the tap.

## Consequences

- An Outlook-calendar invite accepted from the card lands on that Outlook
  calendar, which is where Outlook puts it anyway.
- **Disconnecting a mailbox removes what its mail produced**
  (`email/mailbox-purge.ts`, run by `disconnectGmail` and
  `disconnectAccount` BEFORE the threads are wiped; amends ADR 0249, whose
  receipts outlived their mailbox): its travel legs (and their flight
  events, removed from the provider calendar too), stays and reservations,
  any trip left empty (soft delete, ADR 0171), the people it introduced
  (their dates cascade), person relationships, facts (a typed fact one of
  them had replaced comes back), and its receipts. A trip still holding
  something typed or from another mailbox stays. Pending cards and confirmed
  to-dos are left (owner). A row belongs to a mailbox by its `gmail:`
  provenance: `gmail:<accountId>:…` for an attached mailbox, a bare id for
  the primary; a trip filed from an email attachment is traced through
  `attachments.origin_email_thread_id`. `people.provenance` is new
  (migration `133`); people and facts made before this have no source and
  are kept. Moving a mailbox to another account on a sign-in fold
  (`moveMailboxesTo`) keeps everything (`keepDerived`).
- **A flight from email goes on its mailbox's calendar** (`calendarForBooking`
  in `syncFlightLegEvent`); only a booking whose mailbox has no calendar
  uses the user's default, the one case the owner allows across mailboxes.
- **Secondary Gmail calendars** (its own session): a second Google account
  has its own calendar and its events should go there, which needs the
  calendar scope on the secondary connect and per-account Google sync. Until
  then such mail asks on the card.
- Not covered: meeting context (ADR 0163) still searches every mailbox;
  attachments imported from a disconnected mailbox stay in Attachments;
  existing events are not moved.

## Rejected

- **Routing by the user's default and warning.** The leak is the default.
- **Silently picking the user's default when a mailbox has no calendar.**
  The owner chose "ask on the card" for IMAP; it is the same gap for the
  others until they can be connected.
- **Falling back to the primary Gmail for the iTIP reply.** That fallback is
  the second leak.
