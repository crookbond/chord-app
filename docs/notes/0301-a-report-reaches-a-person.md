# 0301 — A report reaches a person

**Status**: accepted
**Date**: 2026-10-25
**Builds on**: ADR 0298 (block)

## Context

App Store guideline 1.2 asks an app where users post to each other for
four things: filtering, a way to **report** offensive content with timely
responses, a way to block abusive users, and published contact
information. ADR 0298 built the block. Reporting was left out because it
needs somewhere for a report to go.

Most of what Chord shows a user is not "posted by another user": their
own mailbox (written by outsiders, shown only to them), the bot's replies,
their own notes. None of that is reported. What another member puts in
front of you in a shared chat is: a message, or a file posted as a
message.

Nothing in the server could email anyone. Mail goes out only through a
user's own connected mailbox, which is the wrong sender for a report.

## Decision

**A report is a saved row plus an email to the support address.**

- `content_reports` (migration `130`): reporter, group, message, the
  person reported, the message text and attachment file name as they were
  when reported, an optional reason, and email bookkeeping. One report per
  person per message (unique index); reporting again answers "already
  reported" and creates nothing.
- **What can be reported**: a visible message in a shared chat (not the
  personal chat), posted by another member (not the bot, not yourself),
  that the reporter can see. A file counts because it is posted as a
  message. The message must be in a chat the reporter belongs to; anything
  else answers `not_found`, so ids cannot be probed.
- **The email**: sent to `REPORTS_EMAIL_TO` (default `hello@chordapp.ai`)
  over `REPORTS_SMTP_URL` (nodemailer, already a dependency for IMAP
  accounts). It names the reporter, the person reported, the chat, the
  message id and time, the text (capped at 2,000 characters), the file
  name, and the reason. The file itself is not attached.
- **Sending never blocks the report.** The row is saved first. Sending
  runs in the background; a failure leaves `emailed_at` empty and the
  proactive tick retries (at most 8 tries, 10 minutes apart, for 3 days).
  With `REPORTS_SMTP_URL` unset nothing is sent and every report is logged
  at `warn`, so a deploy without mail still keeps every report.
- **Surfaces**: the chat's long-press / name-tap sheet gains **Report
  message** beside Copy and Block. A second sheet asks what is wrong
  (harassment, hate or violence, sexual content, spam or scam, something
  else; the choice is the reason), then it confirms and offers **Block
  <name>** next (the usual next step, and one tap). The same sheets on iOS,
  Android and web; a list rather than a text box because the app has no
  text prompt that works on all three. Chat: `report_message`
  (personal 1:1 only, like the block tools) reports the newest message from
  a named person in a named shared chat; its candidates are
  exact-name-or-ask (ADR 0077/0094).
- The reported person is not told. Nothing is hidden automatically; the
  reporter can block.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `REPORTS_EMAIL_TO` | `hello@chordapp.ai` | Where reports are emailed |
| `REPORTS_SMTP_URL` | empty | An SMTP account that can send, e.g. `smtps://reports%40chordapp.ai:APP_PASSWORD@smtp.gmail.com:465` (user and password URL-encoded). Empty = save and log only |
| `REPORTS_EMAIL_FROM` | the SMTP user | The From address |

These are not yet in `example.env`: changing that file makes CI run the
whole suite (ADR 0265), so they are added with the next change that runs
it anyway.

## What is not covered

- **Acting on a report.** Apple's rejection notes usually ask for action
  within 24 hours (remove the content, remove the person). There is no
  admin screen; the owner acts by hand from the email. Removing someone
  from a group today means the group owner removes them, or the person is
  deleted.
- **Filtering.** The remaining 1.2 item. The chats are invite-only, Block
  hides a person, and Report reaches the owner; whether that is enough is
  Apple's call.
- Messages already forwarded to WhatsApp or Telegram (ADR 0055) are
  reported there, not here.
- Bot replies, email, a user's own notes.

## Consequences

- A report sends a copy of a private chat message to the owner. The
  reporter chooses to send it; the privacy policy says reports are sent to
  Chord.
- `REPORTS_SMTP_URL` holds a password. When it is set in production it
  goes to Secret Manager and `secret-keys.txt` together (ADR 0211); adding
  the name to `secret-keys.txt` before the secret exists stops the service.

## Rejected

- **Sending from the reporter's own mailbox.** Their address, in their
  Sent folder, and nothing at all for a reporter with no mailbox connected.
- **Email only, no row.** A failed send would lose the report.
- **Hiding the reported message automatically.** The reporter may want it
  as evidence; Block is one tap away.
- **Attaching the file.** It may be the offensive thing itself; the owner
  can find it by id.
- **Reporting bot replies.** Not user-generated content; a different
  feedback channel if wanted.
