# 0114 — Suggestions come from your own mail

**Status**: accepted
**Date**: 2026-08-25
**Relation**: Wave 2 of [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
applies [ADR 0065](./0065-deterministic-contact-discovery.md)'s scoping rule to
the composer; draws on [ADR 0076](./0076-email-derived-people-and-family-facts.md)'s
`people.email`.

## Context

Typing a full address on a phone is the friction in every compose. Autocomplete
is the fix, and the only real question is where the candidates come from.

That question is a privacy question, not a data question. A field that answers
a two-letter prefix with matching addresses **is a directory**. Point it at the
wrong table and the composer becomes a way to enumerate every address the
system has ever seen.

## Decision

**Only the user's own mail and their own people rows.** Never a global lookup.

This is the rule ADR 0065 already put on contact resolution — `resolveContactToUser`
is strictly sender-scoped, never a global user search — and the reason carries
over exactly: suggesting an address is a small disclosure, and every row
returned here is one the user has already seen in their own mailbox.

Three sources, merged by address:

| Source | Weight | Why |
|---|---|---|
| Addresses on a To line | 2 per message | An address you *chose* |
| Senders you've received from | 1 per message | Mail arrives unbidden |
| `people.email` (ADR 0076) | 25 | Someone the user told us about |

### Frequency, not recency

Ranking on recency alone puts yesterday's newsletter above the person you email
weekly. The person you mail constantly is who you are probably writing to; the
one you mailed an hour ago is already on screen. Recency stays as the
tiebreaker, where it belongs.

### Two characters minimum

Below that a prefix matches most of a mailbox: a slow scan producing a list
nobody can use. ADR 0085 put the same floor on the literal search arm for the
same reason.

### Matching the name, not just the address

People search for "chen", not for an address they never memorised. So the
sender arm matches `from_name` as well as `from_email` — and prefers a name the
user typed (`people`) over one a sender chose for themselves.

## Consequences

- The composer completes from real correspondence, so it is useful on the first
  message rather than after training.
- A shared-group member's contacts never appear: everything is keyed on
  `user_id`, and there is a test that asserts a second user sees nothing.
- The client fetches per **token**, not per field: "ruth@example.com, ch" asks
  about `ch`. That is the only real complexity in the UI, and why the field is
  a component rather than a prop.
- Requests are sequenced, so an older response cannot repopulate a list the
  user has typed past.

## Alternatives rejected

**A global address index.** Trivially better completions, and a directory of
everyone's addresses reachable by prefix from a text field. Not a trade worth
making for saved keystrokes.

**Device contacts.** The phone already has them, and ADR 0065 deliberately
never uploads raw numbers or addresses — pulling the address book into the
composer would undo that on the mail side.

**Recency-only ranking.** Simpler query, worse first suggestion, every time.

**A materialised contacts table.** Faster, and a second copy of something the
mailbox already knows, needing invalidation nobody would remember to write. The
live query is bounded by `user_id` and capped.

## Addendum 2026-10-27 — this phone's contacts, matched on the phone

Reported: Contacts allowed, yet typing in To/Cc/Bcc never offered anyone from
the phone. Cause: the field asked only the server (`suggestEmailRecipients`),
which by this ADR knows the user's mail and People and nothing else; no code
read the address book for suggestions at all.

On iPhone and Android the field now also matches the phone's contacts **on the
device** (`suggestDeviceRecipients` in `kernel/src/device-contact.ts`: every
typed word starts a word of the contact's name, or the token starts one of its
addresses; one row per address; entries without an email skipped) and appends
them after the server's rows (`mergeRecipientSuggestions`: server order kept,
one row per address, a nameless server row borrows the contact's name), tagged
"Contacts". `mobile/src/device-contacts.ts` reads only the Emails field, keeps
it in memory for 5 minutes, forgets it on sign-out, and asks for the
permission at most once per app run, from a field being focused (never
mid-keystroke; Android shows the ADR 0263 explanation first).

**The posture of this ADR and ADR 0065 holds**: nothing from the address book
is sent to the server; the server still answers only from mail and People.
Web has no address book and keeps the mail-derived suggestions only. No new
native module (`expo-contacts` is already in the build), so this ships over the
air. No bot tool: it changes nothing.

Rejected: uploading the address book for a server-side merge (reverses 0065
for a typing aid), asking for the permission on the first keystroke.
