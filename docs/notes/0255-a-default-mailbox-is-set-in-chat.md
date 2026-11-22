# 0255 — A default mailbox is set in chat

**Status**: accepted
**Date**: 2026-10-15

## Context

New mail (chat `compose_email`, the ADR 0237 family-invite email, the app's
New message screen) always left from the primary Gmail when Chord could send
from it, else the oldest attached mailbox that did not need reconnecting. The
rule was computed, never stored, so "send my emails from Outlook" had nowhere
to go. ADR 0256 fixed the same gap for calendars.

## Decision

**`users.default_send_mailbox` (migration `107`): `'primary'` for the sign-in
Gmail, else an `email_accounts.id`; NULL = the built-in rule.** Set in chat
only, by owner decision: no Settings control.

- **One reader, `resolveSendMailbox`** (`services/email/default-mailbox.ts`):
  the stored mailbox while it can still send, else the built-in rule. A
  removed account or one needing reconnecting falls back silently, so a stale
  choice never strands a send. `defaultSendMailbox` (chat compose, family
  invite) now calls it, and `GET /me/email/status` returns it as
  `defaultSendAccountId` so the New message screen opens on it (a resumed
  draft keeps its own mailbox).
- **One writer, `setDefaultMailbox`**, from what the user called it: the
  provider ("Outlook", "Gmail", a preset like "Yahoo"), the address, its local
  part, the domain's first label, or the ADR 0145 nickname. Exact match wins;
  otherwise a partial match (3+ characters) must be unique. Several matches
  return `ambiguous` + candidates and store nothing (ADR 0137's posture);
  a mailbox needing reconnecting is refused (`needs_reconnect`), never stored.
  An empty name clears the choice.
- **Chat**: `set_default_mailbox { mailbox? }`, personal 1:1 only (candidates
  name the asker's mailboxes); omitting `mailbox` reads the mailbox in use and
  whether the user chose it.
- **Scope**: new messages only. A reply or forward still goes from the
  mailbox the email arrived in, and a send-as alias (ADR 0130) is not a
  mailbox choice.

## Consequences

- The app shows the choice but cannot change it; the From picker still
  changes one message.
- No foreign key: an account id outliving its account is ignored at read.

## Addendum 2026-10-15 — the card names its sender; later defaults are key → value

**The compose card shows "from <address>", and the send uses that mailbox.**
The sender used to be worked out when Send was tapped, so with several
mailboxes the card could not say where the email would come from. It is now
fixed when the card is staged (`stageProposalArgs` puts `fromMailbox` /
`fromAddress` on the proposal; both are stripped from the model's schema via
`INTERNAL_TOOL_FIELDS`, ADR 0102). Confirming sends from exactly that mailbox,
even if the default changed in between. If that mailbox can no longer send,
the confirm is refused (`mailbox_unavailable`) rather than switching to
another address the user never saw. Calls with no `fromMailbox` (the family
invite, old proposals) still use `resolveSendMailbox` at send time.

**"What is my default mailbox / calendar?"** is named in both tool
descriptions as a read (omit the argument), answered from the result.

**Every LATER per-user default goes in `users.defaults` (jsonb, migration
`108`) as key → value, not in a new column** (owner decision). Declared with
`defineUserDefault(key, zodSchema)` in `services/user-defaults.service.ts`,
which returns `get` / `set` (`null` removes the key). Each key validates on
write and on read; a stored value that no longer parses reads as unset. The
two existing defaults keep their columns. No key is declared yet.

## Rejected

- **A Settings picker**: owner decision, chat is the interface for this.
- **Storing the address instead of the id**: two accounts can share a
  provider, and an address can be re-attached as a new account row.
- **Clearing the choice when its account is removed**: the read already
  ignores it, and a cleanup hook on every account delete is one more place to
  forget.
