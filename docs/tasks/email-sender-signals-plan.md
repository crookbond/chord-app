# Sender signals: make bulk and no-reply detectable, and make them mean something

> **Status.** Pieces 1-3 shipped ([ADR 0106](../notes/0106-classification-ids-belong-to-a-user.md)
> + migration `046`; [ADR 0109](../notes/0109-bulk-is-how-mail-was-sent.md) + `047`).
> Pieces 6-11 shipped together as
> [ADR 0110](../notes/0110-the-ai-passes-must-be-shown-the-email.md) + migration `048`
> — read the ADR rather than the piece text below, which it deviates from in
> several places. **Nothing is deployed yet**, and until `046` runs three
> mailboxes stay unclassified. Pieces 4-5 are unstarted; 5 is independent of
> everything else.
>
> Deliberately NOT done (owner decision 2026-08-25, dogfooding): clearing
> existing magics extraction marks. A thread is mined once ever, so the three
> threads that prompted Pieces 6-9 keep their old (empty) result and the fix
> applies to mail arriving from here on.

## Context

Reported: a Bloomberg newsletter and a Christy Sports rental blast are sitting in
the inbox — *"why are they not classified as newsletter / coupon / mass?"*

I checked prod. **They are classified**, and correctly:

| thread | category | action |
|---|---|---|
| `Money Stuff: Who Should Control Anthropic?` (noreply@news.bloomberg.com) | Newsletters › Finance | informational |
| `Two weeks left ⏰` (news@christysports.com) | Newsletters › Sports | informational |

So the premise is wrong in a way that matters: the problem is not detection, it is
that **being a newsletter has almost no consequence**. Those threads still sit in
the inbox list at full weight, still count as unread attention, still take tile
area. The only suppression that exists anywhere is cosmetic and fragile:

- `digest.service.ts:14` — `LOW_SIGNAL_ROOTS` keeps four root titles off the
  digest's "worth a look" list.
- `mobile/src/email-tiles.tsx:65-71` — a `DAMPED` regex over the tile **title**.

Both match on *whatever title the LLM invented that batch*. Nothing keys off a
classification signal.

Three real defects sit underneath, found while checking:

### 1. Classification is structurally single-user (highest impact)

`email_categories.id` is `text PRIMARY KEY` ([migrate.ts:995](../../server/src/db/migrate.ts:995))
— **global**, not per-user — while `categoryIdForPath()`
([classifier-tree.ts:26](../../server/src/services/email/classifier-tree.ts:26)) derives
it from the title path alone, so `mk:newsletters` is byte-identical for every
user. Deletes in `ingestClassification` are user-scoped.

Consequence: the first user to classify claims the global id namespace. Every
other user's ingest hits `duplicate key value violates unique constraint
"email_categories_pkey"`, the whole transaction rolls back, and the fail-closed
catch logs it at **warn**.

Prod bears this out exactly — one user holds all 48 category rows; three others
have **zero** classified threads and have been failing on every sync since at
least 22 Aug:

```
llm classifier failed: duplicate key value violates unique constraint
  "email_categories_pkey"     ← Ben, every sync, 22/23/24 Aug
                                 Alice, every sync, 23/24 Aug
