# Email reader — bugs & backlog

Raw capture (2026-07-14). Promote items into `email-reader-plan.md` / the F&F
release doc once scoped. UI lives in `mobile/app/email/index.tsx` +
`mobile/src/email-tiles.tsx`; tile data from `classification.service.ts`
(`getTiles`), taxonomy from the classifier (mock: `mock-classifier.ts`).

> **Status (2026-08-28 triage):** Bugs section closed. Backlog **3 / 4 / 11**
> shipped (see below). Item **13** is exploratory product candidates — not a
> bug queue. Open email work now lives in [`chord_email.md`](./chord_email.md)
> and the parity / labels plans, not here.

## Bugs

1. **Front tiles should surface subtiles directly, not a nested drill-down.**
   ✅ **Done — superseded by ADR 0068** (landed after this capture). The
   persistent two-level treemap (`tiles?deep=1`) renders every parent as a
   colored region with its children nested inside as directly-tappable
   subtiles on the front view (`ChildBox` in `mobile/src/email-tiles.tsx`);
   tapping one slides a bottom sheet over the map, and the sheet's ✕ / scrim
   tap is the back affordance — there is no drill-down navigation left to
   descend into. Regions too small to nest fall back to preview lines with
   the same one-tap sheet.
   **Addendum (ADR 0083, 2026-07-31):** the sheet now opens **decisions**
   (batched pending proposals) for that tile; thread list is a sources
   footer. Badge / area follow open decision count, not unread attention.

2. **No hallucination in the AI tab — ever.** ✅ **Done (2026-07-17).** Both
   seams are now guarded:
   - *Unknown thread ids:* already handled — `ingestClassification` maps
     assignments through a user-scoped `gmail_thread_id → email_threads.id`
     lookup and **skips** unknown ids (counted as `skippedUnknownThreads`,
     asserted in `classification.service.test.ts`), so classifier output can
     never render a thread that wasn't really synced.
   - *Mock → real leak:* fixed — migration `028_gmail_mirror_provider` adds
     `users.gmail_mirror_provider`; `ensureMirrorProvider` (called from both
     `backfillGmail` and `syncGmailIncremental`) wipes the local mirror via
     `disconnectGmail` whenever the stored provider differs from the current
     `GMAIL_PROVIDER`, so mock fixture threads are dropped before a real
     sync ever runs (and vice versa). FK cascades clear messages +
     assignments with the threads. Test:
     `gmail-mirror-provider.integration.test.ts`.
   Mirrors the bot's honesty gating (ADR 0050): never present content without
   a real underlying artifact.

5. **Mobile: tapping a magic-proposal card's Add / ✕ does nothing (2026-07-17).**
   ✅ **Closed 2026-08-24 — no longer reproducible** (owner). Closed *unfixed*:
   no change was ever made for this, so it was either environmental or
   something shipped since resolved it incidentally. The investigation below
   stands as the starting point if it returns.
   On mobile, neither accept nor dismiss resolved the docked suggestion card —
   reported as "clicking on proposal doesn't dismiss it, so not working."
   Investigated (2026-07-17), wiring is intact at every layer: `MagicCard`
   (`mobile/src/email-magic.tsx`) calls `confirmProposal` / `rejectProposal`,
   both call sites pass `onDismissed` (`mobile/src/email-tiles.tsx`,
   `mobile/app/email/[threadId].tsx`), and in **neither** surface is the card
   nested inside another `Pressable` (sheet row: sibling of the row press;
   thread view: direct child of the ScrollView) — so tap interception is
   unlikely. Remaining suspects, needs device repro watching the network:
   - the API call failing on device (auth header / URL base / proposal 404,
     e.g. an expired 72h-TTL proposal) — which lands in the `failed` state
     ("Failed — see Catchup") rather than "nothing", or
   - the report referring to a *different* proposal surface — the briefing
     card in chat or the To Do's Action Items rows (both just shipped in
     e3b1208) — whose confirm/reject path should be checked the same way, or
   - accept "working" but looking inert: accept deliberately keeps the card
     visible as "✓ Added"; only ✕ removes it. If that's the confusion the fix
     is UX (collapse/fade the accepted card after a beat).
   Was not fixable blind, and the repro never came — the owner now reports the
   behaviour is gone. If it comes back, those three suspects are still the
   list, and the request log is still what settles it.

