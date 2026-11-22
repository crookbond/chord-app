# 0246 — Mail questions are counted on the server and answered by recipe

**Status**: accepted
**Date**: 2026-10-13

## Context

The owner asked what chat could answer from the mail Chord already mirrors:
which mailing lists am I on, find a receipt, what did I spend, who emails me
most and least, what am I paying for every month, any coupons for a store.

Two ways to build that were on the table.

- **One narrow tool per question.** Predictable, and it adds a tool
  description to every prompt for each new question.
- **Skills only**: a recipe telling the model to walk `search` and
  `read_email` step by step. No new code, and it fails on exactly the
  questions asked. `search` returns at most 25 hits a call, so "who emails me
  most" or "what did I spend in September" means dozens of calls, each billed
  against the user's token allowance (ADR 0196), with the model adding the
  numbers itself. A missed page gives a confident wrong total, which is the
  ADR 0102 failure. It also sends every email through the model to produce a
  number, where the server can send only the number. Receipts are sealed at
  rest (ADR 0201) for that reason.

What the data supports, checked before designing:

- `from_email`, `to_emails`, `list_unsubscribe`, `action`, `bulk` and
  `category_id` are readable in SQL. `from_name`, `subject` and `receipt_json`
  are sealed, so they can only be grouped after the read plugin opens them.
- Receipts have been stored since ADR 0160 and nothing has ever read them back
  except one tile. The Finance tab (ADR 0070) was a placeholder.
- Unsubscribe (ADR 0122) had no bot tool, against this repo's rule that every
  capability is sayable in chat.
- Coupons already work: ADR 0152 turns the word into the `Coupons` category
  and ADR 0126 ANDs `from:` on top.
- There is no address data anywhere (`people` has none; the phone-contact
  lookup of ADR 0212 carries name, emails, phones, birthday), so "contacts by
  city" was dropped.

## Decision

**The server counts; a recipe says which count answers which question.**

Two general read-only tools, both personal-chat only:

- `query_mail_senders { rank, sinceDays?, quietDays?, includeBulk?, limit? }`
  (`email/sender-stats.service.ts`). `rank` is `received`, `written_to`
  (sent mail's To line), `awaiting_reply` (threads with
  `action = 'reply_needed'`, longest wait first) or `gone_quiet` (five or more
  messages, then silence). Mass mail is left out unless asked for, by either
  bulk signal (ADR 0109/0110) or the header itself. Rows carry `inPeople`, so
  the bot can offer `add_person` (ADR 0076) for a frequent correspondent.
- `query_receipts { merchant?, after?, before?, groupBy?, recurring?, limit? }`
  (`email/receipts.service.ts`). Rows are read, opened and worked in memory
  under a 2,000-row cap.
  - One purchase is counted once: a later email with the same order number, or
    the same amount at the same shop on the same day, is dropped. An order
    confirmation and its shipping notice would otherwise double a total.
  - Totals are per currency. A receipt that named no currency is
    `unspecified` and is never merged with a real one.
  - `recurring` returns charges from one merchant that repeated at an even
    spacing (weekly, monthly, quarterly, yearly) at least three times, for
    about the same amount, and have not stopped.
  - Date bounds are the user's days (`zonedDayStartUtc`).

**"Who emails me least" has no tool.** The literal answer is thousands of
one-off senders. The recipe maps it to `gone_quiet` and tells the model to say
so.

**Mailing lists keep their own pair of tools**, because one of them acts:

- `list_subscriptions`: senders whose mail carries `List-Unsubscribe`.
- `unsubscribe_from_sender { sender }`: the sender as the user said it. No
  match or several come back as candidates (ADR 0077/0094 shape). It is
  proposable, since confirming POSTs to the sender or mails them from the
  user's mailbox, and the address on the card is the one acted on. A sender
  that only offers a web page gets a link card and no confirm step: a tap
  there would do nothing. The result keeps ADR 0122's three outcomes apart.

**Recipes** live in one block, `MAIL_QUESTION_RECIPES` (`bot/tools.ts`),
appended to the system prompt on personal turns only. Each line maps a kind of
question to a call, including the coupon query
(`coupons from:<store> newer_than:30d`). A new kind of question is a new line
there, not a new tool.