```

That is 1,288 unclassified threads across three mailboxes, silently.

### 2. The two real bulk signals are thrown away

- **`List-Unsubscribe`** — which Gmail and Yahoo have required of high-volume
  senders since Feb 2024 (RFC 8058), so the big retailers do set it — is never
  fetched. Gmail's metadata sync uses a fixed allow-list
  ([gmail-api.ts:48](../../server/src/services/google/gmail-api.ts:48)) that omits it,
  and `headers_json` persists only `date`, `inReplyTo`, `references`. Verified
  in prod: a Christy Sports message stores exactly those three keys.
- **`CATEGORY_PROMOTIONS`** — fetched and stored on `gmail_label_ids`, but
  `gmailCategoryOf()` feeds it to the LLM as an advisory *hint* only. Nothing
  gates on it.

So bulk detection today rests entirely on the model's read of a subject line.

### 3. "Bulk" is being asked as a topic question, so the answers are bad

The prompt offers `promotions → "Coupons" or "Newsletters"`, then gives
Newsletters six topic leaves and Coupons none. The model takes the path of least
resistance: **Coupons holds 3 threads in the entire database**; Newsletters holds
75. Retail promos pile into Newsletters and then need a topic, which produces
nonsense:

- `Your summer picks + up to 50% off ☀️` (ski retailer) → Newsletters › **Recipes & food**
- `Reach new customers with up to $1500 in Google Ads credit` → Newsletters › **Finance**

The mistake is structural, not a prompt bug. **Bulk-ness is a property of how the
mail was sent, not what it is about.** Money Stuff genuinely *is* about finance
*and* is a blast. Forcing that into one axis makes every promo pick a wrong topic.

## Approach

Owner decisions: add the orthogonal axis **and** fix the taxonomy; **demote**
bulk mail rather than hiding it; fix the multi-user wedge in the same change;
and never claim a reply is owed to an address that cannot receive one.

Eleven pieces. **1-3 are shipped** (ADR 0106 + migration 046; ADR 0109 +
migration 047) and awaiting deploy — until 046 runs, three mailboxes stay
unclassified.

**Pieces 6-11 are the next work, and they go together.** They came out of
checking Pieces 2-3 against prod, and every one of them is the same discovery
from a different angle: *the AI passes are not being shown the email.*

- **6** gives them the body, and the model a bulk verdict; **7** re-runs the
  mail that was classified without it.
- **8** unpins attachment import from Gmail. BitGo's invoice is a PDF in the
  Outlook mailbox, so the one legible copy of the amount is never read.
- **9** lets extraction ask for more when the answer sits below the excerpt —
  BitGo's snippet is cut off one word before the figure.
- **10** stops a tile going blank the moment you act on it; **11** stops
  internal context tags being printed at the user. Both are small and
  independent of the rest.

7, 8 and 9 depend on 6. Piece 4 (demotion) should follow them, since it acts on
the signal and wants the disagreement data first. **Piece 5 is independent of
all of them** and can go any time.

## Piece 1 — unwedge multi-user classification (ship first, independently)

Put the user in the id. `categoryIdForPath` gains a `userId` and returns
`mk:<userId>:travel/flights`; `ensurePath` and `buildTreeFromPaths`
([classifier-tree.ts:26-85](../../server/src/services/email/classifier-tree.ts:26))
thread it through, as does `buildSnapshotFromPaths`
([llm-classifier.ts:274](../../server/src/services/email/llm-classifier.ts:274)), which
already has the user id in hand.

**No DDL.** `id text PRIMARY KEY` stays, so all three foreign keys
(`email_categories.parent_id` self-FK, `email_threads.category_id`,
`email_message_categories.category_id`) keep pointing at the same column. Two
facts make this safe, both verified:

- `mk:` is constructed in exactly one place and **parsed back nowhere** — a repo
  grep finds only the doc comment and `categoryIdForPath` itself.
- `TOP_COLOR` keys off `path[0]`, the *title*, not the id
  ([classifier-tree.ts:8-19](../../server/src/services/email/classifier-tree.ts:8)), so
  tile colours are unaffected.

**Migration 047** rewrites the existing rows in one transaction: update
`email_categories.id` and `parent_id`, then the two referencing columns, to the
prefixed form. Prod holds 48 rows for a single user, so this is instant — but it
must be one transaction, and children must be rewritten with their parents.

Rejected: a composite `(user_id, id)` primary key. It is arguably the more
correct schema, but it forces every referencing FK to become composite and buys
nothing here — the id is already an opaque slug nobody reads.

### The rule that constrains everything below

`docs/tasks/Email-bugsandbacklog.md:503-527` already worked out the hard part,
and the plan follows it rather than relitigating it:

> `List-Unsubscribe` is **a strong positive signal and a weak negative one.**
> Present → almost certainly bulk-sent. Absent → tells you very little.

Two consequences that shape every gate:

- **Transactional mass mail carries no unsubscribe header, by design.** Order
  confirmations, shipping notices, receipts and itineraries are exempt from the
  RFC 8058 mandate and arrive from the same retailers on the same
  infrastructure. That is precisely the mail the AI passes *should* mine, so its
  absence must never be read as "not bulk, therefore interesting".
- **Evite, Eventbrite, Meetup, ParentSquare and Remind all set the header.**
  A bulk-alone gate would demote exactly the invitation ADR 0088 fought to keep.

So `bulk` is stored as a **signal, never a verdict**. Nothing demotes, skips or
hides on `bulk` alone: every consumer combines it with a second condition, and
`action IN (to_do, reply_needed)` overrides it everywhere.

## Piece 2 — capture the bulk signal (server)

**Migration 046** — `email_messages.list_unsubscribe text`, plus
`email_threads.bulk integer NOT NULL DEFAULT 0` (the ADR 0038 boolean-as-integer
convention; compare `= 1`, never `IS TRUE`).

Add `List-Unsubscribe`, `List-Id` and `Precedence` to `METADATA_HEADERS`
([gmail-api.ts:48](../../server/src/services/google/gmail-api.ts:48)) and persist them
through `normalizeMessage`
([gmail-sync.ts:159-185](../../server/src/services/google/gmail-sync.ts:159)). One
strong signal plus two weak corroborators — not three peers.

New `server/src/services/email/bulk.ts`:

```ts
export function isBulkSender(msg: {
  listUnsubscribe: string | null;
  listId: string | null;
  labelIds: string[];
}): boolean
```

`List-Unsubscribe` present → bulk. Else `List-Id` present → bulk. Else
`CATEGORY_PROMOTIONS` on the thread → bulk (Gmail's own verdict, which is what
covers the small senders that set no header — the real coverage gap the backlog
identifies). `Precedence: bulk` corroborates but never decides alone.

Set on thread recompute, so it survives snapshot-replace and needs no LLM.

**Backfill without a re-sync**: `CATEGORY_PROMOTIONS` is already stored on every
existing row, so migration 046 can set `bulk = 1` from `gmail_label_ids` alone.
Header-derived bulk fills in as mail re-syncs.

## Piece 3 — stop asking a topic question about bulk mail

With `bulk` carried separately, the taxonomy stops having to encode it:

- Prompt ([llm-classifier.ts:24-73](../../server/src/services/email/llm-classifier.ts:24)):
  drop `"promotions" → "Coupons" or "Newsletters"`, which is the fork that
  produced *Newsletters › Recipes & food* for a ski sale. Replace with: classify
  by **subject matter only** — a retailer's sale email about ski gear is
  `["Shopping"]` or `["Coupons"]`, never a Newsletters topic leaf.
- Give `Coupons` real leaves so it stops being a dead end, and add the
  `bulk`-derived hint to each thread in the user payload beside `gmailCategory`.
- Keep `["Newsletters","Junk"]` — it is the one place a topic judgement is
  genuinely useful.

**No taxonomy allow-list.** Titles stay free-form (`buildTreeFromPaths` invents
whatever arrives); once demotion keys off `bulk` rather than a title regex, an
invented title is no longer load-bearing.

## Piece 4 — make it mean something (demote, never hide)

One predicate, used everywhere, so the rule lives in one place:

```ts
// server/src/services/email/bulk.ts
export const isDemotable = (t: { bulk: number; action: EmailAction | null }) =>
  t.bulk === 1 && t.action !== 'to_do' && t.action !== 'reply_needed';
