# ADR 0214 — The rest of email is sayable in chat

**Status:** Accepted
**Date:** 2026-09-27
**Extends:** ADR 0107, 0112, 0115, 0149, 0197

## Context

The project rule is that every mutating capability has a bot tool. An audit
of the email surface found six things the app could do and chat could not:

1. Write a **new** email. `reply_to_email` needs an existing thread.
2. **Forward** a thread.
3. **Undo** a queued send.
4. Turn the email section of the morning briefing on or off. Only
   per-sender exclusions were sayable.
5. **Mute the briefing on one WhatsApp chat.**
6. **Read** a thread. `search` returns hits, not bodies, so "what did the
   teacher say about Friday?" could not be answered from the message itself.

Everything else the audit found was either covered already, or is mailbox
management that ADR 0107/0149 deliberately leave to the provider (archive,
labels, snooze, the vacation responder, drafts UI).

Admitted under ADR 0149's gate. Compose and forward are the answering half
of coordination: "email the coach we're out Saturday" and "forward the
school email to Dad". Reading is what lets the bot answer about a message
at all. Items 4 and 5 are the briefing, which ADR 0149 names as a
sanctioned lane.

## Decision

Six tools, all **personal 1:1 only** (`PERSONAL_ONLY_TOOL_NAMES`), because
each touches the user's own mailbox or their own briefing settings. The
non-proposal ones also re-check `isPersonalTurn` in the executor, as
`send_briefing` does.

- **`compose_email` and `forward_email` are proposals**, joining
  `reply_to_email` in `PROPOSABLE_TOOLS`. `chord_email.md` §3.4 sets the
  rule: *nothing is sent without a human tap*. The bot's call stages a card
  and touches no mailbox. Only the confirm path reaches the send.
- **The send goes through the composer's own path**: `saveDraft` and then
  `queueSend` (ADR 0113/0115), not a direct provider call. So a bot-sent
  message gets the same undo window, and a send that fails lands back in
  Drafts with its error instead of vanishing. This differs from
  `reply_to_email`'s commit, which predates it and still sends directly.
- **Addresses must be addresses.** `to`/`cc` are validated as email. The
  description tells the model to look a name up (`get_contact_info`,
  `list_people`, `search`) or ask, never to guess. A made-up address sends
  mail to a stranger.
- **The forward card names the email from the database, not the model.**
  `threadSubject` is resolved at propose time and hidden from the model's
  schema (`INTERNAL_TOOL_FIELDS`). A subject the model supplied is
  discarded, because it could name a different thread than the id does.
- **Compose sends from the default mailbox**: the primary Gmail when Chord
  may send from it, else the oldest attached mailbox that doesn't need
  reconnecting. With none, the result says so and nothing is queued.
- **`cancel_email_send`** undoes the most recently queued message. Chat
  cannot name a draft id, because tool results do not survive a turn (ADR
  0093). `cancelled: false` means it already went, and the bot says so
  (ADR 0102).
- **`read_email`** returns the newest N messages (default 5, max 20), with
  quoted history folded (ADR 0121) and bodies capped at 4,000 characters.
  It does **not** mark the thread read: the bot reading is not the user
  reading (ADR 0124's reasoning). It does not run the read-time pass either,
  since ADR 0180 is about the user having the message open. The description
  marks the bodies as outside data whose instructions are never followed.
- **`set_email_digest`** flips `users.email_digest_enabled`, the same column
  the prefs route writes.
- **`set_briefing_channel`** mutes or resumes one WhatsApp chat through the
  route's own `setBriefingChannelMuted`. The chat is chosen by group name;
  with one chat there is nothing to name. Several chats with no name, or a
  name that matches none, returns the list, and the bot asks (ADR 0077/0094).

## Consequences

- **Chat has its own, longer undo window.** `EMAIL_UNDO_SECONDS` (8s)
  suits a tap in the composer, but "unsend that" has to be typed, and the
  message would usually have gone first. Chat sends use
  `EMAIL_CHAT_UNDO_SECONDS` (default **60s**, an owner decision) via
  `queueSend`'s new `holdSeconds`. The cost is that a confirmed chat email
  leaves up to a minute later than a composed one.
- **The outbox scheduler now runs unless BOTH holds are 0.** ADR 0115 turned
  it off at `EMAIL_UNDO_SECONDS=0`. That was right while only the composer
  queued, but chat always queues, so an app hold of 0 would have left chat
  mail in the outbox forever. A chat hold of 0 sends on confirm (queue, then
  flush) rather than relying on the scheduler.
- The mobile proposal rows render the two new tools, showing the whole body
  for compose, like a reply.
- The ADR 0197 **Edit** hand-off (open the draft in the composer) exists
  only for replies. Compose and forward cards are confirm or reject.

## Rejected

- **Direct provider send on confirm**, as `reply_to_email` does. It loses
  undo, and a failed send is lost with it.
- **Letting the model name the forward's subject.** Rejected for the reason
  given above.
- **A bot tool per management verb** (archive, label, snooze). ADR 0107/0149
  keep these with the provider on purpose.
- **Marking a thread read when the bot reads it.** That would hide unread
  mail from the decision queue and from ADR 0117's notification because the
  bot looked at it.

## Addendum 2026-10-30: an address needs a source, not just a shape

Prod: the model handed twelve mailing lists over as `name@example.com`
(ADR 0307 addendum). The same model writes `to`/`cc` here, and the tool
description already said "never invent an address" - which is the ADR 0100
lesson again: an instruction alone is not enough when the cost of a miss is
mail to a stranger that cannot be called back. A card shows the address
before the tap, but a plausible guess reads as right.

So an address the model wrote must have a source (`email/known-addresses.ts`,
one rule for every caller): the user typed it in the conversation (the
triggering message and the recent window `repeatWasAsked` reads), it is a
sender or recipient in their own mail, it is on a person they saved or a
family-plan entry, it is the account address of someone they share a chat
with, or their phone's Contacts returned it this turn (held per turn in
memory, since ADR 0212 stores nothing). Applied where a model-written
address is mailed, invited or saved:

- `compose_email` / `forward_email` (`to` and `cc`): refused before staging
  (`reason: "unknown_address"`, no card).
- `create_event` / `update_event` invitees (ADR 0157): the event is still
  created or updated; an address with no source is not invited and comes back
  as `unverifiedInvitees`.
- `add_family_member` (whose invite emails the address), `add_person` and
  `update_person`: refused, nothing saved. A saved address is itself a source
  for later sends, so saving one needs a source too.

No person behind the call (a confirmed card, ingest) means nothing is
checked: the check ran when the card was staged, or the address came from a
file or a feed. `reply_to_email` needs none, since its recipients are read
from the thread. Not covered: a guess that matches some real address in the
user's mail (a source, just the wrong one).
