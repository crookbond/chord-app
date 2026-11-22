# ADR 0145 — A mailbox can be given a name

**Status:** Accepted (2026-09-01)
**Related:** [0119](./0119-a-list-that-ends-and-a-row-that-says-where-it-came-from.md),
[0080](./0080-multi-account-email-providers.md),
[0141](./0141-chord-labels-are-usage-derived-and-ours.md),
[0142](./0142-chord-label-push-is-one-way-and-optional.md)

## Context

ADR 0119 added the mailbox filter chips and labelled each one with the
address's **local part**, reasoning that it "is what tells two of someone's own
mailboxes apart in the space a row has." True for two. In practice a user has
five, and the row reads:

> All mail · Gmail · crookbond · john_doe · jdoe · john

Four of those are the same person's name spelled four ways. The local part
identifies the *address*; it does not say what the mailbox is *for*, which is
the only thing a filter chip needs to convey.

`email_accounts.display_name` already exists and is the obvious place to put a
better name. It is the wrong place.

## Decision

A user-chosen `nickname`, in its **own column**, winning over the local part.

### Not `display_name`

`display_name` is **provider-supplied** — Outlook's account display name, set
at connect — and `insertAccount` rewrites it on every re-attach. A nickname
stored there would be silently erased the next time a mailbox was reconnected,
which is precisely the ADR 0141 failure: writing into a column the sync owns.

That ADR's rule generalises, and this is its second application: **a value a
user chose needs a column no sync writes.** There is a test that renames a
mailbox, reconnects it, and asserts the name survived — the reasoning is not
worth much without it.

### The primary Gmail's name lives on `users`

ADR 0080's convention is that `account_id NULL` **is** the primary Gmail — it
has no `email_accounts` row to hang anything on. So its nickname is
`users.gmail_nickname`, the same asymmetry ADR 0142 already established for
label-push opt-in (`users.chord_label_push_enabled` beside
`email_accounts.label_push_enabled`). Following the existing split beats
inventing a synthetic account row for the primary.

### The fallback rule lives in kernel

`mailboxDisplayName(nickname, address)` and `primaryMailboxDisplayName(nickname)`
are in `kernel/src/mailbox-name.ts`, because three surfaces render the same
mailbox — the chip row, the per-row account badge, and Settings — and three
copies of a fallback chain is how they stop agreeing. Same reasoning ADR 0085
and 0127 apply to search predicates, and the reason ADR 0120/0121 put string
logic in kernel: it is also the only place with a test harness.

A whitespace-only nickname falls back rather than rendering an invisible chip,
and `normalizeMailboxNickname` turns an empty field into `null` — that is how a
mailbox goes *back* to its default name, so "cleared" must not be stored as a
nickname that renders blank.

### The prefs patch became partial

`SetEmailAccountPrefsRequest` had one required field; it now has two optional
ones with an at-least-one refine, and `setAccountLabelPushEnabled` became
`setAccountPrefs`. An absent field is **left alone**, not cleared — renaming a
mailbox must not silently switch its label push off, and vice versa. Both
directions have a test, because that is the kind of thing a later refactor
quietly breaks.

### The row badge had to be resolved, not read

A thread row carries `accountId` and `accountEmail` but no nickname, so the
per-row badge resolves the name from the account list in the parent. Worth
noting because the alternative — putting the nickname on every
`EmailThreadSummary` — would ship the same string on every row of every page
to save one lookup.

## Consequences

- Chips read "Work", "School", "Personal" instead of four spellings of a name.
- Nothing is unique-checked. Two mailboxes may share a nickname; that is the
  user's call, and both chips remain visible and tappable.
- The nickname is Chord-local and is never pushed to the provider — consistent
  with ADR 0142's one-way posture, and there is no provider concept to push it
  to anyway.

## Rejected alternatives

- **Reusing `display_name`.** The provider owns it and rewrites it on
  re-attach; the nickname would vanish on reconnect.
- **A synthetic `email_accounts` row for the primary Gmail.** Would unify the
  two storage sites, and breaks ADR 0080's `account_id NULL` convention, which
  a great deal of the mail code keys on.
- **Storing nicknames client-side** (AsyncStorage). No migration, and the name
  would not follow the user to another device or to the web client — for a
  label whose whole job is to be recognisable, that is worse than not having it.
- **Defaulting the nickname to the provider's `display_name`.** Sounds
  helpful, and it would mean a mailbox that had never been renamed still
  changed its name on reconnect. The default is the local part precisely
  because nothing rewrites it.
