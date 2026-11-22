# Chord labels: your own filing, on every mailbox

> **Status.** Wave 2 shipped (ADR 0142, migration `063`). Wave 1 shipped
> (ADR 0141, migration `062`). Written 2026-08-26 for Adrian. Two waves.
>
> **Owner decision 2026-08-26: labels are usage-derived** — no `email_labels`
> table. See [Decided 1](#1-usage-derived-labels--decided). Don't re-open it
> mid-build; the migration depends on it.
>
> Numbers used: Wave 1 migration **`062`** / ADR **`0141`**; Wave 2 migration
> **`063`** / ADR **`0142`**.

## The ask

Two questions, and they have different answers:

1. **Can we give Outlook and IMAP Gmail-style labels that persist in Chord
   without syncing back?** Yes, and it's small.
2. **Can we also push a label *into* the mailbox?** Yes on all three, with one
   real limit on Outlook and a capability check on IMAP. It's a separate wave
   because it must never be what makes labelling work.

The order matters. If the push is built first, then labelling only works where
the push works, and a mailbox that refuses keywords has no labels at all. Local
first means every mailbox gets the feature, and the push is an enhancement that
is allowed to fail.

## Why this is not a violation of ADR 0107

[ADR 0107](../notes/0107-chord-reads-and-answers-gmail-manages.md) gave *managing*
to the provider — trash, star, snooze, move, folders, filters — because every
management verb is a **second writer** against a mailbox the provider also
writes, and the loser is whoever looks last.

A `Chord/<name>` label has exactly **one** writer. No Gmail filter sets it, no
other client touches it, and there is no provider-side value for ours to race.
That is the distinction, and it is the whole argument — not "labels feel
lightweight". If you find yourself extending this to a label the provider also
assigns, you are back in 0107's problem.

The nearest precedent is [ADR 0129](../notes/0129-snooze-is-a-mailbox-state-and-only-ours.md):
a real mailbox state, kept entirely on our side, with the folder sheet stating
plainly that the user's own mail app does not know about it. Copy that posture,
including the wording.

## The trap that decides the storage

The obvious move is to write the label into `email_threads.gmail_label_ids`.
Everything already reads that one column for every provider —
[`folderPredicate`](../../server/src/services/email/folders.ts:24),
[`labelPredicate`](../../server/src/services/email/folders.ts:53),
[`labelCounts`](../../server/src/services/email/labels.ts:50) — so it looks free.

It is silently inert. [`recomputeThread`](../../server/src/services/google/gmail.service.ts:261)
**overwrites** that column from the union of the thread's message labels, and it
runs after every sync, every mark-read, every archive. A Chord label written
there survives until the next tick and then disappears, with nothing logged.
Built-looking and gone — the failure mode this repo keeps writing ADRs about
(0128's inert swipes, 0107's silently-dropped labels).

So: a **second column** that `recomputeThread` never touches.

---

## Wave 1 — local labels, every mailbox

### 1.1 Storage — migration `061`

```sql
ALTER TABLE email_threads
  ADD COLUMN IF NOT EXISTS chord_label_ids jsonb NOT NULL DEFAULT '[]';
```

A Chord label's **id is its name**. Gmail's ids are opaque (`Label_17`) and need
an API round trip to resolve ([`gmailLabelNames`](../../server/src/services/email/labels.ts:70));
ours don't, which is what lets the two sets appear in one list with no second
lookup and no per-provider branch.

Store a normalized key alongside the display name if you want case-insensitive
identity — reuse [`listNameKey`](../../kernel/src/list-name.ts) rather than
inventing a second folding rule ([ADR 0094](../notes/0094-symmetric-list-name-resolution.md)
is about exactly this, and its addendum records the stemmer getting it wrong
once already).

No index to start. Add a GIN on `chord_label_ids` only if browsing gets slow —
the row count per user is small and the predicate is already `@>`.

Thread deletion cleans up for free: `recomputeThread` drops the row when the
last message goes, and a column on that row goes with it. A join table would
need its own cleanup — one of the reasons the owner call went to
[usage-derived](#1-usage-derived-labels--decided).

### 1.2 Predicates

`labelPredicate` becomes an OR over the two columns. Keep it in
`folders.ts` — browsing by label is the same shape as browsing by folder, which
is why [ADR 0125](../notes/0125-a-label-is-not-inside-a-folder.md) put it there:

```ts
export function labelPredicate(labelId: string, prefix = ''): Expression<boolean> {
  return sql<boolean>`(${has(prefix, labelId)} or ${hasChord(prefix, labelId)})`;
}
```

Crucially this keeps 0125's reach: a label query uses `searchablePredicate`, not
`folderPredicate`, so a labelled-and-archived thread is still findable. That
reasoning applies to Chord labels identically — arguably more so, since someone
labelling mail in Chord is filing it.

### 1.3 The list

`listBrowsableLabels` unions a second `jsonb_array_elements_text` rollup over
`chord_label_ids`. `isUserLabel` does not apply to ours (there are no system
Chord labels), and `gmailLabelNames` stays Gmail-only and untouched.

`EmailLabelRow` gains `scope: 'provider' | 'chord'`. This is not decoration —
see §1.6.

### 1.4 Write path

Reuse `POST /me/email/threads/modify` ([email.ts:858](../../server/src/routes/email.ts:858)),
adding `addChordLabels?: string[]` / `removeChordLabels?: string[]` to
`EmailModifyRequest` in kernel.

Applying a Chord label needs **no provider call at all**, so:

- It never reaches `applyGmailThreadModify` / `applyOutlookThreadModify` /
  `applyImapThreadModify`. Split it out *before* the dispatch in
  [`accounts.service.ts:637`](../../server/src/services/email-accounts/accounts.service.ts:637).
- The existing 422 at
  [accounts.service.ts:650](../../server/src/services/email-accounts/accounts.service.ts:650)
  stays exactly as it is. It is about *provider* labels and must keep telling
  the truth — do not soften it because Chord labels now exist.
- [ADR 0128](../notes/0128-a-bulk-action-is-still-one-write-per-thread.md)'s
  100-id cap exists to stop a batch fanning out into a thousand calls against
  the user's own provider quota. That reason does not apply here: labelling 500
  threads is one `UPDATE`. Keep the cap anyway for request-size sanity, but say
  in the code why it is a different cap, or someone will later "optimise" the
  provider path by the same reasoning and be wrong.

### 1.5 Client

`mobile/src/email-folder-sheet.tsx` already renders the browse list
(ADR 0125's long-press). Two additions:

- A section for Chord labels, visually distinguished, with the §1.6 line.
- Apply/remove from the thread view and from selection mode
  (ADR 0128's multi-select) — the two places a label is actually wanted.

Optimistic with a refetch as the correction, matching how archive already works
in ADR 0128. There is no round trip to a provider, so it will feel instant
regardless; the optimism is for consistency, not speed.

### 1.6 Honesty

A Gmail label round-trips; a Chord label does not. That difference is invisible
until someone opens Gmail on their phone and cannot find their label, which is
the worst moment to discover it.

The sheet says so, in ADR 0129's voice:

> **Chord labels** — these live in Chord. Your mail app won't show them.

Once Wave 2 ships for a mailbox, that line changes for *that mailbox only* —
which is why `scope` is a per-row field rather than a global banner.

---

## Wave 2 — push the label into the mailbox

Best effort, per provider, and never load-bearing for Wave 1.

| Provider | Mechanism | Scope we hold | Verdict |
|---|---|---|---|
| Gmail (primary + attached) | real labels — `users.labels.create` + `threads.modify` | `gmail.modify` ✅ | **Already built.** Reuse. |
| Outlook / M365 | `categories` string array on the message, `PATCH /messages/{id}` | `Mail.ReadWrite` ✅ | Works; colour needs a scope we won't ask for |
| IMAP (Yahoo/AOL/iCloud/generic) | keywords — `UID STORE +FLAGS (Chord/Family)` | n/a (app password) | Works **where the server allows it** — must be detected |

### 2.1 Gmail — already shipped, under another name

[`maybeSyncCategoryLabels`](../../server/src/services/google/gmail.service.ts:530)
already creates `Chord/<category>` labels and applies them, gated on
`users.gmail_sync_labels_enabled`. It pushes the *classification tile*, not a
user-chosen label, but `ensureLabel` + `applyThreadModify({ addLabelIds })` is
exactly the machinery Wave 2 needs. Factor the push out of that function rather
than writing a second one — two copies of "make sure this label exists and put
it on this thread" is the ADR 0085/0127 hazard.

Note the existing `.where('email_threads.account_id', 'is', null)` — that
function is primary-Gmail only. A secondary Gmail account speaks the full label
API too ([ADR 0080](../notes/0080-multi-account-email-providers.md) addendum,
and `applyGmailAccountThreadModify` already handles `addLabelIds`), so the
extracted helper should take an account rather than assume the primary.

### 2.2 Outlook — categories, uncoloured

Graph exposes `categories: string[]` on a message. Setting it needs
`Mail.ReadWrite`, which
[`outlook-oauth.ts:31`](../../server/src/services/email-accounts/outlook-oauth.ts:31)
already requests. So the write works today with no re-consent.

The limit: a category that is not in the mailbox's **master category list**
displays without a colour. Creating a master category needs
`MailboxSettings.ReadWrite` — a scope we do not hold, and asking for it means a
re-consent prompt for every existing Outlook user to buy a colour swatch. Don't.
[ADR 0130](../notes/0130-an-alias-is-only-offered-once-verified.md) checked
whether a feature needed a new scope before designing around one, and
[ADR 0124](../notes/0124-the-vacation-responder-is-ours.md) declined a feature
precisely because the scopes cost more than the feature was worth. Same test,
same answer.

Categories apply **per message**, not per conversation. Applying a thread label
means patching every message in the thread — same loop
`applyOutlookThreadModify` already runs.

### 2.3 IMAP — keywords, capability-gated

IMAP keywords are custom flags. Support is genuinely optional per RFC 3501: a
server advertises `\*` in `PERMANENTFLAGS` on SELECT to say it will store
arbitrary keywords. imapflow surfaces this on the mailbox object from
`mailboxOpen`.

So: **detect, store, and only then offer**. Do not try the STORE and see what
happens — a server may accept the command and not persist the flag, which is
the ADR 0107 failure again (a write we did not really perform, reported as
performed).

Two constraints that are not optional:

- **One connection.** `ImapApi`'s per-method connections were the
  [ADR 0080](../notes/0080-multi-account-email-providers.md) incident — a
  mass-archive fired one login per message into exactly the metric Yahoo
  throttles. A bulk label apply is the same shape. Write it as a batch method
  on `imapApiOn(auth, conn)` taking all UIDs at once, like `findInTrash` and
  `setSeen` already do, and run it inside `withImapSession`.
- **Keyword syntax.** IMAP atoms disallow spaces and several specials. Encode
  the label name into a safe atom (`Chord/Family` is fine; `Chord/School stuff`
  is not) and decide the encoding once, in kernel, with tests — the same reason
  ADR 0120 and 0121 put their string logic there rather than in `mobile/`.

### 2.4 The account row declares what it can do

Add a capability to the account (`email_accounts`, and the primary Gmail's
equivalent) recording whether label push is available, probed at connect and
re-probed on reconnect. The UI offers the push switch only where it is true.

This is [ADR 0116](../notes/0116-parity-is-what-a-mailbox-can-do.md)'s rule
applied literally: parity is about what a mailbox can **do**. An IMAP host that
refuses keywords is not a bug to work around, it is a real state — the same
posture as `listSentWindow` returning null rather than guessing a folder name.

### 2.5 Never pull the label back

The push is one-way. Do **not** read categories/keywords back into
`chord_label_ids` on sync.

The moment we read them back, Chord's label has two writers again and we are in
ADR 0107's problem — a label removed in Outlook silently un-files a thread in
Chord, or worse, a sync race makes it flicker. One-way keeps the single-writer
property that made this safe in the first place.

If a user removes the category in Outlook, the Chord label stays and the
mailbox loses the tag. That is the honest, boring outcome, and it should be the
one sentence the push switch says about itself.

---

## Decisions

1 is answered. 2–4 are still open, but none of them blocks Wave 1 — they can be
settled while it is being built.

### 1. Usage-derived labels — **decided**

> **Decided 2026-08-26 (owner): usage-derived.** No `email_labels` table.
> The label set is whatever appears in some thread's `chord_label_ids`, exactly
> as `listBrowsableLabels` already derives the provider list from the mirror.

What this buys, and what it costs — stated so nobody has to rediscover it:

- No second store to keep consistent, and nothing to clean up when a thread is
  deleted (the column dies with the row).
- A label with nothing under it **does not exist**. There is no "create a
  label" step — you type a name onto a thread, and removing it from the last
  thread removes the label. The UI must not imply otherwise: no empty-state
  "your labels" screen, no create button.
- **Rename is out of scope for now.** It would be a mass jsonb update across
  the user's rows. Don't half-build it.
- Nowhere to hang a colour. Distinguish Chord labels from provider ones by the
  `scope` field (§1.3), not by colour.

Consistent with ADR 0108's "a folder is a predicate, not a column" and ADR
0125's "derive it from the mirror" — both of which declined a second source of
truth for the same reason.

**Revisit when** someone asks to rename a label or wants one to persist while
empty. That is the trigger; until then, a table is a store with no reader.

### 2. Is the push on by default?

`gmail_sync_labels_enabled` defaults to **0** — the existing precedent is
opt-in. Recommend matching it: default off, one switch per mailbox, worded as
what it does ("also tag these in Outlook") rather than as a sync.

### 3. Does `label:` join the search operators?

Natural, and [ADR 0126](../notes/0126-an-operator-is-a-question-only-mail-can-answer.md)
already built the parser. If yes, it must land on **both** search paths in the
same change — that is exactly the two-copies-of-a-predicate hazard
[ADR 0085](../notes/0085-one-search-matching-rule.md) exists to prevent and
[ADR 0127](../notes/0127-a-gate-needs-two-signals-agreeing.md) pinned with a
parity test. Follow-on, not Wave 1.

### 4. What does a failed push do?

Recommend: the local label still applies, the failure is logged, and the row
shows the label as Chord-scope. **Not** a refusal — the local label is the
feature and the push is the extra. This is the one place the plan deliberately
diverges from ADR 0107's "refuse rather than silently drop", because nothing is
being misreported: the label genuinely applied, in Chord, which is what the
scope marker says.

---

## Tests worth writing

- **`recomputeThread` does not clear `chord_label_ids`.** The whole reason for
  the second column; assert it directly after a sync, or the next refactor
  quietly reintroduces the bug.
- **A Chord label browses across folders** — labelled + archived is still
  reachable (ADR 0125's actual point).
- **Label push is not required.** A mailbox with push disabled still applies
  and browses labels.
- **IMAP keyword capability false ⇒ no push attempted**, and the label still
  applies locally.
- **Bulk apply is one connection / one UPDATE.** Pin the login count against
  the faked `imapflow`, the way ADR 0080's tests do — that is the only thing
  that stops the per-item-call-in-a-loop regression.
- Watch for the vacuous-fixture trap from
  [ADR 0128](../notes/0128-a-bulk-action-is-still-one-write-per-thread.md): a
  thread with no messages is **deleted** by `recomputeThread`, so a fixture
  must insert a message and the test must assert the row count before the
  predicate.

## Explicitly not doing

- **Reading provider categories/keywords into Chord labels** (§2.5).
- **Asking for `MailboxSettings.ReadWrite`** to colour Outlook categories (§2.2).
- **Chord-side filters that auto-apply labels.**
  [ADR 0123](../notes/0123-a-rule-says-where-mail-goes.md) already decided this
  space: a rule says which *group* mail belongs to, and every other filter verb
  is filing, which is the provider's. An auto-labelling rule is a filter.
- **A Gmail-only version.** ADR 0116's rule cuts the other way here — adding a
  Chord label is something every mailbox can do precisely because it does not
  touch the mailbox, so there is no reason for Gmail to be the only one that
  has them.

## Write the ADR first

Per CLAUDE.md: the decision space here has real alternatives (second column vs
join table; local-only vs push; derived vs stored labels; one-way vs two-way),
so ADR `0138` should exist before the code. The three load-bearing sentences it
needs to contain:

1. A Chord label is safe to push because it has exactly **one writer** — that
   is what distinguishes it from every verb ADR 0107 gave to the provider.
2. It lives in its **own column** because `recomputeThread` owns the other one.
3. The label set is **derived from usage**, so a label with nothing under it
   does not exist — and the rejected alternative (an `email_labels` table) is
   what rename and colour would need, which is the trigger for revisiting.
