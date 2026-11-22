# Email parity audit — what a mail app does, and what Chord does

Captured 2026-08-24, against the working tree (not against the ADRs).

**Why this exists.** Chord's mail surface is meant to be a real mail client with
AI on top — not an AI inbox that happens to show mail. The standard set by the
owner: *"our mail portion needs to be able to do everything any other mail app
can, but we also have magics and AI."* Today it does not, and the shortfall had
never been written down in one place. The existing docs cover the **AI** roadmap
([`chord_email.md`](./chord_email.md) §15, [`Email-bugsandbacklog.md`](./Email-bugsandbacklog.md));
nothing covered table stakes.

**Headline.** Chord is a competent read-and-reply mirror with a strong AI layer
on top, and it is missing most of the verbs a mail app is defined by:

- **Outbound is reply-only.** No compose, no forward, no drafts, no attachments
  on send — on all four providers.
- **Chord can detect a delete but never perform one.** No trash, no delete, no
  star, no flag, no snooze, no move.
- **Search now reads message bodies** (ADR 0110, 2026-08-25). Remaining search
  gaps are operators (`from:`, `has:attachment`, date range) and a per-account
  filter.
- **Drafts / Trash / Labels are still `disabled` rows** (Sent + Archive went live
  2026-08-25). Drafts and Trash are now deliberate stubs, not gaps — see ADR 0108.
- Two places where the local mirror **asserts something untrue** about the
  mailbox (IMAP archive, Outlook un-archive).
- Mail arrives by **polling only** — no watch, no subscription, no IDLE — so
  there is no new-mail notification.

---

## Changes since capture

**2026-08-24, same day.** Four fork-independent items shipped — all of them
reading-or-answering, none of them mailbox management, so none prejudges the
read-and-answer vs full-parity decision in §6:

1. **Email search has an entry point** — 🔍 on the Email tab, pinned to mail.
2. **Read state works like a mail app** — marks read on open, toggles unread.
3. **To / Cc render** on received messages.
4. **`reply_to_email`** — the bot drafts a reply; the user taps Send.

**2026-08-25.** The fork is settled — [ADR 0107](../notes/0107-chord-reads-and-answers-gmail-manages.md):
Chord reads and answers, the provider manages. That resolves ~20 of the rows
below to *deliberate* rather than missing, and it shipped with:

5. **Compose** — `POST /me/email/send` on all four providers, with a From picker.
6. **A way out** — a per-thread provider deep link, so filing is one tap away.
7. **The three mirror bugs fixed** — real IMAP archive, symmetric Outlook
   un-archive, and labels that refuse (422) rather than being dropped in silence.

Rows below are updated in place. Everything else stands as captured.

---

## How to read this

### The framing rule

[`chord_email.md`](./chord_email.md) §5 deliberately declares some mail-app
features absent: *"Absent: unread badges, snooze, per-message triage gestures."*
That is not in conflict with the parity standard, because the same section
promises the **Traditional view** is *"the complete mailbox. Every email, the
full folder structure, nothing withheld."*

So **parity is scored against the Traditional view.** The AI view's subtractions
are deliberate and are not counted as gaps. Where something is missing from
*both* views, it is a real gap. This is stated here so it can be overruled in one
place rather than argued row by row.

### Legend

| | Meaning |
|---|---|
| ✅ | Shipped and reachable by a user |
| ◐ | Partial — exists on the server but has no UI, or works on some providers only, or is local-mirror-only |
| ✖ | Absent — no route, no provider method, no column, no UI |

### Verdicts

| Tag | Meaning |
|---|---|
| **MUST BUILD** | A normal mail app does this and we have no reason not to |
| **DELIBERATE** | We chose not to — the choosing doc is cited |
| **BLOCKED** | Needs a provider/vendor step outside our control |
| **BUG** | The mirror asserts something untrue about the mailbox |

Sizing is `S` (under a day), `M` (a few days), `L` (a week or more).

### Method