6. **Calendar-time-request emails produce the wrong to-do — harden the magics
   prompt substantially (2026-07-17).** ✅ **Both halves done (2026-08-24).** When an email asks for time on the
   calendar ("can we meet next week?"), the extracted to-do comes out as
   "give this person time" — an action phrased from the *sender's* point of
   view. The right to-do is user-centric and grounded in the user's actual
   calendar: **check my calendar for what works → include the concrete
   available slot(s) in the suggested to-do** ("Reply to X with times — Tue 2p
   or Thu 11a look free"). Two parts:
   - **Prompt hardening** — ✅ **done (2026-07-17)**: `EXTRACT_SYSTEM` in
     `magics.service.ts` now requires every suggestion to be an action the
     RECIPIENT takes (never a restatement of the sender's ask), restricts
     `event` to already-CONFIRMED slots, and routes meeting/time requests to
     a "To-dos" list item ("Reply to <sender> with times that work for …").
     Prompt-only change — behavior needs a real-LLM spot check, the mock
     path is unaffected. That caveat now covers the availability half too: the
     slots are computed deterministically and tested, but whether the model
     *uses* them well is a real-LLM check.
   - **Availability grounding** — ✅ **done (2026-08-24)**, as wiring rather
     than new sync, exactly as scoped. The ADR 0088 world-context block now
     carries a "Times the user appears FREE" line, and the prompt names one or
     two of them **only** in the reply-with-times to-do, as candidates the user
     still confirms.
     Loaded once per pass alongside the rest of the snapshot, so it costs one
     query for a whole batch rather than one per thread.
     - **No follow-up pass, no per-thread window.** The requested window isn't
       known until the model has read the mail, so a targeted lookup would mean
       a second LLM round trip per thread. A fixed 12-day forward window is one
       shared query and still covers "next week" asked on a Friday.
     - **Busy means what `find_conflicts` means.** New
       `busyIntervalsInWindow` is a *sibling* of `computeConflicts`, not a call
       to it — that one caps at 100 rows for a single slot and can't report
       hitting the cap, and a free/busy answer that silently lost rows would
       offer a time the user is busy. The predicates that must not drift
       (`eventBlocksTime` for ADR 0033 block-vs-informational,
       `computeTransparency` for all-day / <5-min / "show me as free",
       `effectiveEndMs` for ADR 0040's 1h default) are the same helpers.
     - **Unknown and empty look identical.** A truncated scan returns **no**
       slots rather than partial ones, and the block is simply absent — the
       prompt then forbids inventing availability. A half-read calendar
       offering a slot is worse than offering none.
     - Bookable hours are 09:00-18:00 in the user's own zone (every calendar is
       free at 3am, which is not an answer), minimum one hour, at most one slot
       per day and five overall, and nothing inside a 24h lead — a reply
       proposing a time two hours out reads as a mistake.
     - `zonedDayStartUtc` moved from `email/summary.service` to `utils/tz`
       once a second caller needed it; the old name is re-exported.
     Tests: `magics-context.test.ts` (pure slot arithmetic incl. the lead
     window and the end-of-day edge), `busy-intervals.integration.test.ts`
     (all-day, info-only calendars, other users' calendars).
   *(cf. ADR 0063 magics, ADR 0068 suggestion docking.)*

9. **A badge can fall without the email being marked read (2026-08-17).**
   ✅ **Fully closed 2026-08-24.**
   Stage 1 made the tile badge a count of open decisions (ADR 0083), so the
   badge and the thread's read state now have to agree about whether something
   was dealt with — that agreement is the whole reason decision counts replaced
   unread (design doc §3.2). Confirm and reject already hold it:
   `markEmailSourcesRead` fires at all three commit/reject sites in
   `proposals.service.ts` → `markSourceThreadsRead` in `email/thread-read.ts`.
   Three other paths clear a pending proposal — dropping the badge — and none
   touch read state:
   - **Convergence retractions — this was the reported bug.** ✅ **Fixed.**
     `retractProposalsCoveredByExistingEvents`,
     `retractPendingEmailEventProposalsNear` and `retractPendingProposalsByUid`
     fire when a real calendar item already covers the slot or an invite is
     cancelled. The obligation *is* satisfied, so all three now mark the source
     read through `markSourceThreadsRead` — reached by a dynamic `import()`,
     since `event-convergence` is a db-only leaf and `thread-read` runs back
     into `gmail.service`, which reaches here again through the magics pass.
     Each retraction needed the proposal's **provenance**, which
     `pendingEmailEventProposals` wasn't selecting; it is now.
     The mark deliberately sits in the three callers and **not** inside
     `expireProposals`, which consolidation shares: collapsing duplicates
     doesn't satisfy an obligation, it re-homes it onto the surviving card, and
     the losing thread's mail is still unread for a reason. That boundary is
     asserted, not just intended — `proposal-marks-source-read.test.ts` covers
     both retraction paths **and** the consolidation case that must leave both
     threads bold.
   - **`expireStale` (72h TTL)** — ✅ **DECIDED (2026-08-24, owner): "expired,
     still owed."** Nobody decided anything, so marking read would be a lie; but
     silently un-badging an unhandled obligation is the failure §3.2 exists to
     prevent. Rejected: keeping the badge (it would claim a decision is still
     available when the proposal is gone) and re-staging (a suggestion nobody
     wanted for 72h does not improve by being asked again).
     Shipped as `coverage.stillOwed` on `GET /me/email/decisions`, rendered in
     the honesty footer beside "handled today" / "I couldn't read".
     **The discriminator is read state, not a new column** — and that only works
     because of the invariant the rest of this bug established. Three paths
     write `expired`, and the other two exclude themselves for free:
     convergence retractions now mark the source read (the obligation really
     was met), and `retractByProvenance` fires when the source was trashed,
     which archives it. What remains is a timeout nobody acted on.
     A thread the user **read** but never decided on is deliberately not
     counted: they saw it and chose not to act, and nagging past that is how a
     counter earns being ignored. A thread with a live decision is excluded
     too — that one is already badged.
     Tests: `still-owed.test.ts`, which pins the exclusions as much as the
     count.
   - **`retractByProvenance`** — source trashed or deleted; nothing left to
     mark. Correct as-is (ADR 0073).

   Invariant to hold: **badge count and read state must never disagree about
   whether a thread was dealt with.**
   *(cf. ADR 0083 Stage 1 shell, ADR 0073 delete/archive convergence,
   ADR 0074 invite reconciliation, design doc §3.2.)*

10. **A to-do from email should mark its source read when it's resolved —
   DECIDED (2026-08-21): yes, and it already does for both user actions.**
   The rule: an email whose only claim on the user was an obligation stops
   claiming anything the moment that obligation is settled — acted on *or*
   dismissed. Dismissal is a decision, not an omission; leaving the mail bold
   after it re-litigates the same thread every time the mailbox opens.
   Verified where it holds today: `confirmProposal` (single, line 516; bundle,
   602) and `rejectProposal` (654) all call `markEmailSourcesRead` →
   `markSourceThreadsRead` (`email/thread-read.ts`), which resolves the
   `gmail:<threadId>` provenance back to the thread and issues a real
   `markRead` through the provider. Every surface that resolves an action item
   — the tile decision sheet, the thread-view docked card, the To Do's Action
   Items rows (ADR 0070) — goes through those same two routes, so all three
   inherit it.
   Nothing further is owed for the *later* lifecycle: confirming a proposal
   marks the thread read at confirm time, so completing or deleting the created
   task days later has no source left to settle.
   What remains open is the machine-driven residue already captured in bug 9 —
   convergence retractions (should mark read; the obligation really is
   satisfied) and `expireStale` (should *not*, and needs the product decision
   about whether the badge may drop at all). Recorded here so the rule is an
   invariant rather than an accident of three call sites:
   **anything that clears a pending proposal must decide, explicitly, whether
   the source thread was dealt with.**
   *(cf. bug 9, ADR 0086 action axis, design doc §3.2.)*

12. **One email becomes several Action Items rows (2026-08-24).** Not one bug —
   a flat surface plus four independent multipliers, none of which knows about
   the others. ✅ **All fixed 2026-08-24.**

   **The surface does no grouping.** ✅ **Fixed.** `ActionItemsSection` took
   every pending `gmail:` proposal and rendered `pending.map(p => <ProposalRow/>)`
   — no clustering at all — so one email read as a pile of unrelated demands.
   Rows from one thread now sit under a card headed by the email's **subject**,
   tapping through to the thread. `clusterProposalsBySource` lives in
   `kernel/src/proposal-cluster.ts` (ADR 0094's precedent: the shared rule goes
   in kernel so it is testable and a second surface can reuse it), and the
   server carries the subject as `Proposal.sourceLabel`, computed per viewer in
   the `attachSourceHrefs` query that already resolved the thread.
   Three rules the implementation holds to:
   - **A view, never a write.** ADR 0094's rule for the Lists tab.
   - **Clustering is NOT bundling.** An ADR 0029 `bundleId` means "these must
     resolve together"; these are independent decisions that merely share a
     source, so each keeps its own confirm/reject and its own ADR 0097 group
     choice. Reusing `bundleId` would silently widen one tap into several.
   - **A lone proposal gets no card.** Chrome appears only where it earns its
     place — the row already taps through to its own email.
   Order is preserved (clusters in first-appearance order, members as given),
   and a proposal with no provenance is its own cluster: two chat-born
   proposals are not "from the same place" just because neither names one.

   **Found while verifying the render:** `describeProposal` had no case for
   `add_person` or `add_important_date`, so every ADR 0076 proposal in Action
   Items displayed as its bare tool name. "add_person" is not a decision anyone
   can make — it doesn't say who. Both now render a sentence, and a
   `0000-MM-DD` recurring date shows as "Sep 18 (every year)" instead of
   leaking the zero year. The enum `kind` is humanized too ("other for Mrs.
   Chen" → "Important date for Mrs. Chen").

   **Multiplier 1 — two passes mine the same thread and stamp the same
   provenance.** `afterSync` runs `runEmailMagics` then `runPersonExtraction`,
   and both write the same `gmail:<threadId>` string. Magics contributes at
   most one (`extractor.extract` returns a single `EmailSuggestion | null` —
   event **or** list, `magics.service.ts:443-488`). Person extraction
   contributes N people × (1 + M dates), all separate rows. A school note
   naming three teachers with a picture-day date is 1 + 3 + 3 = **seven rows
   from one email**.

   **Multiplier 2 — the propose branch is uncapped.** ✅ **Fixed.**
   `BOOTSTRAP_PERSON_CAP` (12) guarded **only** the bootstrap auto-write path,
   so the `else` branch that stages proposals had no cap: a thread mentioning
   twenty names staged twenty rows. New `THREAD_PERSON_CAP` (5) bounds what one
   thread may yield, logged when it truncates. The two caps measure different
   things — one bounds a whole pass's auto-writes, the other one thread's
   proposals — so the new one is a sibling, not a replacement.

   **Multiplier 3 — dates have no pending-dup check.** ✅ **Fixed.**
   `add_person` was guarded by `hasPendingPersonProposal`; nothing guarded the
   dates, so two emails mentioning the same unknown person's birthday produced
   one person row and two date rows. New `hasPendingDateProposal` screens each
   date at both staging sites — the unknown-person branch **and** the
   known-person one, which deduped against dates already *created* but not
   against dates already *proposed*.
   Correcting this entry's first prescription: it said to move the date loop
   inside the person guard. That is wrong. A person pending from an earlier
   thread can still be the subject of a genuinely new date here, and skipping
   the dates with their person would lose it. The dates are screened one by
   one instead. Identity is person + kind + **month/day**, ignoring the year:
   an unknown year arrives as `0000-MM-DD` (ADR 0076), so a birthday read once
   without a year and once with one must still collapse.

   **Multiplier 4 — consolidation covers half the tool surface.** ✅ **Fixed.**
   The magics sweep heals duplicate `create_event` and `add_list_item`; there
   was no equivalent for `add_person` or `add_important_date`, so multiplier 3's
   output was permanent until someone tapped it. `consolidateDuplicatePerson` /
   `DateProposals` join them in `event-convergence.service.ts` (the leaf module
   that already hosts the list-item arm and owns `expireProposals`), swept at
   the end of `runPersonExtraction`.
   The sweep deliberately runs **before** the no-new-threads early return,
   unlike the rest of the pass: the rows it exists to clean up are already
   sitting in Action Items, and gating it on new mail would never reach a user
   whose mailbox is fully mined — which is every affected user today.

   **Multiplier 5 — the same mail in two mailboxes mines twice.** ✅ **Fixed.**
   ADR 0080 stores provider ids **account-prefixed**, and
   `email_extraction_marks` is keyed on `gmail_thread_id`, so one message
   delivered to two of the user's own addresses was two threads, two marks and
   two proposal sets.
   **Owner decision (2026-08-24): one thing.** "More likely than not someone is
   cc'ing the same person. We know we have seen the email, we move on." Being
   on two of your own addresses is ordinary; it is not two obligations.
   `crossAccountMarkQuery` makes the AI passes ask "have we mined this
   **message**", not "this account's copy of it". The key is
   `email_messages.rfc822_message_id` — RFC 5322 makes it globally unique, it
   belongs to the message rather than the mailbox, and **all four providers
   already store it** (Gmail's `Message-ID`, Graph's `internetMessageId`,
   IMAP's parsed `messageId`), so no new capture was needed — only migration
   `044`'s index to keep the join cheap.
   - **Any message, not the whole set.** Two mailboxes cc'd on one conversation
     need not hold identical message sets; once the conversation is read we are
     done with it, which is what the once-ever mark already means.
   - **A missing id degrades, never over-collapses.** SQL never joins NULL to
     NULL, so a message without an RFC id simply falls back to the per-thread
     mark. Cheaper to re-mine one thread than to merge two unrelated ones.
   - **Per owner.** The join is scoped to the user, so two people cc'd on the
     same message each get their own suggestions.
   - The saving is the **LLM call**, not just the row: the skip happens at
     selection, before extraction.
   Existing duplicate proposals need no backfill — the consolidation sweeps
   above already collapse them, since two extractions of one message produce
   identical content.
   Tests: `cross-account-dedup.test.ts` (both passes, plus the three
   must-not-collapse cases).

   Note what is **not** the cause: re-mining. `markThreadExtracted` fires
   once-ever per (user, thread, kind) and marks are never deleted (ADR 0092),
   so a growing thread is mined exactly once.

   **Note for whoever touches the AI passes next:** the ADR 0074 invite probe
   runs BEFORE extraction and defers the thread on an API error, so a pass with
   no usable Gmail provider mines nothing at all and marks nothing. That is
   correct in prod and a trap in tests — `cross-account-dedup.test.ts` sets
   `GMAIL_PROVIDER=mock` for exactly this reason.
   *(cf. ADR 0070 Action Items, ADR 0076 person extraction, ADR 0029 bundles,
   ADR 0094 clustered cards, ADR 0092 once-ever marks.)*

13. **The same to-do, restated with padding, becomes two cards (2026-08-24).**
   ✅ **Fixed.** Reported from a live briefing:

   > ✨ Decide whether to sell or use US Open Day Session (Arthur Ashe) tickets
   > for Sun, Aug 30, 12:00 PM → To-dos
   > ✨ Decide whether to sell or use US Open Day Session (Arthur Ashe) tickets
   > for Sun Aug 30 12:00 PM **and take action accordingly** → To-dos

   Not the bug 12 family — those were `add_person` / `add_important_date` from
   person extraction. These are `add_list_item` from magics, which *already*
   had a staging guard **and** a sweep. Both missed, because list-item identity
   is exact normalized equality of list + item text (`isSameSuggestedListItem`).
   The comma difference collapses under `normalizeTitle`; the trailing clause
   does not. Two threads (a thread is mined once ever, and magics emits at most
   one suggestion per thread) — the original mail and a reminder.

   **Not fixed by loosening the match.** Containment would have caught this, and
   it is excluded on purpose: "buy milk" is a prefix of "buy milk and eggs".
   The distinguishing fact isn't structural — it's that "and take action
   accordingly" carries **no content** the action doesn't already state.

   So the text is canonicalized instead, and the tight rule stays tight.
   `stripFillerTail` drops a trailing clause that needs BOTH a conjunction and a
   terminal "accordingly" / "as appropriate" — a shape no real to-do ends with.
   Applied twice: in `parseSuggestion`, so what gets stored is clean, and inside
   `isSameSuggestedListItem` + the sweep key, so the cards **already staged**
   collapse on the next pass rather than needing a backfill. It lives in
   `event-convergence.service.ts` beside `normalizeTitle`, which owns the other
   identity rules.

   Prompt hardened too — `EXTRACT_SYSTEM` now forbids the padding outright. The
   deterministic strip is the belt: ADR 0100 already established that a prompt
   instruction alone isn't enough (the timezone precedent needed
   `normalizeDatetimes` as well as a STRICT description).

   Tests: `magics.service.test.ts` (strip + the negative cases that must survive
   it), `proposal-consolidation.test.ts` (identity, and the retroactive heal).
   *(cf. bug 12 multipliers, ADR 0063 magics, ADR 0100 prompt-plus-code.)*

## Backlog

3. **Action / calendar / list field on email items.** ✅ **Shipped (2026-08-28
   triage).** The extraction side was already magics; the UI surface landed
   across three places: thread view pins `MagicCard` confirm/dismiss
   (`mobile/app/email/[threadId].tsx`), tile tap opens batched decisions
   ([ADR 0083](../notes/0083-email-stage-1-shell-decisions-on-tiles.md)), and
   the To Do's Action Items hub lists pending `gmail:` proposals
   ([ADR 0070](../notes/0070-todos-hub-action-items-first.md)). Magics also
   dock beside email rows ([ADR 0068](../notes/0068-attention-weighted-email-map.md)).
   Original ask kept below for context: a fillable field on a tile/thread that
   turns mail into structured follow-through (task / calendar / list item).

4. **Proposal acceptance — DECIDED (2026-07-14): surface in the morning
   briefing.** ✅ **Shipped.** `buildPendingProposalsSection` folds unaccepted
   proposals into the daily morning scan (`proactive.service.ts`; gmail magics
   skipped when the email digest section already listed them). Covered by
   `proposal-briefing-section.test.ts`. No auto-accept — consistent with D1/D8;
   briefing is the consented surface (ADR 0034). Email-view UI is item 3
   (also shipped). Options considered at decision time: (a) confirm-only
   (rots unseen), (b) proactive surface + explicit accept ← chosen, (c)
   auto-accept high-confidence (rejected).

7. **F&F-classified email → to-do offers "send to <family member>" (2026-07-17).**
   ❌ **Dropped 2026-08-24 (owner): not needed.** Kept as a record of what was
   considered and declined, so it isn't re-proposed. ADR 0097 covers the real
   need — a confirm already picks its target group — and a share-with kind
   would have added a second consent shape for the same intention.
   Original design question: when a thread classifies as friends-and-family (or the
   magics group-matcher already resolves it to a shared family group), should
   the suggested to-do include a share/forward action — "send to Alice" /
   "share with the Doe family group"? The pieces exist: the group matcher in
   `magics.service.ts` already picks a target group per suggestion, pair
   groups + `message_user` (ADR 0067) can deliver to a specific person, and
   contact resolution (ADR 0065) maps names to users. What's missing is a
   *share-with* suggestion kind (or an extra affordance on the existing card)
   and the consent posture — sharing email-derived content into a shared
   group must stay owner-confirmed (D8: no unconsented writes), so this is an
   opt-in tap, never automatic. Decide whether it's a new proposal kind or a
   button on the accepted entity ("also post to <group>").

8. **Delete/archive convergence — DECIDED + shipped (2026-07-18,
   [ADR 0073](../notes/0073-email-delete-archive-convergence.md)).** Owner
   rule: deleted or archived mail shows up nowhere; the flow is email →
   proposal → accepted/rejected; deleting the email before the decision
   kills the proposal; anything accepted before the delete stays. Shipped:
   archived/trashed mail filtered from every listing surface (incl. the
   category tile sheet, which previously leaked it); whole-thread trash or
   permanent delete retracts pending magics (`retractByProvenance` →
   `expired`; decided proposals + created entities untouched; plain archive
   keeps the proposal); full re-backfill reverse-deletes absent in-window
   messages so deletes during a stale-sync-token gap converge. Latency:
   one sync (≤5 min in use, else next open/briefing).
   Tests: `email-delete-convergence.integration.test.ts`.

11. **Keep mass/marketing mail out of the AI passes — it should not be
   extracted, proposed on, or indexed (2026-08-21).** ✅ **Shipped as
   [ADR 0127](../notes/0127-a-gate-needs-two-signals-agreeing.md)** (deny-list;
   skip only when header `bulk` **and** classifier `bulk_inferred` agree;
   `action` / `people.email` / Events & invites override; `EMAIL_BULK_GATE`
   flag). Owner answers recorded in `email-owner-decisions.md`. The analysis
   and "Open — ADam to decide" section below are kept as the record that led to
   the ADR — do not re-open those ten questions mid-build.

   Most retailer, newsletter and promotional mail is not worth an LLM call,
   and worse, its *artifacts* leak into surfaces meant for the user's own
   material. Three concrete leaks at capture time:
   - **Attachment import has no sender filter at all.** `shouldImport`
     (`email/attachment-import.ts`) screens on size, mime and `.ics` only —
     a retailer's >20 KB banner image or a promo PDF is saved into the personal
     group through the normal `saveFile` pipeline and picked up by extraction
     + FTS, so it is then reachable from search and `send_file`. The 20 KB
     `MIN_IMAGE_BYTES` floor was aimed at signature logos and does not stop a
     hero image. **This is the "their images get indexed" complaint and the
     cheapest fix of the three.**
   - **Magics runs on everything classified — and being *recognised* as bulk
     is what gets a thread in.** The selection (`magics.service.ts:306-310`)
     filters on already-marked / archived / `category_id IS NOT NULL` and
     nothing else. A LinkedIn thread never reaches the LLM at all:
     `deterministicPathFor` (`llm-classifier.ts:107`) routes it to
     `Social & professional → LinkedIn` under a comment calling these
     "unmistakable bulk senders" — and that routing **assigns the category**
     that admits it to action-item staging. `from_email` is already selected
     in the same query (`:302`) and dropped. This is the "LinkedIn updates in
     my Action Items" complaint, and the verdict needed to stop it is already
     computed.
   - **Person extraction skips by a pattern that measures the wrong thing.**
     `NOREPLY_RE` (`person-extraction.ts:46`, used only at `:297`) plus the
     `deterministicPathFor` domain list. The problem isn't that it's narrow —
     it's that **`no-reply` identifies automation, not mass**, and the two axes
     are independent. Defensible where it sits (person extraction mines people
     and family facts; a bank alert has none), and wrong the moment it is
     generalised to the other two passes. See the no-reply block below.

   **Before any of that: two verdicts already exist, and the passes don't ask.**

   | pass | honours `deterministicPathFor` | honours `action` | uses category |
   |---|---|---|---|
   | attachment import | no | no | no (selects `email_messages`) |
   | **magics** | **no** | **no** | only `IS NOT NULL` |
   | person extraction | **yes** (`:297`) | no | no |

   Person extraction already has the exact check magics lacks, and a regression
   test for it (`person-extraction.test.ts:191`, `jobs-noreply@linkedin.com`).
   Two consequences worth having on the table before picking a rung:
   - **`SENDER_PATHS` is not one list — it's two disjoint halves**, and the
     split is already encoded in its own path values.
     `Social & professional` holds linkedin, indeed, glassdoor, ziprecruiter,
     facebookmail, instagram, nextdoor, redditmail, pinterest, x — **ten
     domains, none of which ever carries a family action item**.
     `Events & invites` holds evite, paperlesspost, punchbowl, eventbrite,
     meetup — **five, and exactly the actionable kind**. ADR 0088 rejected a
     sender-domain skip *because of the second half*; a **path-prefix** check
     preserves it exactly. 0088 closed this door on a question it wasn't asked.
   - **`action` is a second unconsulted verdict.** `email_threads.action`
     (`schema.ts:991`, ADR 0086) is judged in the same call, explicitly
     independent of the path, and the prompt files newsletters under
     `informational` ("worth reading, nothing to do"). Magics doesn't select
     the column — so a thread the classifier already judged *nothing to do*
     goes on to stage a to-do anyway.

   Neither costs an LLM call, a migration or a column. Whether to use them is
   still a policy call (decisions below), but they are not future work.

   **The fix is not a bigger sender list.** ADR 0088 already rejected a
   sender-domain skip for magics, correctly: `SENDER_PATHS` is Evite /
   Eventbrite / Meetup — senders whose mail is exactly the actionable kind.
   What's missing is a different axis:
   - **Capture the standards-based bulk signal at sync.** `List-Unsubscribe`
     is the one that carries weight; `List-Id` (RFC 2919) marks true mailing
     lists — Mailman, Google Groups, listservs — which most marketing ESPs do
     not set, and `Precedence: bulk` is non-standard, legacy and applied
     inconsistently. Treat them as one strong signal plus two weak
     corroborators, not three peers. **None is captured anywhere in the codebase
     today** — that's the missing primitive. No LLM, no per-user list to keep.
   - **Use Gmail's own verdict for the retailer case.** `CATEGORY_PROMOTIONS`
     is already stored in `gmail_label_ids` and already read by
     `gmailCategoryOf`, but only as an LLM *hint* — never as a gate. Bulk +
     Promotions is the retailer signal; fall back to the header alone for
     non-Gmail accounts.
   - **Gate each pass at its own threshold, not one global switch.** Bulk alone
     should hard-skip attachment import and person extraction (neither has a
     plausible win on mass mail). For magics, bulk alone must *not* skip — that
     would drop the Evite invitation ADR 0088 wanted kept — so gate on bulk
     **and** a promo/retail category, leaving Events & invites through.

   **But the header is a strong positive signal and a weak negative one.**
   Present → almost certainly bulk-sent. Absent → tells you very little. It
   cannot be the only input, and the misses are systematic rather than random:
   - **Large promotional senders — near-universal.** Since Feb 2024 Gmail and
     Yahoo require one-click unsubscribe (`List-Unsubscribe` +
     `List-Unsubscribe-Post`, RFC 8058) from anyone sending >5,000 messages a
     day, and every major ESP now sets it by default. The big retailers this
     item is about *are* well covered.
   - **Transactional mass mail carries nothing — and that is correct.** Order
     confirmations, shipping notices, receipts, statements, itineraries and
     appointment reminders are explicitly exempt from that mandate, and arrive
     from the same retailers on the same infrastructure. **For us this is a
     feature, not a gap:** that is exactly the mail the AI passes should mine.
     The `UA512-itinerary` fixture in the mock mailbox is this shape.
   - **Small senders often set nothing.** Below the 5,000/day threshold there
     is no mandate, and CAN-SPAM accepts a body link rather than a header. The
     local business, the PTA blast, the realtor newsletter, a small Shopify
     store. **This is the real coverage gap**, and it is why a second axis is
     needed rather than optional.
   - **False positives run the other way too.** GitHub / Slack / Notion
     notifications and school portals (ParentSquare, Remind) set
     `List-Unsubscribe` — and so, almost certainly, do Evite / Eventbrite /
     Meetup. A header-only hard gate on magics would drop precisely the
     invitation ADR 0088 wanted kept. Independent confirmation that the "bulk
     **and** promo category" rule above is right, not merely cautious.

   **Is `no-reply` the signal instead? No — it fails the same way, harder.**
   The regex is `/no-?reply|donotreply|notifications?@|mailer-daemon|postmaster/i`.
   Automation is orthogonal to mass, and only one of the four cells should be
   suppressed:

   |  | 1:1 | mass |
   |---|---|---|
   | **automated** | statements, itineraries, OTPs, shipping, appointment reminders, school portals — **the best mail we have** | promo blasts ← *the only cell to suppress* |
   | **human** | family, friends | small-business / PTA blasts from a real address |

   A no-reply gate takes the whole top row. **Our own fixtures are the
   counter-example** — `seedMailbox()` (`google/gmail-api.ts:230-300`) seeds
   four inbox threads, three of them automation and exactly one a human:
   `no-reply@chase.com` (a statement, `$1,204.55, due May 6` — a dated
   obligation), `no-reply@united.com` (`Flight UA 512`, and the carrier of the
   ADR 0071 canonical attachment fixture **`UA512-itinerary.txt`**),
   `ship-confirm@amazon.com`, and `grandma@example.com`. Plus
   `no-reply@service.example` in junk — the OTP the junk-peek exists for. The
   itinerary this entry already names as the shape a gate must not drop arrives
   from a no-reply sender.
   - **`notifications?@` is the sharpest edge.** It matches
     `notifications@parentsquare.com`, `@remind.com` and school portals — the
     family-critical mail, and plausibly the mail richest in the teacher /
     coach names person extraction is looking for.
   - **`mailer-daemon|postmaster` is a third thing entirely.** A bounce is
     neither mass nor personal — it's a failure notice about the user's *own*
     outbound mail, and arguably actionable.
   - **The converse fails too.** Substack replies to the author; a small
     business blasting through Mailchimp replies to a real mailbox; ESPs
     increasingly personalise the `From`. The small-sender population above is
     precisely the one that *doesn't* use no-reply.
   - **`Reply-To` can't be consulted today, and wouldn't help.** It appears
     nowhere in the tree: not in `METADATA_HEADERS` (`gmail-api.ts:48`), not
     parsed by `normalizeMessage` (`gmail-sync.ts:157`), never in
     `headers_json`. (`In-Reply-To` **is** captured — a different, threading
     header; easy to misread as this one.) A `Reply-To: no-reply` is a weaker
     restatement of the `From`. The *informative* pattern runs the other way —
     brand `From` + human `Reply-To` marks a small sender, exactly the gap
     above — and even that is too thin to build on.

   **What it costs to capture, per provider** (verified in the tree, and cheaper
   than it looks — the blocker is narrower than "we don't read headers"):
   - **Gmail — one line.** `METADATA_HEADERS` (`google/gmail-api.ts:48`) is an
     explicit 8-header allowlist sent as `metadataHeaders`; the header simply
     isn't requested. `headerMap` (`gmail-sync.ts:103`) already lowercases and
     maps whatever arrives, so only `NormalizedMessage.headers` needs widening.
   - **Storage — no migration.** `email_messages.headers_json` (jsonb,
     `schema.ts:1022`) already exists and is already written from `nm.headers`
     (`gmail.service.ts:204,221`). It is per-*message* though, so a thread-level
     flag still needs either a column or a join — `magics.service.ts:330`
     already selects `headers_json` for the latest message.
   - **IMAP — free.** The full source is parsed at sync
     (`email-accounts/imap.service.ts:87`); the header is in hand and discarded.
   - **Outlook — the outlier.** `outlook.service.ts:69,304` hardcodes
     `references: null, inReplyTo: null`; Graph returns headers only when
     `internetMessageHeaders` is explicitly selected on a per-message fetch.
     This is what makes per-provider parity a real decision, not a formality.

   **Can the LLM just judge this by reading the mail?** Partly — and the part
   it is good at is the part nothing else can do. Three findings change the
   shape of the fix:
   - **The classifier already sees almost all of these threads, before the
     passes we want to gate** — with two qualifications. It reads the
     **envelope, never the body**: `fromEmail`, `subject`,
     `snippet.slice(0, 280)`, `gmailCategory` (`llm-classifier.ts:319`). Ample
     where the domain settles it, thin for telling a personalised blast from a
     real note. And it never sees deterministically-routed threads at all —
     not a hole, since those carry a *better*, stable verdict, but it means the
     rule is "gate on the classifier's output **or** the router's," never the
     classifier alone. `afterSync` (`google/gmail.service.ts:297`)
     runs mock classifier → `runLlmClassifier` → label sync →
     `importEmailAttachments` → `runEmailMagics` → `runPersonExtraction`. Its
     verdict is already in hand at every gate site — no new plumbing, no
     ordering change.
   - **It already emits a second independent axis in the same call.** ADR 0086's
     `action` rides the same request as the category path, with the prompt
     insisting the two are judged separately (`llm-classifier.ts:20-44`). A
     third axis is the same established move at ~zero marginal cost.
   - **The cost asymmetry is the crux, and it runs against the header.** The
     classifier is *batched* and sees only the envelope — `fromEmail`,
     `subject`, `snippet.slice(0, 280)`, `gmailCategory`. Magics and person
     extraction are **per-thread** calls carrying body text plus ADR 0088's
     world-context snapshot. So gating from the classifier's own output kills
     the expensive passes at no extra spend, while the header's only unique
     value is skipping the *batched* classify call — the cheap one. That makes
     the header an optimisation, not the missing primitive this entry first
     called it.

   **Which of the four splits to hand the model:**
   - **family vs personal — don't.** We already have better data:
     `people.email` (ADR 0076 sender anchor, `schema.ts:689`),
     `contact_links` (ADR 0065) and group membership. An address-book hit is
     deterministic, free and stable across syncs; ADR 0064's addendum posture
     (no evidence-free identity claims) argues against guessing it.
   - **personal vs mass — mostly deterministic too.** Address-book hit, header,
     or whether the user has ever replied. The model is the fallback for the
     residue, not the first resort.
   - **mass-promo vs mass-transactional — only the model can do this, and it is
     the split that matters most.** Headers can't: transactional mail sets
     none, and neither do small promo senders. Gmail's tabs conflate them. And
     getting it right is exactly what protects the receipts, shipping notices
     and itineraries the product exists to mine.
   - **`action` alone won't carry it.** Promo mail should already land
     `informational` — but so does the newsletter the user loves and an FYI
     from their spouse. Necessary, not sufficient.

   Note some of this is *already* latent in the tree the classifier emits:
   `Coupons` / `Newsletters → …` versus `Deliveries → Shipping updates` /
   `Receipts` versus `Friends & family → …`. ADR 0087 already maps path
   prefixes (`email/archetype-map.ts`), so the precedent exists — but leaf
   titles are LLM-invented ("invent a short leaf title only when confidence is
   high"), so a free-text prefix gate is brittle in precisely the way the
   deterministic-router comment warns about. A closed enum is not.

   **Nothing gets silently swallowed.** Suppression governs AI *spend* only:
   bulk mail still classifies into its tile (Promotions survives exactly as
   today) and is fully present in the traditional view with its folders. What
   stops is extraction, proposals, person mining and attachment indexing.

   **Then let engagement override the default.** The design doc's ranking
   signal (§11) is the answer to the running-newsletter / quarterly-investing
   case: bulk by header, worth reading for *this* user. `is_bulk` sets the
   default; a sender the user repeatedly opens earns its way back into AI
   review. Without that, this is a blunt filter and will eventually eat
   something useful.

   This is also the cost exit ADR 0088 pointed at for magics, arriving as a
   header rather than a heuristic.
   *(cf. ADR 0071 attachment import, ADR 0076 person extraction, ADR 0088
   magics context, design doc §11 + §12.2.)*

   ### ~~Open — ADam to decide how to gate (2026-08-21)~~ → answered in ADR 0127

   Historical decision list (settled). Kept so the trade-offs stay readable
   next to the analysis above.

   1. **Is the header worth building at all?** It buys less than this entry
      first implied — it saves only the batched classify call, while the
      expensive per-thread passes can be gated from the classifier's own
      output for free. If it *is* built: `List-Unsubscribe` alone, Gmail's
      `CATEGORY_PROMOTIONS`, or both? Cost is lopsided — Gmail is one line,
      IMAP is free, Outlook needs a Graph `$select` plus a per-message fetch.
      Accept that asymmetry, hold to header-only for parity, or skip the header
      entirely and let the classifier carry it?
   2. **Where does the gate verdict come from?** Three rungs, cheapest first:
      **(0) reuse what already exists** — free, no new LLM output, two
      independent sub-options: the deterministic router's path prefix
      (decision 3) and the `action` axis. The standing objection was
      brittleness against invented leaf titles — but that applies to *leaves*;
      the prompt lists the **top-level** tiles explicitly, says "Prefer the
      illustrative vocabulary," and hard-rules `Newsletters` to always take a
      topic leaf. Tops are stable, leaves drift, and a top-level prefix gate is
      not the brittle thing that argument describes. Residual weakness is real
      though: `informational` conflates the loved newsletter with the spousal
      FYI.
      **(1) a new closed-enum axis in the same classifier call** — e.g.
      `correspondence: personal | family | mass_transactional | mass_promo`,
      mirroring ADR 0086's `action` exactly: optional in the
      `ThreadAssignment` seam (`kernel/src/types/email-classification.ts:54`),
      defaulted on ingest, carried forward by `loadBaselinePaths` so
      snapshot-replace can't wipe it. ~Zero marginal cost, immune to
      leaf-title drift — but it is the **residue after the free gates**, not
      the first move. Recommended *once rung 0 is spent*.
      **(2) the header**, per decision 1 — deterministic and pre-LLM, but blind
      exactly where the split matters.
      Pick one, or (1) with (2) layered later purely as a cost trim?
   3. **Should magics honour the deterministic router, and on which half?**
      Person extraction already does; magics doesn't, and the routing is what
      admits the thread. Prefix-gating the `Social & professional` half is
      close to policy-free — it closes an asymmetry rather than setting one,
      preserves every Evite / Eventbrite / Meetup thread, and directly answers
      the owner's LinkedIn complaint. Prefix-gating the `Events & invites` half
      would be the thing ADR 0088 actually rejected. Take the first half, both,
      or neither?
   4. **Does an address-book hit exempt a thread outright?** The family /
      personal split should resolve through `people.email`, `contact_links`
      and group membership rather than the model. Does a known-person sender
      *bypass* gating entirely (never suppressed, whatever else says), or is it
      just one input among several? Bypass is simpler to reason about and
      matches the product's posture, but it means one stale contact row can
      re-open the firehose. Note it settles only half the problem: a no-reply
      sender can never *be* an address-book hit, so whatever bypass rule is
      chosen, the automated-1:1 row needs protection of its own.
   5. **Per-pass thresholds, and what becomes of `NOREPLY_RE`.** Attachment
      import: bulk alone, or bulk + promotions? Magics: which classes are the
      deny list versus explicitly allowed through (Events & invites, Finance?).
      For person extraction, "replace or stack" is the wrong question — the
      regex and the gate measure different axes. The real one: does
      **automated vs human** earn a slot in the closed enum beside
      `mass_promo | mass_transactional`, or is it noise once a correspondence
      axis exists? If it earns one, `NOREPLY_RE` retires into it; if not, it
      stays exactly where it is and never spreads.
   6. **Deny-list or allow-list.** Extract on everything except what's flagged
      (safer recall, most of the cost stays) versus extract only on non-bulk
      (much cheaper, silently drops anything the signal mislabels). This is the
      main call — the rest follow from it. Note the transactional carve-out
      above cuts toward deny-list: the highest-value mail carries no header.
   7. **Override, and whether it ships in the same slice.** Engagement-based
      promotion (§11) is what keeps this from being blunt. Ship it together, or
      ship the gate first and accept that a wanted newsletter goes quiet until
      §11 lands? If the latter, does v1 need a manual per-sender "always
      review" escape?
   8. **Images, separately from senders.** Is the gate enough, or do inline
      `Content-ID` parts and a higher `MIN_IMAGE_BYTES` also belong in the
      fix? Those are orthogonal to who sent the mail and would catch the
      marketing banner arriving from a non-bulk sender — including the
      transactional mail we deliberately keep mining.
   9. **Stickiness.** Whatever the source, the verdict must not flip between
      syncs — a thread that gets mined on Tuesday and skipped on Wednesday is
      the drift the deterministic router was built to avoid. `action` is
      already carried forward on re-ingest; confirm the gate field is too.
   10. **Rollout.** Env-flagged (`EMAIL_BULK_GATE`) so it can be turned off in
      prod without a deploy, or straight on?

12. **A shipping update should say WHEN, and let you track it — SHIPPED
   2026-08-25 as [ADR 0135](../notes/0135-a-shipping-update-says-when.md),
   migration `049`.** Kept here for the reasoning; the ADR is the record.
   Today a delivery thread renders as a bare status word — "shipped" — and a
   suggestion that says "track this". Both are the least useful version of what
   the email actually contains. Roughly half of these mails carry an **arriving
   on** date, and most carry a **tracking number**, which is enough to build the
   carrier's own tracking URL. Reported: *"I don't want a plain 'shipped'."*

   - `extractStateStatus` (`tile-facts.ts`) returns a status enum and nothing
     else. `EmailStateFact` should carry `etaAt` and a `tracking?: {carrier,
     number, url}` so the state board reads "Arriving Thu · UPS 1Z…" and the row
     opens the carrier page.
   - Carrier + number is **deterministic from the number's own shape** — UPS
     `1Z[0-9A-Z]{16}`, FedEx 12/15/20 digits, USPS 20-22 digits, DHL 10 — so
     this is a parser, not an LLM call, and the URL is a template per carrier.
     Where the shape is ambiguous, the sender's domain settles it.
   - The ETA needs READING, not matching ("arriving Thursday", "expected
     Aug 29", "by end of day"). Owner decision 2026-08-25: **read delivery mail
     greedily** — the date is usually stated outright, so spend the body on it
     rather than hoping a regex catches the phrasing. ADR 0110's excerpt is
     what makes that possible; before it the passes saw ~78 characters and the
     ETA was almost never among them.
   - The link is rendered, and the USER clicks it. Decided, not open.
   - What IS open: whether Chord ever FETCHES a carrier page itself to show
     live status in-app. It should not — that is a per-user request to a
     company we have no relationship with (rate limits, terms, and Chord
     silently becomes its client), and it buys nothing, because the email
     already says the date. Worth writing down precisely because it is the
     "obvious improvement" someone reaches for later. Note ADR 0107's
     ours/theirs split does not decide this: a carrier is neither us nor the
     mail provider.

13. **Features for a mailbox that DOES things (2026-08-25).** Owner framing:
   *"a true AI mailbox will do things for us from email as a surface."* The
   pattern behind item 12 generalises — the mail already contains a fact and an
   action, and we render a category instead. Exploratory candidates (not a bug
   queue), roughly by how often the mail carries what is needed:

   - **Deliveries** — ✅ arrival date + carrier link shipped as item 12 /
     [ADR 0135](../notes/0135-a-shipping-update-says-when.md). Still open:
     several shipments of one order collapse to one row rather than four.
   - **Money** — a bill's due date and amount are already extracted (ADR 0087
     ledger). Missing: "due in 3 days" ordering against *today*, and a
     confirmed-payment email retiring the row it corresponds to instead of
     both sitting there.
   - **Travel** — partial: flight status links via
     [ADR 0138](../notes/0138-a-flight-we-cannot-name-gets-no-link.md). Still
     open: confirmation numbers, seat, gate, check-in windows; an itinerary
     email is the densest structured source and today produces at most one
     calendar event plus a status link.
   - **Appointments** — reschedule/cancel links are in the mail. Surfacing the
     link is honest; clicking it for the user is not.
   - **Subscriptions and renewals** — "your plan renews on X for $Y" is a
     dated obligation with an amount, i.e. already a ledger + timeline fact,
     and is the mail people most want warning about rather than notice of.
   - **Unsubscribe** — ✅ **Shipped as
     [ADR 0122](../notes/0122-unsubscribe-is-three-different-promises.md)**
     (one-click / mailto / link-only, three honest outcomes). Header capture
     was ADR 0109.
   - **Replies that write themselves** — a reply-needed thread where the answer
     is a fact we hold ("yes, we'll be there", "here's the address") is a draft
     the user approves, not a blank composer.

   Note what is NOT a question here: whether the mailbox acts on its own. It
   does not, anywhere — `confirmProposal` is reachable only from a route, and
   ADR 0076's people bootstrap is the single auto-write, behind a flag that
   defaults off. Every item above renders a fact and offers an affordance; the
   user presses it. The unsubscribe case is the only one worth a second look,
   and for the opposite reason: RFC 8058 one-click is a POST the SENDER
   published for machines to call, so acting there is invited rather than
   inferred.