```

The action override is what keeps an Evite, a school blast or a bill visible: all
three are bulk-sent, and all three are exactly what must not be demoted.

**Tile weight — the real fix.** `loadCategoryCounts`
([classification.service.ts:240-350](../../server/src/services/email/classification.service.ts:240))
computes `attention` = unread threads **plus** threads carrying a pending
suggestion, and that is what drives both tile area and the badge
(`EmailTile.attention`, [kernel/src/types/email.ts:93](../../kernel/src/types/email.ts:93)).
Exclude demotable threads from the unread half of that count. Bulk mail then
stops inflating the root badge and stops taking area, without disappearing —
ADR 0068's additive floor already keeps a cold tile tappable.

**Delete the title regex.** `BOOSTED`/`DAMPED`
([mobile/src/email-tiles.tsx:65-71](../../mobile/src/email-tiles.tsx:65)) goes away
rather than being tuned. It is the workaround this whole change exists to
retire — weighting hostage to whatever title the model invented that batch.

**Digest.** Replace `LOW_SIGNAL_ROOTS`
([digest.service.ts:14](../../server/src/services/email/digest.service.ts:14)) — four
hard-coded root *titles* — with the same `isDemotable` predicate. Strictly
better: it currently drops all of Deliveries and Receipts, including a delivery
that genuinely needs action.

**Row affordance.** A quiet `bulk` chip on the thread row, and `bulk` on
`EmailThreadSummary`. Owner chose demote over hide, so the list keeps every
thread and the default filter is unchanged; the chip is what makes the
classification legible, which is the original complaint.

## Piece 5 — a sender who cannot be replied to is never owed a reply

Reported: *"any email with no-reply should never generate a reply-to-sender
card."*

This is a **correctness** defect, not a weighting one, which is what separates it
from Pieces 2-4. `reply_needed` means *"a human is waiting on a written reply
from the user"* ([llm-classifier.ts:38](../../server/src/services/email/llm-classifier.ts:38)).
For `no-reply@`, `donotreply@`, `notifications@` and `mailer-daemon@` nobody is
waiting and no reply can arrive, so the claim is false — and every surface that
repeats it is wrong:

- the `REPLY` row badge and the "Reply" filter chip
  ([mobile/app/email/index.tsx:76](../../mobile/app/email/index.tsx:76))
- the "Needs a reply" section of `summarize_email`
  ([summary.service.ts:50](../../server/src/services/email/summary.service.ts:50))
- **the morning briefing's reply-worthy list**
  ([digest.service.ts:101-131](../../server/src/services/email/digest.service.ts:101)) —
  the one that puts "reply to X" in front of the user unprompted, every day
- `action` on `search` hits, so the bot answers *"which emails need a reply"*
  with them

**The predicate already exists**, private to person extraction:

```ts
// person-extraction.ts:61
const NOREPLY_RE = /no-?reply|donotreply|notifications?@|mailer-daemon|postmaster/i;
```

Hoist it into `bulk.ts` beside `isBulkSender` — the same axis, what the transport
tells you that the topic cannot — and export `isUnrepliableSender(fromEmail)`.

**Gate at classification ingest, not per surface.** An unrepliable sender can
never be assigned `reply_needed`; ingest coerces it to `informational`. That is
the ADR 0086 precedent — ingest already defaults a missing action rather than
leaving each reader to cope — and it means badge, chip, digest, summary sections
and bot all inherit the fix untouched. A per-surface filter is the same rule
written five times, and the fifth gets forgotten.

Two consequences, both easy to get wrong:

- **Stored rows need a backfill.** Coercion at ingest only helps threads
  classified afterwards. `email_threads.from_email` is already stored, so one
  `UPDATE … WHERE action = 'reply_needed' AND from_email ~* …` fixes history
  with no LLM call and no re-sync.
- **Do not remove the Reply affordance.** This suppresses the *claim* that a
  reply is owed, never the ability to send one. A school announcement relayed
  from a no-reply address still has real recipients worth replying-all to, and
  ADR 0107's posture is that answering is the half we own. Same
  strong-positive/weak-negative discipline as `List-Unsubscribe`: the address
  proves nobody is waiting; it does not prove the user has nothing to say.

`to_do` is deliberately **not** gated. A no-reply sender routinely gives you
something to do — a bill, a form, a deadline — and that is exactly the
transactional mail Piece 2's rule already protects.

Independent of Pieces 2-4: no new column, and no migration beyond the backfill.

## Piece 6 — feed the model the email

### Context

Pieces 2-3 shipped, and a prod check on the two emails that started this found
that **neither would be caught**. Both live in the Outlook mailbox
(`ownertest@hotmail.com`, 173 threads), which has **0** `List-Unsubscribe`
captures and **0 of 173** `CATEGORY_PROMOTIONS` labels. Every arm of the ADR
0109 rule is Gmail- or IMAP-shaped.

Owner's response reframed the problem: *"why not read the email with LLM and
classify? we are putting so many rules that may not work."* Checking what the
model actually receives makes that the right question.

**We are not reading the email. We are reading about 78 characters of it.**

The Christy Sports snippet in prod is `"Sunny-day picks. End-of-summer prices."`
followed by ~200 characters of U+200C padding — the standard marketing
preheader-spacer trick. Across prod, **464 of 2,432 threads (19%)** lose 40+
characters to invisible padding, and on those threads the median amount of
*real* text the model sees is **78 characters**, down from 206 raw.

Bodies barely exist. `email_messages` holds:

| source | messages | with `body_text` | with `body_html` |
|---|---|---|---|
| gmail-primary | 2,718 | 47 | 46 |
| outlook | 174 | 0 | 8 |
| gmail (secondary) | 34 | 0 | 0 |
| imap | 20 | 19 | 20 |

Primary and secondary Gmail sync with `format=metadata`; bodies arrive only when
a human opens the thread. Outlook's delta returns `bodyPreview` and no body.
Only IMAP, which parses the whole source anyway, has text.

Which exposes a bug wider than classification: **`magics.service.ts:156` and
`person-extraction.ts:119` both read `bodyText.slice(0, 2000)`, and in prod
they get `null` 98% of the time.** Two per-thread LLM passes — the expensive
ones, one call each — are written to read 2,000 characters of the email and are
being handed a padded snippet. The codebase already decided how much of an email
is enough to read; the mirror just never fetched it.

**Costs**, measured against real volume (heaviest prod user 1,128 messages/month,
second 719, so per-1,000 ≈ per-active-user-per-month):

| what the model reads | tokens/email | per 1,000 (Haiku-class) | per 1,000 (Sonnet-class) |
|---|---|---|---|
| today (padded snippet) | ~140 | $0.26 | $0.78 |
| de-padded snippet | ~130 | $0.24 | $0.72 |
| + 2,000 chars of body | ~550 | $0.67 | $2.01 |
| whole body (median 9.2k chars) | ~2,330 | $2.45 | $7.35 |

Gmail charges quota per *method*, so `format=full` costs the same quota units as
`metadata` — there is no Gmail-side price. The real costs are bandwidth
(~1-3 KB/message metadata vs 50-100 KB full, so ~50-100 MB per user per month)
and disk (~2 KB/message at the cap).

Owner decisions: de-pad **at sync with a backfill**, and **store 2,000 chars of
body at sync** — the number the codebase already uses in two other passes.

### 1. De-pad the snippet at sync

One shared helper — strip Unicode format and zero-width characters (U+200B-200F,
U+2060, U+FEFF), collapse whitespace runs, trim — called on `snippet` in each
provider normalizer: `normalizeMessage` ([gmail-sync.ts:159](../../server/src/services/google/gmail-sync.ts:159)),
`normalizeGraphMessage` ([outlook.service.ts:52](../../server/src/services/email-accounts/outlook.service.ts:52)),
`normalizeImapMessage` ([imap.service.ts:72](../../server/src/services/email-accounts/imap.service.ts:72)).

Migration backfills `email_threads.snippet` and `email_messages.snippet`. The
thread list benefits too — today it renders one sentence followed by 200
invisible characters.

Deliberately **not** sold as the fix for the reported email. The model already
had `news@christysports.com` in the payload and still said *Recipes & food*;
that one is the Piece 3 prompt fork. De-padding stands on the 19% figure.

### 2. Store a bounded body excerpt at sync

Migration adds `email_messages.body_excerpt text`. Five call sites move from
`'metadata'` to `'full'`: [gmail.service.ts:490](../../server/src/services/google/gmail.service.ts:490)
(backfill), [:599](../../server/src/services/google/gmail.service.ts:599) (incremental add),
[:632](../../server/src/services/google/gmail.service.ts:632) (spam rescue), and
[gmail-account.service.ts:151](../../server/src/services/email-accounts/gmail-account.service.ts:151),
[:253](../../server/src/services/email-accounts/gmail-account.service.ts:253).

`normalizeMessage` already calls `extractBodies`, so a full fetch populates
`bodyText` with no new parsing. `upsertMessageMeta` stores the de-padded first
2,000 characters as `body_excerpt`.

**`body_text` stays lazy.** ADR 0060 is untouched: the reader still owns the
full body and fills it on thread open, so nothing can render truncated mail and
the two writers never fight. IMAP fills the excerpt from the text it already
parses.

The three AI passes read `body_text ?? body_excerpt` —
[magics.service.ts:489](../../server/src/services/email/magics.service.ts:489),
person-extraction, and the classifier payload.

### 3. The classifier reads it, and returns a bulk verdict

The user payload gains a `body` field (the excerpt), and the response gains
`bulk`. Costing ~5 output tokens per thread, this covers every provider —
including Outlook, which no header rule reaches.

Storage keeps the two sources **apart** rather than merging them:
`email_threads.bulk` keeps its ADR 0109 meaning (provider-declared, owned by
`recomputeThread`) and a new `bulk_inferred` holds the model's judgement, owned
by ingest. Effective bulk is the OR, computed where consumed.

Two columns rather than one plus a precedence rule, because a single column has
an ordering hazard that is invisible until it bites: `recomputeThread` runs
after every sync, so a model verdict written by ingest would be silently
overwritten with 0 the next time any message in the thread changed. Two owners,
two columns, no ordering to get right — and Piece 4 can then be bolder with
header-declared bulk than with inferred bulk.

### Where this leaves the header rules

The model becomes primary and the header becomes ground truth for the cases
text cannot settle — a ParentSquare blast reads exactly like a personal note.
Once both columns are populated the **disagreement rate is measurable**, and
whichever signal fails to earn its keep can be deleted with evidence. That is
the answer to *"rules that may not work"*: keep both briefly, then decide from
data rather than from argument.

### Deferred: Outlook bodies

Outlook still gets no body. Graph's delta would need `$select=body` — which I
have **not** verified is permitted on the delta endpoint — plus an HTML-to-text
stripper, since Graph returns HTML (`body_html` averages 34 KB) and the repo has
no such helper. Its own step, behind that verification.

### Cost of this piece

Classification ~$0.78 → ~$2.01 per active user per month at Sonnet-class; the
two per-thread passes rise similarly now that they finally get their 2,000
characters. Call it **~$3-4 per active user per month all-in**, or ~$1.20 at
Haiku-class. Plus ~50-100 MB/user/month bandwidth and ~2 KB/message on disk.

## Piece 7 — reclassify what the old prompt got wrong

Pieces 3 and 6 change the prompt *and* what the model reads. Without this, only
mail arriving afterwards benefits: prod's 2,432 existing threads keep the labels
the old fork produced, including the *Newsletters › Recipes & food* row that
started this. Owner decision — reclassify.

Built as a **capability, not a one-off script**, because the same need recurs
every time the prompt changes materially.

### The mechanism

`email_threads.classifier_version integer NOT NULL DEFAULT 0`, with the current
version a constant in code (`1` at this change, covering Pieces 3 and 6
together). `ingestClassification` stamps it alongside `classified_at`, so the
ADR 0061 Mode B path is stamped too.

`selectBatch` ([llm-classifier.ts:239](../../server/src/services/email/llm-classifier.ts:239))
keeps its existing priority — never classified, then changed since classified —
and then **tops the batch up** with `classifier_version < CURRENT`. New mail can
never be starved by a backlog, and no new rate knob is needed: whatever
`EMAIL_CLASSIFIER_BATCH_SIZE` (40) is not spent on live mail goes to the queue.
Prod's 2,432 threads drain in ~61 ticks.

### Old mail needs the better input, not just the better prompt

A stored message has no `body_excerpt` — Gmail sync only fetches new messages —
so a reclassify today would run on the de-padded snippet alone. The de-pad
backfill is a regex over stored text and costs nothing; the excerpt is not.

So a bounded backfill pass re-fetches `format=full` for messages with neither
`body_text` nor `body_excerpt`, newest-first, `EMAIL_BODY_BACKFILL_PER_TICK`
(default 25) per sync. **Writing an excerpt resets that thread's
`classifier_version` to 0**, which is what sequences the two: a thread becomes
reclassify-eligible exactly when its input improved, with no second queue and no
ordering logic. Threads that never get an excerpt — no `text/plain` part, or
outside the backfill window — still reclassify on the improved snippet, just
later in the drain.

### Cost

One-off per mailbox, on top of the running cost above:

- ~2,400 threads × ~550 tokens ≈ **$4 at Sonnet-class, $1.34 at Haiku-class**.
- ~2,700 `format=full` fetches ≈ **~200 MB** of bandwidth, spread over ~110
  ticks at 25/tick. Quota is unchanged — same method, same units.

### Risks specific to this piece

- **Reclassification is destructive by design.** Ingest is snapshot-replace, so
  a *successful but worse* pass overwrites good labels with no way back. The
  fail-closed catch only protects against errors, not against a worse answer.
  Mitigation is the drain rate itself: at 40/tick there is time to look at the
  first few hundred and lower the version constant before a mailbox is rewritten.
  Worth doing deliberately on one mailbox before a wider deploy.
- **Tile ids churn.** Rebuilding the tree deletes categories nothing points at
  any more, so a client holding a `?category=` id can land on an empty tile
  until it refetches. Ids are opaque and echoed back (ADR 0106), so this is a
  refresh, not a break — but it will be visible during the drain.
- **ADR 0077 routing rules match on category-title substring.** If titles move
  under reclassification, a user-declared rule can silently stop matching — the
  one place where a better classification makes behaviour worse. Checked:
  `email_routing_rules` holds **0 rows** in prod, so nothing breaks today. It
  becomes real the moment someone declares a rule, which is an argument for
  reclassifying now rather than later.

## Piece 8 — attachments come from every mailbox

ADR 0071 imports email attachments into the knowledge base; ADR 0080 scoped that
to Gmail "in v1" on the grounds that *"attached-account messages have no
fetchable Gmail attachment parts"* — which stopped being true when ADR 0080's
own addendum added `fetchEmailAttachmentData`
([attachment-fetch.ts](../../server/src/services/email-accounts/attachment-fetch.ts)),
a cross-provider dispatcher already serving the on-demand download route. The
constraint outlived its reason.

It shows: BitGo's invoice arrives as a PDF — *"a pdf copy of the Invoice has been
attached"* — into the Outlook mailbox, so the one place the amount is legible is
never read.

`runAttachmentImport` ([attachment-import.ts:44](../../server/src/services/email/attachment-import.ts:44))
drops its `account_id IS NULL` filter and its direct `getGmailApi` /
`getAttachment` calls, and takes bytes from `fetchEmailAttachmentData` instead.
Everything downstream — `shouldImport`, the dupe check, the personal-group
`saveFile` pipeline, the once-per-message `attachments_imported_at` marker — is
provider-agnostic already.

The parts list is the only real work. `attachments_json` is populated at sync for
IMAP, and only on thread open for Gmail and Outlook. Piece 6 fixes half of that
for free: once Gmail syncs with `format=full`, `listAttachmentParts` can fill
`attachments_json` in the same pass, and attachment import stops making its own
duplicate full fetch. Outlook needs one `/attachments` list call per message, and
`GraphMessage.hasAttachments` says which messages deserve it.

## Piece 9 — read further when the answer is below the cut

A 2,000-character excerpt is right for most mail and wrong for exactly the mail
that matters most. Prod, all three from the Outlook mailbox:

| thread | what the extractor could see |
|---|---|
| BitGo invoice | `… Invoice Number: NY00001-245016-2607-1 \| Date: 7/31/2026 \| Am` |
| Epic final payment | `… Thank you for your 2026/27 Season Pass purchase(s). We'` |
| Expedia "trip to Detroit" | `Earn rewards any way you travel` + ~200 chars of padding |

