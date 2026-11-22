# Product direction — August 2026 (owner capture)

Raw owner note captured 2026-08-13, triaged against the code. Two things in
here: a **positioning restatement** and a **list of app changes**. Items are
marked **[bug]** (something is broken today), **[feature]** (new work), or
**[decide]** (needs an owner call before code).

Related: [F&F release plan](./friends-and-family-release.md) — only items 5 and
6 below touch the release critical path; the rest are post-blocker product work.

---

## Positioning restatement

> **Chord is a family coordination app built on chat, email and calendar.**
> To do that it needs access to email and calendar. For email, Chord reads and
> classifies mail and turns it into action items.

This is a sharper version of the Workstream M rewrite: it names the three
surfaces and the email→action-item promise in one line. It should drive the
landing page headline, `docs/features.md`, and the app-store copy — all of
which still lead with "the group chat that actually keeps track"
([mobile/app/index.tsx:340](../../mobile/app/index.tsx)).

---

## 1. Email classification: split into two orthogonal axes  ✅ DONE 2026-08-13

> Built as [ADR 0086](../notes/0086-email-action-axis.md). `email_threads.action`
> (`to_do`/`reply_needed`/`informational`/`other`, null = unclassified), judged
> in the same LLM call as the category but explicitly independent of it;
> `?action=a,b` filters the thread list; the mobile list gets a filter strip
> (All · To do · Reply · FYI) and badges only the two actions that ask for
> something. 12 tests in `email/__tests__/action-axis.integration.test.ts`.
>
> Two traps worth remembering: `ThreadAssignment.action` had to stay **optional**
> so the external ADR 0061 classifier keeps validating, and because ingest is
> snapshot-replace, `loadBaselinePaths` must carry each thread's prior action
> forward or a partial batch silently resets everyone else to `other`.


