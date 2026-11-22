# 0307 — A list you never open is mass mail, and Chord offers to leave it

**Status**: accepted
**Date**: 2026-10-29

## Context

A prod search of new users' failed requests (29 Oct) found one user's Action
Items filled with ~70 suggestions made from mass mail: USPS Informed Delivery
scans of postal junk mail, retail and bank promotions, college brochures. Part
of it came through emailed images (PR 202, ADR 0071 addendum); the rest came
through the email suggestion passes themselves, because the bulk gate (ADR
0127) skips a thread only when the `List-Unsubscribe` header AND the
classifier's bulk opinion agree, and for these the classifier was unsure.

The same user asked the bot to unsubscribe her from lists, and hit two chat
bugs: a typed address (`macys@e.macys.com`) did not match the address the list
really sends from (`no-reply@em.macys.com`), and asked again before tapping,
the bot staged a second card and said the requests were sent. Nothing had been
sent.

The owner asked for two things: process less mass mail, and help people
unsubscribe.

## Decision

**1. The user's own behaviour is the second bulk signal.** A sender the user
has had at least three emails from (`IGNORED_SENDER_MIN`), opened none of, and
never written to, is *ignored*. Its mail is skipped on ONE bulk signal (header
or classifier), not two. Everything that outranks the gate still does: mail
that asks something of the user (`to_do` / `reply_needed`), a sender in their
People, Events & invites. Mail with no bulk signal is never skipped by this
rule (a bank statement nobody opens is not a blast). It lives in both halves of
`bulk-gate.ts` (`isMinable` + `minablePredicate`, with `senderIgnoredSql`)
and the parity test covers it, so every pass that uses the gate gets it:
suggestions, people extraction, attachment import.

**2. Chord offers to leave a list the user never reads, once.** After each
sync, `email/unsubscribe-offers.ts` stages one ordinary
`unsubscribe_from_sender` card for an ignored list that offers one-click or
mailto, beside its newest email (`gmail:` provenance, so it shows in Action
Items and the reader). Nothing is sent until the user taps it; the result is
reported the ADR 0122 way. Once per sender, ever (`users.defaults`
`unsubscribe_offered`), and at most one new card a day. No AI call, so it runs
with the mailbox passes above the AI-consent and billing gates. The card's
stored `why` ("5 emails in the last 90 days, none opened") is hidden from the
model's tool schema.

**3. A Mailing lists screen.** Email folder sheet → Mailing lists
(`/email/lists`, `GET /api/v1/me/email/subscriptions`): every list from the
last 90 days, most email first, how many emails and how many opened, a "Never
opened" filter, and Unsubscribe per row through the existing per-thread route.
A list already asked to stop shows the date instead of a button; a link-only
list opens the sender's page and claims nothing. The chat already had
`list_subscriptions` + `unsubscribe_from_sender`; `list_subscriptions` rows
now carry `opened` too, so "which lists do I never read" is answerable in chat.

**3a. Several lists, one tap.** "Unsubscribe me from them" stages ONE
`unsubscribe_from_senders` card naming every list; the screen has the same
"Unsubscribe from all" (or "from all N never opened") button, and both call
`unsubscribeFromSenders` (`POST /me/email/subscriptions/unsubscribe`). It is
deliberately NOT a proposal bundle (ADR 0009): a bundle commits in one
transaction, all or nothing, and each unsubscribe is a request to an outside
sender that cannot be taken back, so a failure on one must not roll back (and
hide) the others that already went out. Lists run one at a time and each gets
its own line (one-click done / request sent / did not work / skipped). The bot
stages nothing if any named list cannot go on the card (no match, several,
web-page-only, already asked, a card already waiting) and says which, then
retries with the rest.

**4. The two chat bugs.** `resolveSubscriptionSender` matches a typed address
or domain by the name its domain is registered under (`macys` for both
`e.macys.com` and `em.macys.com`), and drops request words ("mailing list",
"emails") and address boilerplate before matching words. A still-pending
unsubscribe card for the same sender is returned as `awaiting_confirmation`
("NOTHING has been sent") instead of staging another; a sender already asked to
stop says so with the date.

## Alternatives considered

- **Skip all bulk mail on the header alone** — contradicts ADR 0109 ("a
  signal, never a verdict") and loses the transactional mass mail the passes
  exist for (flights, invoices). The user's own reading is the evidence the
  header lacks.
- **Count "ignored" from one or two unopened emails** — a new school, an
  airline flown once. Three is the smallest number that is a pattern.
- **Unsubscribe automatically from ignored lists** — decides on the user's
  behalf that a relationship is over (ADR 0122 rejected the same).
- **Offer every ignored list at once** — forty cards on the first sync is the
  flood this ADR exists to stop.
- **Offer link-only lists too** — the user would land on a web page from a
  "tap to unsubscribe" card; the screen offers them, the card does not.

## Consequences

- Fewer suggestions, people facts and imported attachments from mass mail a
  user never reads; anything the email asks of them is still mined.
- Opening one email from a list makes it "read" again, for both the gate and
  the offer. Marking everything read in another mail app does the same.
- An Outlook-only list is under-counted (its header arrives only once a thread
  is opened, ADR 0122), so it is offered later or not at all.
- Proposals in general are still not deduplicated when the bot is asked
  twice; only unsubscribe is, because it is the one that claimed a send.

## Addendum 2026-10-30: a card holds what it can, and a brand is one list

Prod: a user asked to leave twelve lists at once and nothing was sent. The
Findings chat handed the request over with invented `name@example.com`
addresses; every one matched nothing, and the several-lists card was
all-or-nothing, so even a list that could have gone was held back. Replayed
with her real names, nine matched and three (Macy's, Amtrak, Dr. Squatch)
came back as "several lists match" because each brand mails from more than
one address.

- **The card holds every list that can go on it.** Lists that cannot (no
  match, several brands, web page only, already asked, a card already
  waiting) come back beside the card as `notOnCard` and the bot names them in
  the same reply. Only when none can is nothing staged (`needs_attention`).
  `trash_future_mail` follows the same rule. This reverses "stages nothing if
  any named list cannot go on the card" above.
- **A brand is one list.** Matches that all share a registered domain name are
  one list (`senders` on the match), and every address of it that can be left
  goes on the card; an address of it with only a web page does not block the
  others. Never grouped: a free-mail domain, or a platform many unrelated
  senders share (Substack, Mailchimp, Beehiiv ...). `unsubscribe_from_sender`
  on such a brand stages the several-lists card. An address typed exactly
  stays exactly that address.
- **A wrong domain does not veto the name.** A typed address that matches
  nothing is matched by its local part, compared with the sender's words with
  and without spaces (`houzzpartners@...` finds "Houzz Partners").
- **A pending several-lists card counts as waiting** for every address on it,
  so asking again does not make a second card.
- The Findings hand-off now refuses a request naming an address the user
  neither typed nor has in their mail (ADR 0277 addendum).
