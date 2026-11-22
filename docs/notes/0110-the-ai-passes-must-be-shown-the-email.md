# 0110 — The AI passes must be shown the email

**Status**: accepted
**Date**: 2026-08-25
**Relation**: narrows ADR 0060's lazy-body rule to the reader alone — the AI
passes get their own eager copy; completes
[0109](./0109-bulk-is-how-mail-was-sent.md) by asking the model the same
question the headers answer; lifts the Gmail-only scope
[0080](./0080-multi-account-email-providers.md) put on attachment import; and
supplies the input [0066](./0066-in-repo-llm-email-classifier.md)'s classifier,
ADR 0063's magics and [0087](./0087-email-tile-archetype-facts.md)'s tile facts
always assumed they had.

## Context

ADR 0109 shipped, and a prod check on the two emails that prompted it found
**neither would be caught**. Both live in an Outlook mailbox, where every arm of
the rule is blind: 0 `List-Unsubscribe` captures, 0 of 173 threads carrying
`CATEGORY_PROMOTIONS`.

The owner's response reframed it: *"why not read the email with LLM and
classify? we are putting so many rules that may not work."* Checking what the
model actually receives makes that the right question.

**We were not reading the email. We were reading about 78 characters of it.**

The Christy Sports snippet in prod is `"Sunny-day picks. End-of-summer prices."`
followed by ~200 characters of U+200C — the standard marketing preheader
spacer. Across the mirror, **464 of 2,432 threads (19%)** lose 40+ characters to
invisible padding, and on those the median amount of *real* text is **78**, down
from 206 raw.

Bodies barely existed at all:

| source | messages | `body_text` | `body_html` |
|---|---|---|---|
| gmail-primary | 2,718 | 47 | 46 |
| outlook | 174 | 0 | 8 |
| gmail (secondary) | 34 | 0 | 0 |
| imap | 20 | 19 | 20 |

Both Gmail paths synced with `format=metadata`; bodies arrived only when a human
opened a thread. Outlook's delta returns `bodyPreview` and no body. Only IMAP,
which parses the whole source anyway, had text.

Which exposed a defect wider than classification: **`magics.service.ts` and
`person-extraction.ts` both read `bodyText.slice(0, 2000)`, and in prod they got
`null` 98% of the time.** Two per-thread LLM passes — the expensive ones, one
call each — were written to read 2,000 characters and were handed a padded
snippet. The codebase had already decided how much of an email is enough to
read; the mirror simply never fetched it.

Three reported symptoms are all this, from different angles:

- a **BitGo invoice** never reached the Finance ledger — its snippet is cut off
  at `Date: 7/31/2026 | Am`, one word before the amount, and its PDF sat in the
  mailbox attachment import refused to look at;
- an **Epic Pass payment** never reached it either, truncated before any figure;
- an **Expedia trip to Detroit** never became a trip — the dates are in the
  body, and only the subject mentions Detroit, which is why it appeared in the
  daily digest (subjects) and nowhere else.

## Decision

### Read the message, bounded

Sync keeps `email_messages.body_excerpt`: the first 2,000 characters — the
number the two per-thread passes already used. Both Gmail paths move from
`format=metadata` to `'full'` (Gmail charges quota per *method*, so this costs
no additional quota; the cost is bandwidth and disk). IMAP fills it from text it
already parses. Outlook's delta still carries no body, so its excerpt arrives on
the thread-open fetch — and where a provider returns HTML only, a small
dependency-free `htmlToText` derives the text, since Graph returns HTML for
essentially everything.

**`body_text` stays lazy and reader-owned.** One writer each: sync owns the
excerpt, the reader owns the full body. Neither can truncate the other, so no
sequence of syncs and opens can show a user a shortened email.

### Clean the text before anyone reads it

`cleanSnippet` strips zero-width and directional format characters and collapses
whitespace, applied in all three provider normalizers, with migration `048`
backfilling stored rows. The thread list benefits too — it had been rendering a
sentence followed by 200 invisible characters.

This is deliberately **not** claimed as the fix for the reported email: the
model already had `news@christysports.com` in the payload and still said
*Newsletters › Recipes & food*. That one was ADR 0109's prompt fork. De-padding
stands on the 19%.

### Ask the model the bulk question too

The classifier returns `bulk` alongside path and action, at about five output
tokens per thread, and it works on every provider — including the one no header
rule reaches.

`email_threads.bulk` keeps its ADR 0109 meaning (provider-declared, owned by
`recomputeThread`); `bulk_inferred` holds the model's judgement, owned by
ingest. Effective bulk is the OR. **Two columns rather than one plus a
precedence rule**, because a single column carries an ordering hazard that is
invisible until it bites: `recomputeThread` runs after every sync, so a model
verdict would be silently overwritten with 0 the next time any message in the
thread changed.

The header does not become redundant — it is a declaration where the model is
inferring, and it settles the cases text cannot (a ParentSquare blast reads
exactly like a personal note). With both columns populated the disagreement rate
is measurable, and whichever signal fails to earn its keep can be deleted with
evidence rather than argument.

### Read further when the answer is below the cut

2,000 characters is right for most mail and wrong for exactly the mail that
matters. **The extractor asks**: one boolean in the JSON it already returns,
set when the detail it needed was plainly there and cut off. A keyword list
(*if the subject says "itinerary"…*) is the rule-shaped thing this ADR exists to
avoid; the model has just read the excerpt and is far better placed to judge.

