# 0306 — Reply all to a calendar event opens the composer

Status: accepted, 2026-10-28

## Context

An event with guests had no way to write to them. Opening it in the
calendar showed the guest list (ADR 0157 addendum, read from the provider
per ADR 0295) but writing to everyone meant copying addresses into a new
message by hand, and chat had no tool that knew who was on an event.

## Decision

- **A route, not a send.** "Reply all" opens the existing composer
  (`/email/compose?to=…&subject=…`) addressed to everyone on the event, the
  event's title as subject. The user writes, picks the From line and sends
  as with any new message (ADR 0107, 0113, 0115). Nothing new can send mail.
- **Who "everyone" is** — one kernel rule, `eventReplyAllRecipients`
  (`kernel/src/event-reply-all.ts`): the organizer first, then each guest,
  lowercased, each once, never the writer. The organizer now comes back on
  `GET /api/v1/events/:id/guests` as `organizer` (null when it is the
  calendar's owner), read from the provider event: Google `organizer.email`,
  Outlook `organizer.emailAddress.address` (now mapped).
- **App:** the event sheet (tap, or double-click on web) shows
  `✉ Reply all (N)` under Guests when anyone else is on the event; it closes
  the sheet and opens the composer. The composer reads `to` / `subject` only
  for a new message, never over a resumed draft.
- **Chat:** read-only, personal-only `email_event_guests { eventId?,
  titleContains?, date? }` returns `recipients` and an `email` card whose
  `href` is the same composer route. When the user dictated what to say,
  the bot calls `compose_email` with those recipients instead (still a card
  the user taps to send, ADR 0214). Several matching events = `candidates`,
  ask which; none on it = say so, never invent an address. Resolves the
  asker's own copies only.

## Consequences

- On WhatsApp/Telegram the card's in-app link does nothing; the bot can
  still draft with `compose_email`.
- An event only in Chord (not on a connected calendar) has no guests, so no
  button and an empty answer.
- Not built: a dedicated double-click gesture that skips the sheet.

## Rejected

- Sending from the event sheet directly (a second send path beside the
  composer's undo/outbox).
- A proposable "email the guests" tool (the composer already is the
  confirmation step; `compose_email` covers the dictated case).