**There used to be one axis.** The classifier assigned each thread a *category
path* only (`["Travel","Flights"]`) —
[llm-classifier.ts:24](../../server/src/services/email/llm-classifier.ts)
builds the prompt, `buildTreeFromPaths` builds the tile tree. Whether a thread
*needs you to do something* is never labelled: that lives in a different
subsystem entirely (`magics.service.ts` stages proposals, surfaced under
To Do's → Action Items per [ADR 0070](../notes/0070-todos-hub-action-items-first.md)).

**The consequence that motivated this:** you could not see "needs reply" on the
map or filter by it, and a thread needing a human reply but producing no
proposal was invisible as an action.

**Shape:** an **action axis** on the thread, independent of category. (The
original note double-counted — `reply` appeared both as a sub-value of "need
action" and as a peer, and `to do`/`other` each appeared twice; the owner
settled on the flat four below.)

| Action | Meaning |
|---|---|
| `to_do` | Chord can act — has (or should have) a suggestion/proposal |
| `reply_needed` | A human reply is expected |
| `informational` | Read-only, no action |
| `other` | Unclassifiable |

Every thread gets **exactly one** action value **and** a category path. The
category axis is unchanged.

Extends ADR 0066 (classifier) and 0068 (map).

## 2. Family / school / kids ranked to the top  ✅ ALREADY BUILT (2026-07-16)

**This triage entry was wrong.** It claimed tile area was purely
attention-weighted with no topical priority. In fact `usefulness()` in
[mobile/src/email-tiles.tsx:57](../../mobile/src/email-tiles.tsx) already
boosts people-centric tiles (`famil|friend|school|kid|child|personal|home`) by
1.75x and damps `newsletter|social|professional|promo|…` to 0.35x — precisely
because attention is unread-driven and newsletters pile up unread while
mattering least. Squarify places the heaviest tile top-left, so that weight is
both size **and** order: family mail already leads the map.

Landed in `e007cdf` ("family-first map order"), ten days before this note was
written. No work needed. If the ordering still feels wrong against a real
mailbox, the cause is tile *titles* not matching those patterns, not a missing
rule.

## 3. Email and Chat tabs  **[feature]** ✅ DONE 2026-08-13

Scoped to the two existing tabs — **no** unified inbox surface, no redesign.
The bottom bar was `Email · Chats · To Do's · Calendar · Settings`; the two are
now swapped so **Chat leads** (`MAIN_TABS` in
[mobile/src/group-nav.tsx:38](../../mobile/src/group-nav.tsx)). Order is the
only thing that changed — the bar renders straight off that array, and the
post-sign-in landing was already `/groups`, so the leading tab and the landing
route now agree.

## 4. On-demand email summary by section  ✅ DONE 2026-08-13

*"Summarize my emails from yesterday by sections."* The only email summary used
to be the attention-first section appended to the **morning briefing**
([ADR 0072](../notes/0072-unified-calendar-settings-and-one-briefing.md)) — no
way to ask for one, no window control.

New `summarize_email` bot tool over a new `email/summary.service.ts`
(deliberately separate from `digest.service.ts`, which owns the fixed briefing
section). Sections are the **ADR 0086 action axis**, ordered by how much each
wants from the user — Needs doing · Needs a reply · Other · Not sorted yet ·
FYI — each carrying a *complete* count plus a capped list of examples, with a
`byCategory` breakdown alongside. Deterministic, no LLM: the bot narrates the
structure, so it cannot invent mail.

Personal-1:1 only, via the existing `PERSONAL_ONLY_TOOL_NAMES` gate — same rule
as searching mail (ADR 0084).

**The window is resolved in the user's own zone**, which is the whole subtlety:
a thread arriving 20:00 UTC is already tomorrow in Nairobi, so "yesterday"
differs by reader. `zonedDayStartUtc` reuses the drift-measuring technique from
`nextScanDate` so DST is handled at the target date rather than assumed.
Defaults to the user's yesterday when the model passes no dates.

12 tests in `email/__tests__/summary.service.integration.test.ts`, including
both sides of a Nairobi day boundary.

## 5. Timezone: daily alert fires at the wrong time after travel  **[bug]** ✅ FIXED 2026-08-13

**Reproduced by the owner (NY → Nairobi → NY). Three compounding defects:**

1. **`users.last_tz` is only written when you post a chat message** —
   [routes/messages.ts:75](../../server/src/routes/messages.ts) is the sole
   write site in the codebase. Not on login, not on app foreground, not on
   email or calendar activity. Fly somewhere and stay quiet in chat and the
   server still believes you are in the old zone indefinitely.
2. **A tz change never re-times the already-queued briefing.** The next scan is
   enqueued a day ahead *at fire time* using the tz known then
   ([proactive.service.ts:1590](../../server/src/services/proactive.service.ts)),
   and `enqueueDailyScanForUser` dedupes on `scanDate`, returning early if a row
   for that day exists. `rescheduleDailyScanForUser` exists and does the right
   thing, but its only callers are the nudge-**time** setter
   ([me.ts:908](../../server/src/routes/me.ts)), the `set_nudge_time` tool
   ([executor.ts:2493](../../server/src/services/bot/executor.ts)), and pairing —
   **never a zone change**.
3. **The dedup key is computed in server-local time.** `localDayOf` uses
   `getFullYear/getMonth/getDate` on the server clock, not the user's zone, so
   for a user hours ahead the `scanDate` key can land on the wrong day and
   suppress a legitimate re-queue.

**Fixed (2026-08-13)** — all three, centred on `proactive.service.ts`:
- `recordUserTimezone(db, userId, tz)` is now the single write path for
  `last_tz`. It validates the zone (a garbage string used to be written
  straight through, permanently falling the scheduler back to server-local),
  and on an actual **change** calls `rescheduleDailyScanForUser`.
- `enqueueDailyScanForUser` takes the zone and keys `scanDate` on the
  **user's** day via `dayOf`, not `localDayOf`. A second dedup pass matches any
  pending row that *lands on* the same local day, so a row keyed under the old
  zone re-times instead of producing a second briefing — this is what makes the
  change safe to deploy over already-queued rows.
- New `PUT /me/tz` (`API.meTimezone` + `SetTimezoneRequest`), called by
  `useReportTimezone` (`mobile/src/timezone.ts`) from the **root layout** on
  launch and on every foreground. App-wide on purpose: the zone is a global
  fact, and the focused screen says nothing about where the phone is. The
  message-post path now routes through the same function.

Covered by `server/src/services/__tests__/timezone-travel.integration.test.ts`
(8 tests: both legs of the trip, the one-row invariant, unchanged-zone no-op,
malformed zone, nudges-off, and a stale-key row under the boot seed).

## 6. Website rewrite  **[feature]** ✅ DONE 2026-08-13 — closes release blocker #3

Workstream M. The landing page (`mobile/app/index.tsx`, same Expo web bundle,
still one self-contained route) now leads with the positioning line instead of
"the group chat that actually keeps track":

- **Hero** — "Your family's inbox, calendar, and to-dos — handled", with the
  chat-transcript visual replaced by a *this morning* panel: three real-shaped
  finds (school form, flight change, party RSVP) each sitting behind a confirm
  chip and a "nothing saved yet" footer, so the consent model is visible before
  a word of copy is read.
- **Four surfaces** — Email · Calendar · To Do's · Messages, mirroring the tabs.
- **Consent section** — every write is a proposal, every suggestion links to its
  source email, groups stay separate.
- **Getting started** — Google sign-in first; Telegram/WhatsApp demoted from the
  hero path to a "also works where your family already chats" section that keeps
  the `/chord pair` how-to.
- **Pricing** — 30-day trial, then a plan, BYOK always free. Deliberately names
  **no price**: the J3 plan shape is still undecided, so the page must not
  promise one.

Also corrected three stale claims found in the untouched sections: the sign-in
card promised a calendar named "Family" (ADR 0040 made the target calendar
user-selected, primary by default), the privacy section listed only OpenAI and
Gemini, and "who we are" still described a chat product.

Verified in a real web build, not just a typecheck: `expo export` → served →
measured. The four cards were gated on the pre-existing `isWide` JS width probe,
which made them stack full-width; a wrap + basis is self-responsive and needs no
probe. **`flexShrink` is set explicitly** — React Native defaults it to 0 (CSS
defaults to 1), so the 400 basis would have overflowed a phone screen instead of
collapsing to one column. Confirmed 2x2 at 1280 and one column at 375, no
horizontal overflow at either.

## 7. Rename "Chats" → "Messages"  **[feature]** ✅ DONE 2026-08-13

Label only, three strings: the tab label (`MAIN_TABS`), the stack screen title
([_layout.tsx:54](../../mobile/app/_layout.tsx)), and the in-chat back
affordance (`‹ Messages`). The `chats` tab key and the **`/groups/*` routes are
unchanged** — same discipline as ADR 0070's Catchup → "To Do's" rename, so
existing deep-links and ADR 0059 search hrefs survive.

## 8. Surface email (and to-dos) in search from the 1×1 chat  ✅ DONE 2026-08-13

Genuinely unbuilt on **both** search paths:
- User-facing search: `SEARCH_ENTITY_TYPES = ['message','file','task','list','save']`
  ([kernel/src/types/search.ts:9](../../kernel/src/types/search.ts)) — no email,
  no proposals/action-items.
- The bot's [ADR 0059](../notes/0059-unified-search-tool.md) `search` tool covers
  chats/files/tasks/reminders/saves/events/lists/places/contacts/media — also no email.

**Built 2026-08-13** on both paths — see
[ADR 0084](../notes/0084-email-and-todos-in-search.md):

- `email` and `todo` join `SEARCH_ENTITY_TYPES`; the bot tool gains `emails`
  and `todos` categories. Migration `038` adds a generated `search_tsv` + GIN
  on `email_threads` (subject + snippet + sender), mirroring ADR 0062.
- **Email is personal-scope only** — searched from the 1×1, never from inside a
  shared group. It has no `group_id` of its own, and answering a shared-group
  search with a member's private mail is precisely the leak ADR 0032 guards.
- To-dos are pending proposals, matched in memory rather than by tsvector:
  their text lives inside `args_json`, so a generated column would index JSON
  keys alongside content, and the set is small because proposals expire.
- Email hits carry their ADR 0086 `action`, so "which of these needs a reply"
  is answerable from a single call.

11 tests in `services/__tests__/search-email-todos.integration.test.ts`,
including the two that matter: no mail in a shared-group search, and no mail
belonging to another user.

## 9. "Why do we have Personal notes in each subcategory?"  **[answer]** ✅ FIXED 2026-08-13

**It is defined once, not per-category.** "Personal notes" is a single
illustrative *leaf* under **Friends & family** in the classifier prompt
vocabulary ([llm-classifier.ts:34](../../server/src/services/email/llm-classifier.ts)) —
it appears nowhere else in the codebase.

**Why it shows up all over anyway:** the prompt tells the model to *"Prefer the
illustrative vocabulary"*, and the tree is built from whatever paths come back
(`buildTreeFromPaths`) with no allow-list of valid leaves. So the model is free
to hang a blessed-sounding "Personal notes" leaf under any parent, and nothing
rejects it. It functions as a junk drawer: the name carries no category meaning
and no action meaning.

**Fixed (2026-08-13):** the leaf is gone from the prompt vocabulary. Because
removing a blessed catch-all invites the model to invent an equivalent one, a
rule now names the failure mode explicitly — never invent "Personal notes" /
"Misc" / "Other" / "General"; a thread that fits the parent but no listed leaf
gets the **parent path alone**. Item 1's action axis is the honest way to say
"this is just a note to you."

---

## Order

1. ~~**Item 5 (timezone)**~~ — ✅ done 2026-08-13.
2. ~~**Item 9 (Personal notes)**~~ — ✅ done 2026-08-13.
3. ~~**Item 3 (tab swap)**~~ — ✅ done 2026-08-13.
4. ~~**Item 7 (Chats → Messages)**~~ — ✅ done 2026-08-13.
5. ~~**Item 6 (website)**~~ — ✅ done 2026-08-13.
6. ~~**Item 1 (action axis)**~~ — ✅ done 2026-08-13 (ADR 0086).
   ~~**Item 2**~~ — was already built; the entry was wrong.
7. ~~**Items 4, 8**~~ — ✅ both done 2026-08-13. The action axis paid off in
   each: the summary sections by it, and email search hits carry it.

**Every item in this note is now closed.** What remains is verification rather
than build: none of the email work has run against a real mailbox, and the
website has not been shown to anyone who has never seen Chord. Both are called
out in the entries above.

---

## Follow-on: one search matching rule (2026-08-13)

Not from the original note — it came out of the owner asking *"why do we need a
search icon in personal chat, why can't a user just ask?"*

The icon earns its place (it works when the ADR 0079 AI gate closes, costs no
LLM turn, refines live, and is the only discoverable entry point), but the
question exposed a real defect underneath: the two surfaces were **separate
implementations that disagreed**. FTS on the icon, `ILIKE` on the bot — so
"plumbers" found "plumber" in one and nothing in the other, while `512` found
"UA512" in the other and nothing in the one.

[ADR 0085](../notes/0085-one-search-matching-rule.md) states one rule and
applies it to both: **FTS tokens OR literal substring**, a union rather than a
fallback. Recall went up on both sides. A parity test asserts the two return
identical id sets and exists to fail loudly if they drift again.

Still open from ADR 0062: score normalisation across entity types, and the four
types with no tsvector (events, places, contacts, media) remaining
literal-only.