Escalation re-reads the whole message and re-runs over `EMAIL_DEEP_READ_CHARS`
(24,000 — past prod's median body of 9.2k and its mean of 18.1k).

**"More to read" is a question about LENGTH, not about which column the text
came from.** The first version of this gate asked whether the excerpt was all
we had, which starves the case with the most left to read: a thread a human
opened holds the entire body in `body_text`, and the extractor still shows only
its first 2,000 characters. The same slip sat in the abort guard, which
compared the re-read against what the caller was HANDED rather than what it
SHOWED — and a full body re-read comes back the same length or shorter, so it
refused precisely the escalation it should have allowed.

The per-tick ceiling is a **runaway backstop, not a ration**, and defaults to
the magics thread cap so it never refuses a request the pass could legitimately
make — a refused one is how the BitGo amount stayed unread one word past the
cut. The real bound is structural: a thread is mined once ever, so at most one
extra call per thread. Escalation is for magics only; classification settles
inside 2,000.

### Attachments from every mailbox

ADR 0080 scoped attachment import to Gmail because attached accounts had *"no
fetchable attachment parts"*, and then its own addendum built
`fetchEmailAttachmentData` to fetch exactly those for the download route. The
constraint outlived its reason, and it meant BitGo's PDF — the one legible copy
of that amount — was never read. Import now discovers parts per provider
(`attachmentPartsFor`) and takes bytes from the existing dispatcher.

### Re-run what was decided on too little

`email_threads.classifier_version` records the generation of prompt+inputs
behind a stored classification. `selectBatch` keeps its existing priority and
**tops the batch up** with stale-version threads, so live mail is never starved
and no second rate knob has to be kept in step. A pass that *answered* stamps
the threads it read even when the answer was empty; only a pass that **threw**
leaves them queued — without that distinction a thread the model declines to
classify would sit at the head of the queue forever.

`backfillBodyExcerpts` drains the pre-existing mirror a few messages per sync,
and setting an excerpt re-queues that thread — which is what sequences the two
without a second queue: a thread becomes re-readable exactly when its input
improved.

### A tile still shows what it holds

Tile content was built entirely from open work — pending suggestions plus
newest-unread — and acting on an email leaves both in one gesture. A third
preview source (`kind: 'recent'`) ranks below the others, one line per thread.
**Attention counts are untouched**: a handled category should stop shouting, it
just should not go blank. The client was also filtering previews to `magic`
only, so the fix is worthless server-side alone.

### Internal tags never reach the user

`INFO_ONLY` and its siblings are notes to the model. Prod shipped *"Onam
tomorrow [INFO_ONLY]."* The prompt now forbids printing them **and**
`stripContextTags` removes them from rendered briefing text — matched by NAME,
because a general `[...]` strip would eat the user's own brackets. Same posture
as ADR 0100 and 0102: a rule the model is asked to follow is not a guarantee,
and free prose has no other choke point.

## Consequences

- **Cost roughly quadruples on the AI passes.** Measured against real volume
  (heaviest prod user 1,128 messages/month): classification goes from ~$0.78 to
  ~$2.01 per active user per month at Sonnet-class prices, and the two
  per-thread passes rise similarly now that they get their 2,000 characters.
  Worth re-checking against ADR 0079's trial economics before a larger audience,
  not after.
- **The first sync after deploy is heavy**, one time: `format=full` is ~50-100
  KB per message against 1-3 KB, so a full backfill window moves ~200 MB rather
  than ~5 MB. Bandwidth and wall-clock, not quota.
- **`extractBodies` can still return nothing** when a sender ships neither a
  `text/plain` part nor usable HTML. Worth measuring after deploy.
- Existing magics marks are **not** cleared (owner decision, dogfooding): a
  thread is mined once ever, so the three reported threads stay as they are and
  the improvement applies going forward. Doing otherwise means re-spending a
  per-thread LLM call and re-proposing suggestions already rejected — the mark
  is the only guard against that.

## Alternatives rejected

- **Send the whole body to every thread.** ~$7.35 per active user per month,
  20-35× current spend, growing with mail volume rather than with difficulty.
  The 2,000-char cap is the codebase's own answer in two other passes — and
  escalation buys the same reach for the threads that need it. Note this is a
  rejection of reading everything by DEFAULT, not of spending a second call: the
  owner's rule is that a second call is fine whenever the model says it needs
  one, which is why the ceiling cannot be a ration.
- **Keyword rules for when to read further** — the thing the owner objected to,
  and the thing that does not generalise past the examples it was written from.
- **"Extracted nothing and more exists → escalate"**, which sounds like the
  neutral trigger and fires on every newsletter, i.e. most mail.
- **Merging the two bulk columns behind a precedence rule.** See the ordering
  hazard above; it is silent when it goes wrong.
- **Stamping `classifier_version` inside `ingestClassification`.** The snapshot
  is replace-everything and carries the whole mailbox forward from baseline, so
  it would mark threads as freshly classified that nobody re-read, and the
  re-run queue would empty without ever running.
- **Storing the full body at sync** instead of a capped excerpt. ~22 KB per
  message against ~2 KB, for text nothing reads past 2,000 characters of except
  on escalation — which fetches it fresh anyway.