Every row was verified in code. Every ✖ is backed by a search recorded in the
[appendix](#appendix--the-searches-behind-the-absences) — an absence is only as
good as the search that established it, so the searches are re-runnable rather
than asked to be trusted.

---

## §1 — Mail-client parity matrix

### 1.1 Reading and rendering

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| Mirror the mailbox locally | ✅ | `backfillGmail` / `syncGmailIncremental`, `server/src/services/google/gmail.service.ts` | — |
| Thread list: sender, subject, snippet, rel-time, unread dot | ✅ | `mobile/app/email/index.tsx:95` | — |
| Open a thread, all messages shown | ✅ | `mobile/app/email/[threadId].tsx:47` | — |
| HTML body rendering, sanitized | ✅ | `mobile/src/email-body.tsx:94` | — |
| Attachment list + download (web tab / native share) | ✅ | `[threadId].tsx:93`, `server/src/routes/email.ts:458` | — |
| **Show To / Cc on a received message** | ✅ | **shipped 2026-08-24** — one collapsed line under the sender, tap to expand | — |
| **Collapse quoted text / trim history** | ✅ | **shipped 2026-08-25** (ADR 0121) — split on the RAW body, before the sanitizer strips the class that identifies a quote container; an uncertain split shows everything | — |
| **Collapse individual messages in a long thread** | ✅ | **shipped 2026-08-25** (ADR 0121) — newest open, the rest folded to a line that shows who wrote and what they said | — |
| **Mark read on open** | ✅ | **shipped 2026-08-24** — client-side after load, guarded by the thread it already auto-read so a later *mark unread* sticks. Still no write on `GET` | — |
| Mark read (explicit action) | ✅ | thread action bar → `applyThreadModify` | — |
| **Mark unread** | ✅ | **shipped 2026-08-24** — the action bar is now a read/unread toggle driven by `thread.isUnread` | — |
| **Print / share a message** | ✅ | **shipped 2026-08-25** (ADR 0121) — print on web from the same sanitized html on screen; Share on native, since print needs a new native module | — |

### 1.2 Outbound — the largest gap

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| Reply | ✅ | `POST /me/email/threads/:id/reply` (`routes/email.ts:322`) | — |
| Reply-all | ✅ | client recomputes recipients; server takes explicit `to` / `cc` / `bcc` | — |
| Signature | ✅ | Chord-managed `users.email_signature`, appended after `"-- "` (ADR 0069) | — |
| HTML alternative on send | ✅ | auto-generated by `textToHtml` (`gmail-sync.ts:265`) | — |
| Replying marks the thread read | ✅ | `gmail.service.ts:827` | — |
| **Compose a new message** | ✅ | **shipped 2026-08-25** — `POST /me/email/send`; raw MIME on both Gmail paths, Graph `sendMail` on Outlook, SMTP on IMAP. From picker renders only when >1 mailbox is attached | — |
| **Forward** | ✅ | **shipped 2026-08-24** (ADR 0112) — its own screen, quoted not appended, and a file we cannot fetch stops the send | — |
| **Attachments on send** | ✅ | **shipped 2026-08-24** (ADR 0111) — by Chord attachment id, never bytes; per-provider caps, refused not truncated | — |
| **Drafts (save / list / resume / autosave)** | ✅ | **shipped 2026-08-24** (ADR 0113) — one draft per (user, kind, thread), debounced autosave, cleared server-side after the provider took it | — |
| **User-authored HTML / rich text** | ✅ | **shipped 2026-08-25** (ADR 0131) — a small markdown subset rendered on send; italics deliberately excluded, and an unformatted body produces the same bytes as before | — |
| **Recipient autocomplete** | ✅ | **shipped 2026-08-24** (ADR 0114) — from the user's own mail and own people rows only: a field that answers a two-letter prefix is a directory | — |
| **Send-as / alias / From picker** | ✅ | **shipped 2026-08-25** (ADR 0130) — the mailbox picker already existed; this adds Gmail aliases, VERIFIED ONLY, because Gmail silently rewrites an unverified From and reports success. Covered by `gmail.modify` — no new scope | — |
| Undo send | ✅ | **shipped 2026-08-24** (ADR 0115) — server-side hold on the draft row, since an app killed during a client-side timer never sends and never says so | — |
| Schedule send | ✖ | — | Deferrable |
| Read receipts | ✖ | — | DELIBERATE — out of character for the product |

### 1.3 Organisation — flags, labels, folders

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| Archive | ✅ | **fixed 2026-08-25** — a real move to SPECIAL-USE `\Archive` on IMAP (never falling back to Trash; a mailbox with no archive folder reports it instead of writing the label anyway), and Outlook now pushes both directions | — |
| Un-archive / move back to inbox | ✅ | **fixed 2026-08-25** — as above | — |
| **Trash / delete** | ✖ | every trash code path is *detection*. Not built | **DELIBERATE** (ADR 0107) — deleting is filing; the thread links out to the provider |
| **Permanent delete** | ✖ | rides on trash, which is itself managing | **DELIBERATE** (ADR 0107) — every thread links out to the provider |
| **Star / flag** | ✖ | no `is_starred` column | **DELIBERATE** (ADR 0107) |
| **Snooze** | ✅ | **shipped 2026-08-25** (ADR 0129) — a predicate like every other folder; a new message wakes it, an ordinary mark-read does not. Chord-only, because Gmail's snooze has no API, and the folder says so | — |
| Apply the `Chord/<category>` label | ✅ | `maybeSyncCategoryLabels` (`gmail.service.ts:355`), opt-in via `users.gmail_sync_labels_enabled` | — |
| **Apply an arbitrary label / create one** | ◐ | the silent drop is **fixed 2026-08-25** — Outlook and IMAP now refuse with `422 {unsupported:true}` instead of reporting a success the mailbox never saw. Labelling itself stays Gmail-only, and is now **DELIBERATE** (ADR 0107: labels are filing) | DELIBERATE |
| **List labels / folders** | ✓ | **shipped 2026-08-25** (ADR 0125) — derived from the mirror rather than fetched per provider, so one query answers for all four mailbox kinds | — |
| **Move to an arbitrary folder** | ✖ | — | **DELIBERATE** (ADR 0107) |
| **Browse Sent / Archive** | ✅ | **shipped 2026-08-25** (ADR 0108) — a folder is a predicate over the label set (`email/folders.ts`); `listThreads` takes `folder` and defaults to `inbox`. The rows were in the mirror all along | — |
| Browse Drafts | ✅ | **shipped 2026-08-25** (ADR 0113) — Chord's own drafts, with a footer saying the provider's stay where they are | — |
| Browse Trash | ✖ | trashed rows are reaped by ADR 0073's reverse-delete, so the folder would be right one day and empty the next | **DELIBERATE** (ADR 0108) |
| Browse arbitrary labels | ✓ | **shipped 2026-08-25** (ADR 0125) — and a label reads across folders, since filing is labelling plus archiving | — |
| **Open this thread in the provider** | ✅ | **shipped 2026-08-25** — Gmail deep-links the thread via `#all/` + `authuser`; Outlook and IMAP presets link to the mailbox and are marked inexact; a custom IMAP host gets no button rather than a guessed one | — |
| Junk peek + "not junk" rescue | ✅ | `routes/email.ts:486,494` — live read, never mirrored | — |
| **Mark as spam** | ✖ | moving mail to Junk is a folder move | **DELIBERATE** (ADR 0107) — every thread links out to the provider |
| Mute / ignore a thread | ✖ | — | **DECIDE FIRST** — snooze-shaped, so it rides on decision 3 in [`email-owner-decisions.md`](./email-owner-decisions.md) |
| Block a sender | ✖ | a filter, and Gmail's own is one click from the thread link | **DELIBERATE** (ADR 0107) — every thread links out to the provider |

> **On Sent specifically:** this was the whole of ADR 0108. Primary Gmail *does*
> mirror sent mail (the backfill query is `newer_than:Nd` with no `in:inbox`), so
> there Sent was purely a **listing** problem — the rows existed but carried no
> INBOX label, so `is_archived = 1` hid them. Outlook syncs `mailFolders/inbox`
> only (`outlook-api.ts:146`) and IMAP syncs INBOX only (`imap-api.ts:181`), so
> for those two Sent holds only what Chord itself sent — which the folder banner
> now states rather than letting a short list read as lost mail.

### 1.4 The list surface

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| Unified inbox across mailboxes | ✅ | `listThreads` filters by `user_id`, never `account_id` | — |
| Filter by action axis (To do / Reply / FYI) | ✅ | `?action=` (ADR 0086) | — |
| Pull to refresh (runs a real sync) | ✅ | `mobile/app/email/index.tsx:214` | — |
| **Which mailbox a row came from** | ✅ | **shipped 2026-08-24** (ADR 0119) — local-part chip + filter, shown only when there is more than one mailbox | — |
| **Pagination / infinite scroll** | ✅ | **shipped 2026-08-24** (ADR 0119) — keyset on `last_message_at`, because an OFFSET repeats or skips a row when mail lands mid-scroll | — |
| **Multi-select + bulk actions** | ✅ | **shipped 2026-08-25** (ADR 0128) — long-press to select; the batch endpoint loops the per-thread path and reports `{updated, failed}` | — |
| **Swipe actions** | ✅ | **shipped 2026-08-25** (ADR 0128) — archive and toggle-read only, since those are the two verbs Chord performs; needed `GestureHandlerRootView` at the root or they bind and do nothing | — |
| **Long-press context menu on a row** | ✅ | **shipped 2026-08-25** (ADR 0128) — long-press enters selection mode, which is what the menu would have opened onto | — |

### 1.5 Search

Search is the one place where the capability is **better than its placement**.
It works; almost nobody would find it.

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| **Search your mail — from the personal 1:1 chat** | ✅ | the chat's 🔍 opens `SearchModal` with `groupId` **undefined** when the group is personal (`mobile/app/groups/[id]/index.tsx:1353`), which calls `searchGlobal` → `GET /me/search` → `crossGroup: true` (`routes/me.ts:300`). The email arm is gated on exactly that (`search.service.ts:925`). Ranked, `ts_headline` bold snippets, FTS-OR-literal matching (ADR 0085), deep-links to `/email/<id>` | — |
| Email excluded from a **shared** group's search | ✅ | same gate — the modal passes the real `groupId` outside the personal chat, so `crossGroup` is false | **DELIBERATE** and correct (ADR 0032/0084): a member's private mail must never surface in a shared group |
| The bot can search mail | ✅ | umbrella `search` tool, `categories: ['emails']`, personal chat only | — |
| **A search affordance on the Email tab** | ✅ | **shipped 2026-08-24** — a 🔍 in the Email-tab header opens the same `SearchModal`, pinned to `types: ['email']`. `SearchModal` gained `types` / `placeholder` props | — |
| **A search route over threads** | ✖ | `listThreads` accepts mode / category / action / cursor only — search lives on `/me/search`, not on the mail routes | Fine as-is; the Email tab should call `/me/search` |
| Message bodies in the index | ✅ | **shipped 2026-08-25** (ADR 0110) — migration `048` adds a generated tsv + GIN on `email_messages`; the Gmail sync switched to `format=full` (same call, same quota) so a body exists to index | — |
| **Find archived mail** | ✅ | **shipped 2026-08-25** (ADR 0108) — both search paths now exclude only `TRASH`. Narrows ADR 0073 on the reading surfaces only; every AI-layer query keeps `is_archived = 0` | — |
| **Find mail you sent** | ✅ | same change — this was the bug compose created: a sent copy carries `SENT` and no `INBOX`, so `is_archived = 1` made it unfindable | — |
| Search operators (`from:`, `has:attachment`, date range) | ✅ | **shipped 2026-08-25** (ADR 0126) — parsed on both surfaces; an operator narrows the result to mail | — |
| Provider-side search pass-through | ✖ | the only provider `q=` uses are the backfill window and the junk peek | Deferrable — local index first |
| Find-in-thread | ✖ | — | Deferrable |

### 1.6 Accounts and identity

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| Gmail (primary) connect / disconnect | ✅ | `gmail.modify` scope | — |
| Secondary Gmail, Outlook/M365, IMAP (Yahoo/AOL/iCloud) | ✅ | ADR 0080; `routes/email.ts:389,406,427` | — |
| Per-account sync, remove, reconnect-with-stored-credential | ✅ | `routes/email.ts:512,525` | — |
| Dead credential → `409 needsReconnect` | ✅ | `routes/email.ts:93` | — |
| Per-account signature | ✖ | one signature per user | Deferrable |
| Per-account inbox switching | ✅ | **shipped 2026-08-24** (ADR 0119) | — |

### 1.7 Freshness and notification

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| Throttled polling sync | ✅ | `GMAIL_SYNC_THROTTLE_MINUTES`, default 5 | — |
| Live UI updates once a sync lands | ✅ | SSE `email.synced`, `email.thread.updated`, `email.tiles.updated` | — |
| **Push / real-time new mail** | ◐ | **shipped 2026-08-25** (ADR 0118) — Gmail `users.watch`, Graph subscriptions and IMAP IDLE all converge on one `wakeMailbox`. Ships **off** (`MAIL_PUSH_ENABLED=false`) and is unverified end-to-end without a public URL + Pub/Sub topic; polling still runs, so a lapsed registration is a latency regression rather than an outage | **VERIFY IN PROD** |
| **A notification when mail arrives** | ✅ | **shipped 2026-08-25** (ADR 0117) — off the mirror, so all four mailbox kinds notify identically; own toggle, respects quiet hours, skips bulk | — |

### 1.8 Privacy and safety

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| HTML sanitized before render | ✅ | allowlist at `email-body.tsx:94` | — |
| Referrer suppressed on images | ✅ | `referrerpolicy: 'no-referrer'` (`email-body.tsx:106`) | — |
| **Block remote images / "load images?" prompt** | ✅ | **shipped 2026-08-25** (ADR 0120) — blocked by default with a per-sender allow; inline `background-image` stripped too, `cid:` left alone | — |
| **Remote images render (proxied)** | ✅ | **shipped 2026-08-25** (ADR 0136) — loaded by default and always fetched by the server, never the device, so the sender gets no IP/device/correlation; ADR 0120's block-and-offer is what the off switch restores | — |
| **`List-Unsubscribe` handling** | ✅ | **shipped 2026-08-25** (ADR 0122) — captured on all three providers and offered as three honestly-different actions; `email_unsubscribes` is the bulk-gate signal | — |
| Bcc never persisted | ✅ | rides the outbound header only; no `bcc_emails` column | DELIBERATE (ADR 0069) |

### 1.9 Settings and rules

| Capability | State | Evidence | Verdict |
|---|---|---|---|
| Signature editor | ✅ | Settings → Email | — |
| Inbox-digest toggle | ✅ | `users.email_digest_enabled` | — |
| Sync tiles to Gmail labels | ✅ | `users.gmail_sync_labels_enabled` | — |
| **Filters / rules editor** | ✅ | **shipped 2026-08-25** (ADR 0123) — routing rules only; archive/label/mark-read stay with the provider per ADR 0107 | — |
| **Vacation / auto-responder** | ✅ | **shipped 2026-08-25** (ADR 0124) — ours rather than each provider's, so all three mailboxes get one and none needs a new OAuth scope | — |
| Per-sender notification rules | ✖ | — | Deferrable |

---

## §2 — Per-provider matrix

ADR 0080 presents four mailboxes behind one abstraction. It is not uniform, and
the seams are worth knowing before anything is built on top of them.

| Operation | Gmail (primary) | Gmail (secondary) | Outlook / Graph | IMAP |
|---|---|---|---|---|
| Connect, backfill, incremental sync | ✅ | ✅ | ✅ | ✅ |
| Scope of sync | all mail in window, SPAM excluded | same | Inbox + Sent (ADR 0116) | INBOX + Sent (ADR 0116) |
| Threading | native `threadId` | native | `conversationId` | ◐ synthesized from `References` / subject |
| Send a reply | ✅ | ✅ | ✅ | ✅ (SMTP) |
| Compose / forward / drafts / attachments on send | ✖ | ✖ | ✖ | ✖ |
| Mark read / unread | ✅ | ✅ | ✅ | ✅ (`\Seen`) |
| Archive | ✅ | ✅ | ◐ archive real, **un-archive local-only** | ✖ **local-mirror-only both ways** |
| Arbitrary labels | ✅ | ✅ | ✖ silently dropped | ✖ silently dropped |
| Create a label | ✅ (`Chord/*` only) | ◐ method exists, no caller | ✖ | ✖ |
| Category → label sync | ✅ | ✖ | ✖ | ✖ |
| Trash / delete / star / snooze / move | ✖ | ✖ | ✖ | ✖ |
| Detect a provider-side delete | ✅ | ✅ | ✅ | ✅ |
| Junk peek + rescue | ✅ | ✅ | ✅ | ✅ |
| Attachment download | ✅ | ✅ | ✅ | ✅ |
| **Attachment → knowledge base import** | ✅ | ✖ | ✖ | ✖ |
| `.ics` invite probe | ✅ | ✅ | ✅ | ✅ |
| **iTIP RSVP reply** | ✅ | ✖ | ✖ | ✖ |
| Classifier / magics / person extraction | ✅ | ✅ | ✅ | ✅ |
| Mock seam for dev | ✅ | ✅ | ✅ | ✅ |

**Three features are primary-Gmail-only** despite the abstraction: attachment→KB
import (hard-gated `account_id IS NULL`, `email/attachment-import.ts:52`),
category-label sync, and the iTIP RSVP send. A user whose main mailbox is Outlook
or Yahoo silently gets a lesser product.

---

## §3 — What the AI does, and where its power stops

This is the half no other mail app has. It is also the half that ships **off**.

### 3.1 What is built

| Capability | Where |
|---|---|
| Two-level category tree from an in-repo LLM classifier, with deterministic sender routing ahead of it | `email/llm-classifier.ts` (ADR 0066) |
| An orthogonal **action axis** (`to_do` / `reply_needed` / `informational` / `other`) judged in the same call | ADR 0086 |
| Attention-weighted tile map; tile area ∝ open decisions | ADR 0068 / 0083 |
| Tiles that carry **facts** — timeline / state board / ledger, fail-closed | `email/tile-facts.ts` (ADR 0087) |
| **Magics** — commitments mined from mail, staged as proposals, never written | `email/magics.service.ts` (ADR 0063) |
| Calendar invites parsed deterministically, keyed on the RFC-5545 UID, reconciled with a Google-side accept in either order | `email/invite-ics.ts` (ADR 0074) |
| **RSVP from the card** — Yes / Maybe / No, patch-when-possible, iTIP-mail-when-not | `google/rsvp.service.ts` (ADR 0104) |
| World context injected before extraction (calendar / tasks / trips) | `email/magics-context.ts` (ADR 0088) |
| People and family facts mined from mail | `email/person-extraction.ts` (ADR 0076) |
| Email attachments into the knowledge base — extraction, FTS, `send_file` | ADR 0071 |
| User-declared routing rules consulted before anything else | ADR 0077 / 0097 |
| Attention-first email section on the daily briefing | `email/digest.service.ts` |
| Deciding a suggestion marks its source mail read | `email/thread-read.ts` |
| Trashing a thread retracts its pending suggestions | ADR 0073 |
| Four bot tools: `summarize_email`, `search` over mail, `set_email_route`, `list_email_routes` | `bot/tools.ts` |

### 3.2 The write boundary — deliberately narrow

The AI's only three writes to a real mailbox are:

1. **Mark read**, when the user decides one of its suggestions.
2. **Apply a `Chord/<category>` label**, only on explicit opt-in.
3. **Send an iTIP reply**, only on an explicit RSVP tap, only when the calendar
   patch route is unavailable.

Everything else it produces is a **proposal** the user taps. That posture is
correct and should survive everything in §6.

### 3.3 AI-side gaps

| Gap | Detail | Verdict |
|---|---|---|
| **The whole layer ships inert** | `GMAIL_ENABLED=false`, `EMAIL_CLASSIFIER=''`, `EMAIL_MAGICS_ENABLED=false`, `EMAIL_PERSONS_ENABLED=false` are the defaults (`config/env.ts:308,330,342,122`) | **MUST DECIDE** — what the default install looks like |
| **Mail yields only two suggestion shapes** | ◐ | **widened 2026-08-25** (ADR 0132) — `create_task` joins event and list item, with a due date when the email states one. Trip, save and reservation stay out deliberately: a timed reservation IS an event, and trips need their own ADR | — |
| ~~The bot cannot reply to an email~~ | **shipped 2026-08-24** — `reply_to_email`, the first and only member of `PROPOSABLE_TOOLS`: the bot drafts, the user taps Send (§3.4). Sender-only; reply-all deliberately not expressible | — |
| **Bodies are not searchable** | ✅ | **shipped 2026-08-25** (ADR 0110) — a message-level tsvector, plus a sync that actually captures bodies | — |
| **Bulk mail leaks into the AI passes** | LinkedIn updates reach Action Items; a retailer's hero image is indexed into the KB. Ten open owner decisions are already written up | **BLOCKED on a decision** — [`Email-bugsandbacklog.md`](./Email-bugsandbacklog.md) backlog §11 |
| **Autonomy is binary** | everything is proposed; no T0/T1/T3 tiers | Owned by `chord_email.md` §15 Stage 3c |
| **Conflicts are not consulted at proposal time** | conflict detection exists and the card does not carry it | Owned by §15 Stage 3b |
| **No sender reputation / yield signal** | bulk demotion is a hardcoded 15-domain list | Owned by §15 Stage 4 |
| **The email→proposal join is a string convention** | `gmail:<threadId>`, not a real relationship | Owned by `chord_email.md` §9.6 |
| **The miss rate is uninstrumented** | Forward-to-Chord was removed 2026-08-21; SMTP receive never wired. §10 calls this the only true failure metric | **BLOCKED** on Workstream K |
| `summarize_email` has no once-per-turn cap | **fixed 2026-08-25** — `claimOncePerTurn`, for the reason ADR 0099 gave `send_briefing`: the ADR 0005 loop re-streams up to 20 times and each summary walks the mailbox | — |
| Proposal expiry is a lazy sweep | only flips on a list read; display is still correct because every query filters on `expires_at` | Acceptable — noted |

---

## §4 — Rest of the product (gaps only)

Summarized, not audited to the same depth. Verified where marked; otherwise
carried from [`README.md`](./README.md) and
[`friends-and-family-release.md`](./friends-and-family-release.md).

| Surface | Gaps |
|---|---|
| **Chat** | No typing indicators, read receipts, or reactions. No message edit/delete. Bridges (Telegram / WhatsApp / Slack / Discord) self-disable without credentials. *(`DELETE /groups/:id` and `POST /groups/:id/leave` **do** exist — `routes/groups.ts:266,301` — the "Known gaps → Groups" entry in `README.md` is stale and should be struck.)* |
| **Calendar** | No native date/time picker for task `dueAt`; events are created from a parseable free-form string. Recurring events are not first-class. |
| **To Do's** | **Finance is a deliberate scaffold, not implemented** (ADR 0070). No delete/edit UI for tasks, list items, or saves beyond toggle. |
| **Bot / tools** | No `update_task`; a reschedule arrives as another `create_task` and is folded (ADR 0095). Text-fence fallback providers cannot round-trip read-side tools. |
| **Connectors** | WhatsApp production is **externally blocked** on Meta business verification. In-window briefing buttons are parked (design question D9). |
| **Billing** | Stripe one-time checkout is built and **has never run against real keys**. Subscriptions are net-new — the service only does `mode: 'payment'`. Refunds and IAP deferred. |
| **Ops** | **Sentry is not wired** — production errors exist only in VM log files. No production build path (kernel rsync). Admin UI in `client/` is an unimplemented Phase 4 placeholder. |
| **Distribution** | Android sign-in stays broken until `assetlinks.json` carries the release SHA-256 (ADR 0081). |

---

## §5 — Verdict summary

Counting only the mail surface:

- **~35 MUST BUILD**, of which **9 were `S` items that already worked and were
  merely unreachable** from the surface a user would look on. **Five shipped
  2026-08-24** (search entry point, mark-unread, mark-read-on-open, To/Cc display,
  reply-from-chat). **Four remain**: pagination, per-account badge, routing-rules
  UI, recipient autocomplete — plus the remote-image block, which is `S` but is
  new behaviour rather than unreachable behaviour.
- **0 BUG** — all three (IMAP archive, Outlook un-archive, silently-dropped
  labels) were **fixed 2026-08-25**. They were worse than gaps: the mirror was
  telling the user something untrue about their mailbox.
- **3 DELIBERATE** — snooze / unread badges / triage gestures in the AI view
  (`chord_email.md` §5), read receipts, bcc non-persistence.
- **2 BLOCKED** — Gmail real-time push (Pub/Sub infra), miss-rate instrumentation
  (Workstream K SMTP receive).
- **1 formerly BLOCKED on an owner decision** — the bulk-mail gate, decided
  and shipped 2026-08-25 (ADR 0127).

**The cheapest meaningful win** was the nine `S` items above: client wiring over
capability that already existed and already had tests. Five of them took one
session, which is the evidence for the claim — search in particular was a working,
ranked, snippet-highlighting engine sitting one component mount away from the tab
where people would look for it.

~~**The single largest gap** is compose.~~ **Shipped 2026-08-25**, and the bug it
created — *you can send mail you cannot find* — was **fixed the same day** by
ADR 0108. Sent and archived threads had been in the mirror all along behind one
`is_archived = 0`; folders became a predicate over the labels rather than a
second sync, and search stopped filtering by folder entirely.

**Shipped the same day**: message bodies are indexed (ADR 0110). The sync had
been fetching `format=metadata` and throwing away half of a call it was already
paying for, which made body search structurally impossible rather than unbuilt.

**The largest remaining gap** is now freshness: mail arrives by polling only, so
there is no new-mail notification (Wave 5).

---

## §6 — Sequenced plan

Each wave is worth shipping alone, and the order is deliberate: stop lying,
then make the mailbox operable, then make it writable, then make it findable.

### Wave 0 — Stop the mirror lying `S` ✅ shipped 2026-08-25

The only wave that fixes wrong behaviour rather than missing behaviour.

- Real IMAP archive (move to the `\Archive` special-use folder, or refuse).
- Real Outlook un-archive (move back from the archive folder).
- Stop silently dropping `addLabelIds` / `removeLabelIds` on Outlook/IMAP —
  implement, or return a typed refusal the client can render.
- Show which mailbox each row came from.

### Wave 1 — Mailbox verbs — **mostly retired by ADR 0107**

Most of this wave was filing, and filing went to the provider. What survives is
the part that serves *reading*:

- [x] Mark unread; mark read on open. **Done 2026-08-25.**
- [x] Pagination through the `cursor` the server already accepts.
  **Done 2026-08-25** (ADR 0119) — keyset, so mail arriving mid-scroll
  cannot repeat or skip a row.
- [x] Per-account attribution on a row (which mailbox this came from).
  **Done 2026-08-25** (ADR 0119), with a per-mailbox filter alongside it.

Retired, with the thread's provider link as the answer instead: trash / delete,
star / flag, swipe + bulk triage, mark-as-spam, mute, block sender.

### Wave 2 — Outbound `M–L` — ✅ **complete 2026-08-25**

The wave that makes Chord a mail app.

- [x] `POST /me/email/send` — compose, with a From/account picker. **Done.**
- [x] Forward. **Done 2026-08-25** (ADR 0112) — new conversation, quoted
  original, the source message's files carried with it.
- [x] Attachments on send (`multipart/mixed` in the MIME builder; Graph and SMTP
  equivalents). **Done 2026-08-25** (ADR 0111), by attachment id rather than by
  upload, so a sent file stays as an ordinary Chord file.
- [x] Drafts, with autosave. **Done 2026-08-25** (ADR 0113) — Chord's own
  draft store, debounced autosave, one draft per thread for replies.
- [x] Recipient autocomplete. **Done 2026-08-25** (ADR 0114) — from your own
  correspondence and People entries, never a global directory.
- [x] Undo send. **Done 2026-08-25** (ADR 0115) — a server-side hold, so an
  app killed mid-window still sends.
- ~~A `reply_to_email` bot tool~~ — **done 2026-08-24**, as a *proposal*: the bot
  drafts, the user taps Send (§3.4). Sender-only. Reply-all waits for a card that
  shows recipients, since a widened audience must not be invisible at the tap.

### Wave 3 — Finding things `S → M` — **now led by message bodies**

Mostly *surfacing* search rather than building it — the engine already works.

- ~~Mount the existing `SearchModal` on the Email tab~~ — **done 2026-08-24.**
- ~~Let search reach archived + sent mail~~ — **done 2026-08-25** (ADR 0108).
- ~~Browse Sent and Archive~~ — **done 2026-08-25** (ADR 0108). Drafts and Trash
  are deliberate stubs; arbitrary labels still need the label list (§1.3).
- ~~Index message bodies~~ — **done 2026-08-25** (ADR 0110), as a message-level
  tsvector plus a sync that actually captures bodies.
- [x] Operators: `from:`, `has:attachment`, date range. **Done 2026-08-25**
  (ADR 0126) — parsed on both surfaces; an operator narrows to mail.
- [x] Per-account filter. **Done 2026-08-25** (ADR 0119).

### Wave 4 — Parity polish `S–M`

- [x] Remote-image blocking with a per-sender allow. **Done 2026-08-25**
  (ADR 0120) — including the inline-`url()` case, and `cid:` left alone.
- [x] Remote images actually render, through our own fetcher. **Done
  2026-08-25** (ADR 0136) — blocking made a mail-heavy inbox look broken and
  cost a tap per message; the proxy keeps the harms 0120 was written about
  (IP, device, cross-sender correlation) while the mail renders.
- [x] To / Cc display; quoted-text collapse; per-message collapse.
  **Done 2026-08-25** (ADR 0121) — the split is tested in the kernel, and
  resolves every uncertain case to *show everything*.
- [x] `List-Unsubscribe` capture and a one-tap unsubscribe. **Done 2026-08-25**
  (ADR 0122) — three mechanisms, three honest outcomes; `email_unsubscribes`
  is the bulk-gate signal.
- [x] Print / share. **Done 2026-08-25** (ADR 0121) — print on web from the
  sanitized html on screen; Share on native, since print needs a new build.
- [x] Filters/rules editor in Settings. **Done 2026-08-25** (ADR 0123) —
  routing rules only; archive/label/mark-read stay with the provider
  per ADR 0107, and that ADR exists so the answer is findable.
- [x] Vacation responder. **Done 2026-08-25** (ADR 0124) — ours rather than
  each provider's, so all three mailboxes get one and none needs a new
  OAuth scope. Cost: replies ride the sync rather than the provider.

### Wave 5 — Freshness `L`

- [x] New-mail push, reusing the ADR 0054 publisher and its prefs.
  **Done 2026-08-25** (ADR 0117) — provider-agnostic, off the mirror.
- [x] Gmail `users.watch` + Pub/Sub; Graph change subscriptions; IMAP IDLE.
  **Done 2026-08-25** (ADR 0118) — all three nudge one shared sync. Ships
  off; unverified end-to-end without a public URL and provider setup.

### Not in a wave — decide first

**All three are now written up, with recommendations, in
[`email-owner-decisions.md`](./email-owner-decisions.md).** They are owner
calls; nothing engineering-side is blocked on them.

- [x] **The bulk-mail gate.** **Decided + shipped 2026-08-25** (ADR 0127) —
  deny-list behind `EMAIL_BULK_GATE`; skipping needs the header and the
  classifier to agree, and action/known-sender/Events override it.
- **What the default install looks like** — four flags ship off, and they are
  not one switch: `GMAIL_ENABLED` is *read my mail*, the other three are
  *reason about my mail*. Recommendation: reader + classifier on, AI passes
  opt-in until the gate lands.
- **Whether Traditional owes snooze.** Recommendation: defer — it is a to-do
  with a date, and ADR 0092 already gave those an exit.

The AI roadmap is **not** re-sequenced here — `chord_email.md` §15 owns Stage 3b
(reconcile to a delta), 3c (tier policy), 4 (signals) and 5 (suggestion). This
document only adds what §15 does not cover: reply-from-chat, the narrow
suggestion vocabulary, and the ship-inert defaults.

---

## Appendix — the searches behind the absences

Run from the repo root. Each established a ✖ above.

```bash
grep -rni "snooze" server/src                                   # 0 hits
grep -rn  "STARRED" server/src                                  # test fixture only
grep -rniE "\bdrafts?\b" server/src/services/email server/src/routes/email.ts   # 0 hits
grep -rniE "\bforward" server/src/services/email server/src/routes/email.ts     # taxonomy strings only
grep -rniE "users/watch|subscriptions|client\.idle" server/src/services/google server/src/services/email-accounts
grep -rniE "messages\.trash|/trash|EXPUNGE" server/src/services/google server/src/services/email-accounts   # 0 hits
grep -rn  "cursor" mobile/app/email mobile/src/email-*.tsx      # 0 hits
grep -rniE "selectedIds|multiSelect|checkbox|Swipeable|onLongPress" mobile/app/email mobile/src/email-*.tsx  # 0 hits
grep -rln "SearchModal" mobile/                                 # mounted only in groups/[id]/index.tsx
```

Search **exists** — these two lines are what scope it (an earlier draft of this
document read the `SearchModal` grep above as "no email search," which was wrong):

```bash
sed -n '1353p' 'mobile/app/groups/[id]/index.tsx'   # groupId undefined ⇒ global, when the group is personal
grep -an "want('email')" server/src/services/search.service.ts  # gated on && input.crossGroup
# (-a because grep reports search.service.ts as binary)
```

Load-bearing positive checks:

```bash
grep -n "meEmail" kernel/src/api.ts                             # no send/compose/search/labels path
sed -n '239,256p' server/src/services/google/gmail-sync.ts      # ReplyMimeInput — no attachments
grep -n "is_archived" server/src/services/google/gmail.service.ts   # :966 unconditional filter
sed -n '420,436p' server/src/services/email-accounts/accounts.service.ts  # the label narrowing
sed -n '1402,1409p' server/src/db/migrate.ts                    # search_tsv — no body column
```