**Finance tab**: `GET /me/email/receipts` returns the same receipts, month
totals and repeating charges (`receiptsOverview`), and the tab renders them
with each row opening its email.

## Coverage, stated everywhere

A receipt exists only when the purchase produced an email, the suggestion pass
read that email after ADR 0160 shipped, and the thread passed the mining gates
(ADR 0127/0143). Each thread is read once. So every total is "from the
receipts Chord has": the tool result carries that sentence, the tool
description forbids calling it total spending, and the Finance tab prints it
above the numbers. Sender counts cover the mirrored window, not the mailbox's
history. Mailing lists that reach only an Outlook mailbox are under-counted,
because Graph supplies the header only once a thread is opened (ADR 0122).

## ADR 0149

- Receipts and repeating charges fill the Finance tab and produce a "review
  before renewal" to-do: shared family artifacts.
- Sender stats feed `add_person` and a list of people waiting on a reply.
- Coupons need no new code.
- Mailing lists produce no family artifact. They are admitted as the missing
  chat half of a shipped capability, not as new mail-client surface.

## Consequences

- Three evenly spaced charges are needed before a subscription shows, so one
  billed yearly will not appear for years, and a new monthly one not for two
  months. The tool says the list may be incomplete.
- Month totals use the user's current UTC offset for every month, so a
  purchase within an hour of midnight on the first can land in the neighbouring
  month across a daylight-saving change.
- Coupon answers list emails. Codes and expiry dates are not extracted,
  because ADR 0179 keeps the suggestion pass off `Coupons` on purpose.
- No migration, no new AI pass, no new env keys.

## Rejected

- **Skills only, no new tools.** See Context.
- **One tool per question.** Five tools where two answer the same questions
  and the next question needs none.
- **A `load_skill` tool fetching recipes on demand.** The right shape once
  there are many recipes; today it is one short block, and building the
  mechanism is its own change.
- **Extracting coupon codes and expiry.** A new AI pass over marketing mail,
  against ADR 0127.
- **Contacts by city** from email signatures. Costly and often wrong, with no
  family artifact.
- **Summing across currencies** at a fixed rate. A made-up number.
- **Two charges as a subscription.** Two purchases at one shop a month apart
  are ordinary.

## Addendum 2026-11-05: a list already left is not the next one to leave

**Problem.** The user unsubscribed, then asked again "who should I
unsubscribe from" or "who emails me most" and got the same lists back.
`listSubscriptions` ranked senders by their last 90 days of mail and only
then marked the ones already asked (`requestedAt`). So a list just left kept
its place in the top 30 and the next list never moved up. `senderStats`
(`received`, `includeBulk`) counted the same old mail.

**Rule (`email/left-lists.ts`).** A sender the user asked to stop is counted
only by mail sent more than `UNSUBSCRIBE_GRACE_DAYS` (2) after the request.
Two days is the window Gmail and Yahoo give bulk senders to act on an
unsubscribe. This filter runs in SQL before the limit. A list that stopped
counts zero and drops out, and the next list moves up. A list that kept
mailing stays in, with only that later mail counted, marked
`stillMailing: true` (`list_subscriptions`) or `unsubscribedAt`
(`query_mail_senders`). The bot then says it ignored the request and offers
`trash_future_mail` instead of a second unsubscribe. Lists whose mail
already goes to Trash (ADR 0308) are left out. `gone_quiet` leaves out
senders the user left: they went quiet because the user asked.

**Where it applies.** `listSubscriptions` has `left: 'keep' | 'drop'`.
Suggestions use `drop`: the `list_subscriptions` tool and the daily
unsubscribe offer (ADR 0307). The Mailing lists screen and the sender
matcher keep the default `keep`. The screen still shows a left list, marked
as asked. The matcher still needs it to answer "already asked" when the user
names it. `senderStats` always applies the rule.

**Rejected.** Filtering left lists out after the query: that only shortens
the answer, the next lists never move up, and it hides the lists that ignored
the request. Leaving it to the model to remember what it already said:
answers are rebuilt from a fresh call every time.
