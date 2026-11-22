# 0308 — A list Chord cannot leave is the user's to finish, or its mail goes to Trash

**Status**: accepted
**Date**: 2026-10-29

## Context

ADR 0307 made "unsubscribe me from them" one card and one tap, with a result
per list. Some results are not "done": the sender's one-click endpoint refused
the request, the list only offers a web page, or the list was already asked and
keeps mailing (ADR 0122's honest outcomes). The bot reported these and stopped,
so the user was left with a list they still could not get off. The owner asked
that the user be told it needs a click on the sender's side, and be given two
ways out: an action card that opens the sender's page in the browser, or Chord
sending that sender's future mail to Trash and honouring it.

## Decision

**1. Say it, and hand over the page.** A result where nothing was done (not
unsubscribed, no request sent) carries `needsYou`. A one-click that failed now
returns the email's own unsubscribe address as `url`, the same link the email
shows, which in a browser usually lands on the sender's page. In chat, every
`needsYou` list with a page gets an "Unsubscribe" link card (`cards`), and the
bot is told to say plainly that Chord could not finish it on its own and to
offer both ways out. On the Mailing lists screen the row says the same and shows
"Open their page" (a link-only list still opens its page on the first tap, as
before; a failed one-click waits for the button rather than opening a page the
user did not ask for).

**2. "Send future mail to Trash" is a standing rule.** `users.defaults` key
`email_auto_trash` holds `{ sender, since }`; `email/auto-trash.service.ts`
moves mail from a ruled sender that arrived AFTER `since` to Trash, through the
ordinary Trash write (ADR 0215: Trash, never permanent delete, every mailbox
type). It runs after each sync with the other mailbox passes, above the AI
consent and billing gates (no AI call), at most 25 threads a pass. Mail already
there is left alone: the user asked for "from now on". Turning a rule on twice
keeps the first `since`, so a repeat cannot skip mail.

**3. The same rule from chat and the screen.** Chat: proposable
`trash_future_mail { senders }` (one card naming the senders; a sender that is
neither a list the user is on nor an exact address they have mail from stages
nothing and is named back) and `stop_trashing_mail { senders }` (immediate,
harmless). Screen: "Send future mail to Trash" (with a confirm) on a list that
needs the user, is link-only, or was already asked; a ruled list shows "New mail
from this sender goes to Trash · Stop". Both go through `setAutoTrash`
(`POST /me/email/subscriptions/auto-trash`). `list_subscriptions` rows and
unsubscribe results carry `autoTrash`.

## Alternatives considered

- **A provider-side filter** (Gmail filter, Outlook rule): needs a broader
  settings scope and a re-consent for every user, and IMAP has no common
  equivalent. ADR 0124 rejected the same for the vacation responder.
- **Trashing the existing mail too**: not what was asked, and a whole mailbox of
  a sender moved at once is a surprise that is hard to review.
- **Permanent delete**: not recoverable, and needs the full-mail scope (ADR 0215).
- **Opening every failed list's page at once** after "Unsubscribe from all": a
  browser tab per list nobody asked to open; each row gets its own button.

## Consequences

- Rules apply only while Chord syncs; if Chord is not syncing, the mail stays in
  the inbox until it is.
- Moving mail is a write to the user's mailbox, an owner exception to ADR 0149's
  freeze in the same family as ADR 0215's swipe to Trash.
- A sender whose mail switches address is not caught; the rule is per address.
