# 0137 — A proactive message is not always the briefing, and a mailbox is not the user

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes / amends:** narrows ADR 0089/0091 (which message may spend the
  WhatsApp template ask), amends ADR 0054 (which push category is quiet-hours
  exempt), extends ADR 0100 (the past-event guard now covers email proposals),
  completes ADR 0106 (id scoping fixed cross-user collisions, not same-user
  ones)

## Context

A prod user reported five things in one morning. Four of them turned out to be
two bugs, and the two bugs are the same shape: **a flag was being read as an
answer to a question it does not ask.**

### What she saw

- A briefing arrived on WhatsApp at **9pm**, not at her 07:00 nudge time.
- WhatsApp "suddenly" started carrying bot messages that evening.
- Confirming email suggestions created calendar events **in the past** — a gym
  class from four weeks earlier, and one from that morning.
- A Google security alert was asking her for a response.

She had connected a second mailbox (Yahoo, over IMAP) at 8:25pm. Thirty days of
settled mail were mined in three minutes.

### What actually happened

**The 9pm briefing.** Each confirmed email suggestion enqueued an
`event_created_nudge`. One fired at 21:02 and reached the WhatsApp publisher,
which asked `gateProactiveSend` how to deliver it. Her last inbound message was
27 hours old, so the 24-hour session window was shut — and the gate's answer for
a shut window is *send the approved template*. That template is the briefing's:
it opens `Good morning! Want your daily briefing?`, carries the day's weather
and calendar (ADR 0091), and parks the message behind a `Full briefing` button.
So she received a good-morning briefing at 9pm, and the thing parked behind the
button was a calendar-conflict warning.

The gate was keyed on `messages.is_proactive` — a boolean meaning *Chord started
this*. Six different things set it: the daily briefing, the email digest, a task
reminder, an event-created echo, and the two reconnect warnings. Only the first
is the briefing.

**The WhatsApp burst.** Everything else the bot said that evening was mirrored
free-form and **silently discarded**. Meta accepts an out-of-window send, returns
a `wamid`, and fails it asynchronously; ADR 0090 ignores `statuses` receipts, so
nothing logged. Seven of her eight WhatsApp messages never arrived. The one that
did was the template.

**The past events.** ADR 0100 refuses a `create_event` whose start has already
passed — but only `if (input.turnId)`, deliberately, so ICS import and the
Google pull can file history. A proposal confirm carries no `turnId`. Staging
had no past-date check at all, so a month-old booking confirmation became a card,
and confirming it wrote the event.

**The Google alert.** Working as designed: `no-reply@accounts.google.com`
carries no `List-Unsubscribe`, so ADR 0109/0127's bulk gate reads 0 on both
signals and cannot skip it, and `action = to_do` is an explicit override of that
gate anyway. Left alone here; noted so the next reader does not re-derive it.

### Then a second report, with the same shape underneath

*"Why does John have two bullets for income confirmation after processing one
Amex email?"* Two `create_task` proposals, same thread provenance, **2.26
seconds apart**:

- `Confirm income information with American Express`
- `Confirm income information for American Express credit card`

The prod logs show the whole AI pipeline running two and three times per tick
per user — two classifier passes, two attachment imports, two magics passes,
identical inputs. The cause is one line repeated in four files:

```ts
await afterSync(db, account.user_id);   // gmail-account, imap, outlook, gmail ×2
```

`afterSync` reads *everything of this user's that is unclassified or unmined*.
It is user-scoped work triggered from an account-scoped callback, so a user with
two mailboxes ran the whole pipeline twice and one with three ran it three
times. That is N× the LLM spend, and when two overlapped it also produced:

- `duplicate key value violates unique constraint "email_categories_pkey"` and
  `deadlock detected` inside `ingestClassification` — two snapshot-replaces
  racing. ADR 0106 scoped category ids **per user**, which stopped different
  users colliding; it never claimed anything about one user ingesting twice at
  once. Three prod mailboxes were unclassified all day.
- Four IMAP logins to one Yahoo account inside 1.3s, and Yahoo throttles on
  **login rate** (ADR 0080). The fifth returned
  `[LIMIT] AUTHENTICATE Rate limit hit`, which escaped a route handler as a 500
  `unhandled error` — Chord blamed for someone else's throttle.
