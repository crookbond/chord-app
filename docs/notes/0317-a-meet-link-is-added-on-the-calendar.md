# 0317 — A Meet link is added on the calendar, and a bare address finishes a pending invite

Status: accepted (2026-11-02)

## Context

Prod, 2026-11-02: "Call with Karl" was created, the bot asked for Karl's
email with an "Add Karl from Contacts" card, the user replied with just
`Karl@media.example`, and nothing happened: Karl was never invited. The user
then asked for a Google Meet link, which Chord could not add at all.

**Invite.** ADR 0166 records who is still waiting on an address and repeats
it in the prompt every turn, telling the model to call `update_event` when a
message supplies one. Nothing checked that it did. The STRICT-mode retry in
`bot.service.ts` fires only on an imperative ("add…", "invite…"); a bare
address has no verb, so a prose reply ("Thanks, I'll use that") ended the
turn with the invite unsent. The same shape as ADR 0100/0102: a prompt
instruction alone is not enough. (Prod logs could not be read when this was
written; the cause is traced from the code.)

**Meet.** Chord never wrote `conferenceData`, and Google drops it from a
request unless `conferenceDataVersion=1` is on the URL.

## Decision

1. **A message carrying an address for a pending invitee gets the retry.**
   `pendingInviteRetryInstruction` (`bot/pending-invites.ts`): when the
   triggering message holds an email address and invitees are waiting in this
   chat for this user, and the turn wrote nothing (only read-only tools, so a
   retry cannot repeat a write), the turn is re-run once with a STRICT
   instruction naming each waiting event by id. Several waiting people and no
   name in the message = the model asks whose it is. Nothing is resolved in
   code: which person an address belongs to stays the model's call, as ADR
   0166 decided.
2. **Google Meet is added on the provider event.** `addVideoCall`
   (`events/guests.service.ts`, beside the guest change it mirrors, ADR 0295):
   organizer only, waits for the event to reach the calendar, patches
   `conferenceData.createRequest` (`hangoutsMeet`) with
   `conferenceDataVersion=1` (new `conference` option on the transport's
   `patch`), tells guests when there are any, and returns the link (or
   `already` when the event had one). Refusals are results, never throws:
   `not_organizer`, `not_on_calendar`, `not_google`, `provider_error`; the bot
   note says NO link was added and why. Stored nowhere in Chord: the link
   lives on the Google event, like guests.
3. **Same capability in chat and app.** `videoCall: true` on `create_event`
   and `update_event` (an invitees-free, field-free `update_event` with
   `videoCall` is a valid change); `POST /api/v1/events/:id/video-call`; an
   "Add Google Meet" button under Guests in the event editor, showing the
   link once added.

## Consequences

- Outlook calendars are refused (`not_google`): Graph's online meetings need
  Teams, which a personal Microsoft account lacks. Revisit if work Outlook
  calendars ask for it.
- The editor does not show a Meet link the event already had before it was
  opened (the guests read does not return it); tapping the button reports it.
- A later push never removes the link: the push does not send
  `conferenceData`, and a Google patch keeps fields it does not carry.

## Rejected

- Matching the address to the waiting name in code (ADR 0166 rejected it:
  several waiting people, and an address is not always an answer).
- Retrying on every turn with an address (only when someone is waiting).
- Storing a `wants_meet` flag and adding it at push (a second source for
  something the calendar already holds).
