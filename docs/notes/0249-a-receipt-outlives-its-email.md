# 0249 — A receipt outlives its email, and Findings asks about your mail

**Status**: accepted
**Date**: 2026-10-15

## Context

Two things came up together.

**Receipts disappeared with their email.** The owner read a receipt and then
deleted the email, which is ordinary inbox cleanup. The purchase then dropped
out of every total. ADR 0160 stored the receipt on the thread row
(`email_threads.receipt_json`), and ADR 0246's totals read it from there,
skipping trashed threads. A deleted email has no thread row at all
(ADR 0073's reverse-delete, ADR 0224's reaper). So "what did I spend at X"
depended on whether the user had tidied their inbox.

**The mail-question skills had no place in the app.** ADR 0246 made "which
mailing lists am I on", "who am I not answering" and "what am I paying for
monthly" answerable in chat, but nothing showed that they could be asked. The
Finance tab built for it was hidden (ADR 0070's scaffold flag).

## Decision

### 1. A receipt is kept apart from its email

- **Where it is kept.** A new table, `email_receipts` (migration `105`), holds
  one row per provider thread (`user_id`, `gmail_thread_id`). The suggestion
  pass writes it whenever it reads a receipt (`keepReceipt`, called from
  `recordReceipt`), beside the thread's own column, which the Ledger tile
  still reads.
- **Keyed by the provider thread id, not `email_threads.id`.** The thread row
  is deleted when the mail is, and a copy keyed to it would go with it.
- **What a receipt holds:**
  - the total, the vendor, the order number and the purchase date;
  - **how it was paid**, as card type and last four digits, or a wallet:
    "Visa ••4242", "PayPal", "Apple Pay";
  - **which mailbox** it came to: `account_id` (null = the primary Gmail,
    ADR 0080) and the mailbox address at the time. `account_id` is not a
    foreign key, so the receipt also outlives a removed mailbox.
- **Never a full card number.** The prompt asks only for card type and last
  four. `normalizePaymentMethod` enforces it in code: of any run of digits,
  only the last four are kept, whatever the model returned. The payment
  method lives inside the sealed `receipt_json` (ADR 0201), and `from_name` is
  sealed too. The encryption backfill and its plaintext count cover the new
  table.
- **What reads it.** Totals and the Findings list read `email_receipts`, with
  the thread left-joined only for a link. A trashed or deleted email's
  receipt still counts; its `threadId` is null, so its row opens nothing and
  says "email deleted". The bot's receipt cards drop the link in the same
  case.
- **Existing receipts.** `copyThreadReceipts` (extracted so it can be tested)
  copies every receipt already on a thread, idempotently. Values are copied as
  stored, since a sealed value opens by its own embedded context.

### 2. When a kept receipt is deleted

- **Three years after the email's date** (`RETENTION_RECEIPT_DAYS`, default
  1095, ADR 0226's daily prune; 0 = keep forever). A yearly charge needs three
  payments before it counts as repeating, so a shorter window would hide
  yearly subscriptions.
- **At once when the account is deleted**: foreign-key cascade from `users`,
  plus ADR 0201's key destruction.

### 3. Finance comes back as Findings

The hidden tab is shown again and renamed **Findings** (💡; a magnifier
read as search). Its key stays `finance`, so existing links resolve (ADR
0070's posture).

- **It opens with "Ask about your mail"**: tappable questions, each one
  covered by an ADR 0246 recipe.
  - General: what am I paying for every month, which mailing lists am I on,
    who emails me the most, who needs a reply.
  - Per shop, for the user's three most frequent shops: how many orders from
    that shop last month.
  - Nothing that needs the user's whole financial history ("what did I spend
    last month"): Chord only sees receipts that came by email, so that
    question would read as a total it cannot give.
  - The list is `findingsQuestions`/`topShops` in kernel, so it is tested.
- **What a tap does.** It posts the question to the personal chat as if typed
  and opens that chat. The answer comes from the same tools a typed question
  uses, so there is no second answering path.
- **Below the questions**: the existing repeating charges, monthly totals and
  receipts, each row now naming the card, the mailbox and whether the email is
  gone. The note says receipts stay after the email is deleted.

**Chat**: `query_receipts` rows carry `paidWith` and `mailbox` ("which card did
I use at Amazon", "what came to my work email"). The tool description says a
receipt still counts after its email was deleted.

## Verified

- **The reported case** (`receipts-kept.integration.test.ts`): a receipt read
  by the real pass stays in the totals after its email is trashed and then
  deleted, keeping its card and mailbox.
  - With the old rule put back (counted only while the thread exists and is
    not trashed), the test fails at the trash step with the reported symptom.
- **The other new tests**:
  - a secondary mailbox's receipt names that mailbox;
  - the copy of existing receipts is idempotent;
  - retention removes a receipt dated 1,100 days ago and keeps a new one, and
    account deletion removes it;
  - `normalizePaymentMethod` keeps card type plus last four in every shape
    tried, including a whole number returned by the model;
  - the Findings questions.
- **One existing test flipped**: `mail-queries` expected a trashed receipt to
  be skipped and now expects it counted. Its helper writes through
  `keepReceipt`, the real write path.

## Not in scope

- Deleting one saved receipt by hand.
- Delivery and flight facts (ADR 0135/0138). These describe the email and
  rightly go with it: a deleted shipping email should not keep a delivery
  tile. They are the same pattern, checked and left as they are on purpose.
- Coupon codes (still ADR 0179's line).

## Rejected

- **Counting trashed threads in the old read.** This fixes trash but not
  deletion, and Gmail empties Trash after 30 days anyway.
- **Never deleting the thread row while it holds a receipt.** That turns one
  fact into a reason to keep a whole email the user deleted.
- **Storing the full card number, or the payment text as the model wrote
  it.** No question needs more than the last four.
- **A separate Findings answer screen.** It would be a second answering path
  beside chat, which already answers these questions.