BitGo is cut off **one word before the amount**. Expedia's dates and itinerary
are in the body; only the subject mentions Detroit, which is why it reached the
daily digest (subjects) and never became a trip (details).

**The extractor asks for more; it is not guessed at.** A keyword list — *if the
subject says "itinerary"…* — is the kind of rule that does not generalise, which
is the objection that produced Piece 6 in the first place. The model has just
read 2,000 characters and is far better placed to say whether the answer looked
like it was below the cut. One extra boolean in the JSON it already returns,
about one output token.

Escalation re-reads the message in full — every provider already has that path
from thread open, and a thread the user opened is already stored — then re-runs
extraction over `EMAIL_DEEP_READ_CHARS` (24,000, past prod's mean body).

Two bounds, and note what is NOT among them (owner rule, 2026-08-25: *"a second
LLM call is fine when our agent is saying it's needed"*):

- **Only when there is more to read** — a length test against what the extractor
  will actually SHOW, not against which column the text came from. Free, and no
  domain knowledge in it.
- **Once per thread, ever**, which a thread being mined once ever already gives
  for nothing.
- The per-tick number is a **runaway backstop**, defaulted to the magics thread
  cap so it never refuses a genuine request. Rationing it is how an invoice
  amount stays unread one word past the excerpt.

Deliberately **not** added: an "extracted nothing and more exists → escalate"
trigger. It sounds neutral but it fires on every newsletter, which is most mail.
The model's own judgement plus the truncation gate is the version that spends
tokens on Expedia and not on Bloomberg.

Escalation is for **magics only**. Classification decides what a thread is about,
and 2,000 characters settles that; it is extraction that needs the amount, the
date and the confirmation number.

## Piece 10 — a tile still shows what it holds

Acting on an email empties the tile it came from. Tile content is built entirely
from open work ([classification.service.ts:253-300](../../server/src/services/email/classification.service.ts:253)):
magic titles from proposals with `status = 'pending'`, topped up with the newest
**unread** subjects. Confirming a suggestion resolves the proposal *and* marks
the thread read, so it leaves both sources at once — and if it is archived, ADR
0073 hides it everywhere.

Add a third preview source, ranked below the other two: newest threads in the
category regardless of read or pending state. The tile then keeps a line of
what it holds once the open work is done.

**Attention counts are not touched.** Area and badge still measure open work
(ADR 0068/0083) — a handled category should stop shouting, it just should not go
blank.

## Piece 11 — internal tags never reach the user

Reported: *"Onam tomorrow [INFO_ONLY]"* in the briefing.

`INFO_ONLY` is a context tag ([proactive.service.ts:707](../../server/src/services/proactive.service.ts:707))
telling the model an event came from a read-only calendar and must never be
called a conflict. The prompt explains what it means and never says not to print
it, so the model passes it through. `[OVERDUE]`, `[STALE]`, `OVERLAPS_WITH` and
`DURING_TRIP` are the same shape and can leak the same way.

Both halves, on the ADR 0100/0102 precedent that a prompt rule alone is not a
guarantee: state the rule, **and** strip the known tags from the rendered text
before it is sent. The briefing is free prose, so the scrub is the only real
choke point — and it must be a fixed list of our own tag names, never a general
`[...]` strip, or it eats the user's own brackets.

## Consequence for Pieces 6-9: the passes must be re-run

Piece 7 re-classifies, but **magics marks a thread once, ever** — ADR 0076's
addendum keeps `email_extraction_marks` rows forever precisely so a mirror wipe
cannot re-mine and re-propose. Verified in prod: 787 magic marks, and all three
threads above are marked. So better input changes nothing for them.

Clearing a mark costs a per-thread LLM call — the expensive pass, not the
batched one — so this is a bounded, deliberate re-run rather than a truncation of
the table: clear `magic` marks only for threads whose input actually improved
(an excerpt landed, or an attachment imported), and let the existing per-tick
limit drain them. Same shape as Piece 7's version bump, same reason.

## Verification

```bash
npx tsc -p server/tsconfig.json --noEmit && npm test --workspace=server
cd mobile && npx tsc --noEmit
```

Run the suite with `--poolOptions.forks.maxForks=3` and **stop the dev server
first** — it contends on Postgres and the 5-worker default then dies in
vitest's Windows tinypool teardown with zero assertion failures.

New tests:

- `classifier-tree.test.ts` — two users classifying the same path produce
  **different** category ids; ids stay stable for one user across snapshots.
- `llm-classifier` integration — two users, same mailbox shape, both classify
  successfully. This is the regression for the wedge; it fails today with
  `email_categories_pkey`.
- `bulk.test.ts` — header present → bulk; `CATEGORY_PROMOTIONS` alone → bulk;
  **neither → not bulk**; and the ones that matter: an Evite with
  `List-Unsubscribe` is bulk but is **not demoted**, and a shipping notice with
  no header is not bulk.
- demotion — a bulk thread with `action: to_do` keeps full weight.
- unrepliable senders — `no-reply@`/`donotreply@`/`notifications@` never come
  out of ingest as `reply_needed`, but a bill from one **keeps `to_do`**; a
  human sender with "reply" in the local part (`reply.smith@`) is untouched;
  the backfill flips stored `reply_needed` rows and nothing else.

Piece 6:

- de-pad helper — the real Christy Sports snippet (`"Sunny-day picks."` + 200
  U+200C) reduces to its 38 real characters; ordinary prose, accented text and
  emoji are returned **unchanged**; a snippet that is nothing but padding
  becomes empty rather than a string of spaces.
- excerpt — capped at 2,000; a message with no text part stores `null`, not `''`
  (the ADR 0080 `ics_text` distinction: "no body" and "never looked" differ).
- sync/reader boundary — a synced message has `body_excerpt` and **null**
  `body_text`; opening the thread fills `body_text` and **does not** shrink it
  to the excerpt. This is the regression that matters: it is the one way this
  change could show a user truncated mail.
- the two bulk owners cannot clobber each other — a model-inferred bulk survives
  a `recomputeThread` triggered by any later label change, and a header-declared
  bulk survives a re-classification that says otherwise.
- classifier payload carries the excerpt when one exists and omits the key when
  it does not; `parseClassifierResponse` ignores a non-boolean `bulk`.

Piece 7:

- batch fill order — with 40 new threads waiting and 500 stale-version ones, the
  batch is **all new mail**; with 5 new, it is 5 new plus 35 stale. Live mail is
  never starved, and the queue is never idle while the batch has room.
- a thread whose excerpt lands is re-queued (`classifier_version` back to 0), and
  a thread that will never get one still drains rather than sticking forever.
- version stamping covers **both** ingest paths — the in-repo classifier and the
  ADR 0061 Mode B route — or Mode B mailboxes reclassify on every tick forever.
- the backfill pass respects its per-tick cap and skips messages that already
  have `body_text`, so opening a thread is not undone by it.

Pieces 8-11:

- attachment import — an Outlook message and an IMAP message with a PDF each
  import once; the Gmail path is unchanged; `shouldImport` still drops `.ics`
  and inline logos whatever the provider; a message with no parts is marked and
  does not come back.
- deep read — a thread whose body equals its excerpt **never** escalates however
  loudly the model asks; a thread escalates at most once even across passes; the
  per-tick ceiling holds when every thread in a batch asks.
- BitGo as the acceptance case: with 12,000 characters the amount is present, so
  a ledger fact appears where 2,000 characters produced none.
- tile previews — after confirming the only pending suggestion in a category and
  the thread going read, the tile still returns a line; attention for that
  category drops to 0 in the same assertion, since the point is that the count
  falls and the content does not.
- tag scrub — `[INFO_ONLY]`, `[OVERDUE]`, `[STALE]`, `OVERLAPS_WITH`,
  `DURING_TRIP` are removed from rendered briefing text, and a user's own
  bracketed text (`"dinner [rescheduled]"`) survives untouched.

Prod checks after deploy — the same queries that produced this diagnosis, so
they are directly comparable:

```sql
-- padding: 464 of 2,432 threads today, should approach 0
WITH s AS (SELECT snippet, regexp_replace(snippet, '[​-‏⁠﻿\s]+', ' ', 'g') AS clean
           FROM email_threads)
SELECT count(*) FILTER (WHERE length(clean) < length(snippet) - 40) AS padded, count(*) FROM s;

-- body coverage: 47 of 2,718 on gmail-primary today
SELECT count(*), count(body_excerpt), count(body_text) FROM email_messages WHERE account_id IS NULL;

-- the question the whole piece is for: how often do the two disagree?
SELECT bulk, bulk_inferred, count(*) FROM email_threads GROUP BY 1,2;

-- the reclassify drain: should fall to 0 over roughly 61 sync ticks
SELECT classifier_version, count(*) FROM email_threads GROUP BY 1 ORDER BY 1;
```

Acceptance, not a metric: the two Christy Sports threads
(`from_email = 'news@christysports.com'`) leave `Newsletters` — and the one that
read **Newsletters › Recipes & food** lands somewhere a person would defend.

End-to-end, no API key:

```bash
LLM_PROVIDER=mock EMAIL_CLASSIFIER=mock GMAIL_PROVIDER=mock npm run dev:server
```

Then in the app: the map should show bulk mail collapsed and *not* inflating the
root unread badge, while an Evite and anything `to_do` sit at full weight.

**Prod check after deploy** (read-only; the same queries that produced this
diagnosis):

```sql
-- was the wedge cleared? every user should now have category rows
select user_id, count(*) from email_categories group by 1;
-- and threads should start classifying for the other three mailboxes
select user_id, count(*) filter (where classified_at is null) as unclassified
  from email_threads where is_archived = 0 group by 1;
```

Then watch for `llm classifier failed` disappearing from the logs — it currently
fires on every sync for two users.

## Risks

- **The wedge fix rewrites primary keys** that three tables reference. Prod holds
  48 category rows for one user, so the data volume is trivial, but the FK graph
  is not — the migration has to move `email_threads.category_id`,
  `email_message_categories.category_id` and the `parent_id` self-FK in one
  transaction.
- **`bulk` is a signal, not a verdict.** Every consumer must pair it with a
  second condition. The failure mode if that slips is silent and bad: an Evite
  or a school blast quietly demoted out of view.
- **Piece 1 alone is worth shipping first.** It is independent of the bulk work
  and unblocks 1,288 threads across three mailboxes.

Piece 6:

- **The first backfill after deploy is heavy and one-time.** `format=full` over
  `GMAIL_BACKFILL_DAYS` of history is roughly 50-100 KB per message instead of
  1-3 KB — for prod's 2,718 primary messages, ~200 MB in one pass rather than
  ~5 MB. It is bandwidth and wall-clock, not quota, but it lands on a small VM
  and should be watched on the first sync rather than discovered.
- **`extractBodies` may return no text.** Gmail's `format=full` yields real text
  only when the sender included a `text/plain` part. Most bulk senders do
  (multipart/alternative), but not all — and for those the excerpt is null and
  nothing improves. Worth measuring immediately after deploy: if the miss rate
  is material, an HTML-to-text stripper is needed for Gmail as well, which is
  also what unblocks Outlook.
- **Reading more of the email is not free of judgement.** A 2,000-character
  excerpt of a marketing email is mostly navigation and legal boilerplate; the
  first 2,000 characters are not necessarily the informative ones. If quality
  does not move, the honest next question is *which* 2,000 characters, not
  *more*.
- **This raises per-user cost roughly 4x** on the AI passes. Fine at present
  volume and worth re-checking against ADR 0079's trial economics before a
  larger audience, not after.

## Docs

**ADR 0109 — shipped** as `0109-bulk-is-how-mail-was-sent.md` (0106, 0107 and
0108 were taken while this plan sat; check the CLAUDE.md table for the next free
number before writing, and again before committing — another session numbers
ADRs too). Records the third axis and its precedent, the
strong-positive/weak-negative header rule inherited from the backlog, and the
four places the shipped code deviates from Piece 2's text.

**Piece 6 needs its own ADR** — it reverses a standing decision rather than
extending one. ADR 0060 made bodies lazy on purpose; this says the mirror must
fetch enough of the email for the AI passes to read, because two of them were
already written to read 2,000 characters and were being handed a padded
snippet. It should carry: the prod measurements above, the reason `body_text`
stays lazy while `body_excerpt` is eager (one writer each, so neither can show
a user truncated mail), the two-column bulk split and the ordering hazard that
forces it, and the cost table — a later reader deciding whether to raise the cap
needs the numbers that set it.

**Piece 7 rides in the same ADR.** It is the consequence of 6, not a separate
decision: once the inputs change, the mail classified under the old ones is
wrong and stays wrong. The durable point to record is that a prompt change now
has a **version to bump** rather than needing a migration, and that
reclassification is destructive by design — snapshot-replace means a worse pass
is not recoverable, which is why the drain rate is the safety mechanism.

Piece 5 rides in the same ADR as a second sender-derived signal, or gets its own
short one if 0108 is already long: the rule is that an unrepliable address is
proof nobody is waiting, and proof of nothing else.

Amend ADR 0066 with the wedge: its snapshot-replace design is sound, but the id
scheme made it single-user, which is worth recording where the next reader looks.

## Out of scope

- `Precedence: bulk` and `List-Id` as independent verdicts — captured and stored,
  used only as corroborators.
- Per-pass gating for attachment import / person extraction, which the backlog
  argues should hard-skip on bulk. Separate change, same new column.