- The same thread mined by both passes, each asking the model independently and
  getting a slightly different phrasing. `shouldStageTaskProposal` compares
  exact normalized titles (ADR 0132's rule, deliberately exact), so a rephrase
  is not a duplicate.

## Decision

### 1. Record which proactive message it is

Migration `060` adds nullable `messages.proactive_kind`, and
`isScheduledBriefing()` (in `db/schema.ts`, at the column, reachable by every
writer) answers the question both publishers were guessing at: **does this
message arrive at a moment the USER chose?**

- Yes — `daily_morning_scan`, `email_digest` (rides the morning scan),
  `task_remind` (they named that moment when they set it).
- No — `event_created_nudge`, `calendar_reconnect`, `gmail_reconnect`.

`gateProactiveSend` takes `isBriefing`. Out of window, a non-briefing proactive
message now **skips** (`reason: 'window_closed'`, logged with its kind) instead
of borrowing the ask. The ask is a billed business-initiated conversation on a
weekly cadence (ADR 0089 §6), and spending it on an echo takes it from the
briefing it belongs to — the skip deliberately leaves `nudge_prompt_sent_at`
untouched so the morning can still use it.

The push categoriser had the identical defect: `is_proactive ? 'briefing' :
'bot'`, and `briefing` is the one category exempt from quiet hours *because it
fires at the user's own nudge schedule*. An event echo does not, and was waking
people at 3am on a technicality.

The column is **optional** and **not backfilled**. Historical rows are never
re-published, and an unknown kind must resolve to *not the briefing* — resolving
it the other way is precisely what this change undoes.

### 2. A past date is not staged, and does not linger

`shouldStageEventProposal` refuses a `startsAt` the user has already lived
through. Unlike a bot turn (ADR 0100) there is nobody to ask, and unlike a typo
there is nothing ambiguous — the date is over, so the answer is silence, not a
card. `retractPastEventProposals` sweeps per pass, covering both proposals
staged before this existed and a card that outlives its own date.

`isPastEventStart` moves from `bot/executor.ts` to `utils/tz.ts`: ADR 0100 asks
it of a turn and this ADR of a proposal, and two copies of one predicate is how
ADR 0085's promise stopped being true once already.

The confirm path keeps its `turnId` exemption. Nothing past reaches it from
email now, and ICS import, the Google pull and invite confirm still need to file
history.

### 3. The AI pipeline runs once per user, not once per mailbox

This needed **two** mechanisms, because the pipeline was called too often in two
unrelated ways — and the first fix caught only one of them.

**Sequential** is the common case and the expensive one. `maybeSyncAccounts` and
`syncAllAccounts` walk mailboxes with `for … await`, and each mailbox's sync
ends by awaiting `afterSync`. Mailbox 1's pipeline therefore *completes* before
mailbox 2 begins: nothing overlaps, so a coalescer never fires. Three mailboxes
meant three full pipelines back to back, which the prod timestamps show plainly
(0.9s apart, not concurrent). `withMailSyncRound(db, userId, fn)` collapses
these: `afterSync` inside an open round records that there was work and returns,
and the round runs exactly one pass when it closes.

**Concurrent** is the rarer case and the corrupting one: two *rounds*
overlapping — a route-triggered sync racing the scheduler tick. That is what put
two `ingestClassification` snapshot-replaces in flight at once. The per-user
coalescer in `afterSync` handles it, and `syncAccount` coalesces per **account
id** (not per user: two mailboxes are different servers and may legitimately
sync at once).

**Scoping the round, rather than moving the call**, is the deliberate part. The
obvious fix — strip `afterSync` from the five providers and add it at each of
the ~10 entry points — is ten chances to forget, forever. Here the providers are
untouched, and an entry point that forgets to open a round degrades to today's
behaviour rather than to silence, which is the safe direction to fail.

**Collapsing must not cost freshness**, and getting this wrong is what a test
caught: the first attempt handed a mid-run caller the in-flight run's *result*,
and that run may have read the mailbox before the caller's mail landed. A
caller means "as of now". So an arriver does not join the run in flight — it
joins the single **follow-up** run queued behind it, and everyone arriving
during a pass shares the one that follows. Two syncs however many pile up,
which is the point (four became one login-storm), and no caller is answered
with a snapshot older than their own call.

The briefing is the one round that must **close early**: `buildEmailDigestBody`
reads what the pipeline produces, so the round wraps only the two sync calls and
flushes before the section renders.

### 4. Guards that hold whatever the cause

- `ingestClassification` takes `pg_advisory_xact_lock(ns, hashtext(userId))` as
  its first statement. The coalescer fixes the waste; this fixes the invariant,
  and it survives a second process. `_xact_` because it is the only advisory
  form that survives transaction-mode pooling — the same constraint that made
  ADR 0038 ban `LISTEN`/`NOTIFY`.
- `threadAlreadyProposed` — the extractor returns at most one suggestion per
  thread, so a second pending proposal of the same tool from the same thread is
  a duplicate by construction. This is what actually catches a rephrase.
- `isTransientProviderFailure` gives routes a **positive** test (`isAuthFailure`
  returning false also covers every ordinary bug), and `handleGmailError`
  answers **503 + `retryable`** rather than a 500 that reads as a Chord bug.
- `stripNulls` at both extraction boundaries. Postgres `text` cannot hold
  U+0000, and PDF text layers emit them routinely — five prod receipts and
  invoices in one afternoon, each losing its text, summary, chunks and FTS row
  while the recovery pass retried it forever. The email side matters more:
  `email_messages.body_text` feeds a **generated** tsvector, so one NUL would
  fail an INSERT inside the sync and wedge that mailbox — the shape ADR 0110's
  `left(body_text, 200000)` guards against for a different reason.

## Consequences

- A non-briefing nudge is **not delivered on WhatsApp** out of window. It is
  still in the app, in Telegram, and in push. This is honest where the previous
  behaviour was not: it was already not delivering those messages, just noisily.
- An event echo and a reconnect warning now respect quiet hours and are gated by
  `notify_bot` rather than `notify_briefing`. That is a visible change for
  anyone who had briefings on and bot notifications off.
- Email no longer proposes anything already over. A user connecting a mailbox
  gets a shorter, live list.
- **The AI passes cost 1/N of what they did** for multi-mailbox users.
- Every hardcoded event date in the magics and consolidation fixtures had to go
  relative — the same consequence ADR 0100 recorded, and for the same reason: a
  literal rots into a test that silently exercises nothing.

## Alternatives rejected

- **Gate on `kind === 'daily_morning_scan'` at the publisher.** The publisher
  cannot see the kind — `messages` carried only the boolean. That is the bug.
- **Send the non-briefing nudge free-form anyway.** It is accepted and then
  silently failed by Meta. Doing nothing loudly beats doing nothing quietly.
- **Give non-briefing nudges their own template.** Another approved template,
  another billed conversation, for an echo of something the user just did in the
  app. Not worth a notification at all out of window.
- **Backfill `proactive_kind` for existing rows.** They are a mix, nothing
  re-publishes them, and guessing would recreate the bug in the data.
- **Make `proactive_kind` required.** Fifteen unrelated fixtures and every
  `const msg: MessagesTable = {…}` literal, to guard a default that is already
  the safe one.
- **Refuse a past event at confirm instead of at staging.** Leaves the card on
  the tab; the user taps and gets a refusal for something they cannot fix. And
  it would need ADR 0100's `turnId` exemption reopened for the ingest paths that
  legitimately file history.
- **Loosen title dedup to catch the rephrase.** Anything loose enough to merge
  "with American Express" and "for American Express credit card" also merges
  genuinely different to-dos. Provenance is exact and free.
- **Claim the extraction mark before the LLM call rather than after.** It only
  narrows the window: both racing passes had already SELECTed their candidates
  before either marked anything. And the invite-probe path deliberately defers
  *without* marking, which a blanket claim would break.
- **A composite `(user_id, id)` primary key on `email_categories`.** Considered
  and rejected in ADR 0106 for reasons that still hold; the race is between one
  user and themselves, which a composite key does not address either.
- **Serialise `afterSync` with a database lock instead of an in-process map.**
  The lock is right for the invariant and wrong for the waste: a second caller
  would block for the length of a full LLM pipeline rather than joining it.
- **Coalescing alone, without the round.** This was the first attempt and it is
  worth recording as wrong, because it *looks* sufficient: it collapses
  concurrent callers, and the pipeline being called N times per tick sounds like
  a concurrency problem. It is not — the bulk loops are `for … await`, so the N
  calls are strictly sequential and a coalescer never sees two at once. The
  three-mailbox user would have kept paying three pipelines. A test that counts
  passes fails at 3 without the round and passes at 1 with it.
- **Moving `afterSync` out of the providers to the entry points.** Correct, and
  ten places to forget it — including every entry point not yet written.
- **Debouncing `afterSync` on a timer.** The sequential calls are ~0.9s apart, so
  the window would have to be seconds long, and every sync would pay it.
