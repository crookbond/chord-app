# 0303 — A draft is also in the mailbox's own Drafts folder

**Status**: accepted
**Date**: 2026-10-27
**Relation**: extends [ADR 0113](./0113-unsent-mail-is-ours.md) (reverses its
"Gmail's drafts API" rejection as a *copy*, not as the store); keeps
[ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md)'s one-writer rule.

## Context

The owner asked for drafting to save itself about every 30 seconds so a crash
loses nothing, and for the draft to reach the email provider's Drafts folder.
ADR 0113 already saved every draft to Chord's server 1.5s after the user stopped
typing — but from the user's side it looked like there were no drafts: nothing
appeared in Gmail / Outlook / Yahoo, where they look. And the 1.5s save was a
pure debounce, so someone typing without a pause never saved at all.

ADR 0113 rejected the provider drafts API as the *store*: a round trip per
pause, rate limits, three implementations. Those objections are to writing on
every pause, not to writing at all.

## Decision

**Chord's row stays the source; a copy goes to the provider at most every
`EMAIL_PROVIDER_DRAFT_SECONDS` (30).**

- The composer saves to Chord after 1.5s of quiet **or** 30s after the oldest
  unsaved change, whichever comes first (`draftAutosaveDelay`, kernel) — the
  max-wait closes the never-pausing typist gap.
- A worker pass (`syncProviderDrafts`, `worker` leadership duty, ADR 0280)
  copies each draft whose `updated_at` is newer than `provider_synced_at`:
  Gmail `drafts.create/update` (threaded on the Gmail thread, reply headers
  from the same anchor the send uses), Outlook `POST /me/messages` or
  `createReply` then `PATCH`, IMAP `APPEND` to the `\Drafts` folder flagged
  `\Draft` then delete the previous UID (ref = path + UIDVALIDITY + UID). Same
  draft, updated in place — never one copy per save.
- **Text and recipients only, no files.** Re-uploading attachments every 30s
  while someone types buys nothing; the files stay on the Chord draft and go
  out with it on send.
- Which mailbox: the thread's for a reply/forward, else the draft's
  `account_id` (null = primary Gmail) — the same choice the send makes. A From
  change removes the copy from the old mailbox.
- **Sent or discarded → the copy is removed.** `deleteDraft` (used by the
  outbox, the send routes and Delete draft) queues the ref in
  `email_provider_draft_removals`; the pass deletes it. Queued, not inline, so a
  send never waits on or fails because of its own cleanup. A copy written while
  its draft was being sent is queued too.
- Failures back off 1 min doubling to 6h (`provider_retry_at`); a new local
  save resets it. A mailbox with no Drafts folder records
  `provider_error` and is not retried until the text changes. Removals give up
  after 12 attempts with an error log.
- **One direction.** An edit made in Gmail's own editor is not read back; two
  writers to one draft is ADR 0107's problem.
- **Gmail drafts stay out of the mirror**: a message labelled `DRAFT` is skipped
  at backfill and incremental sync (primary and attached). Otherwise Chord's
  copy of a reply would show in its thread as a message. A draft sent from
  Gmail itself (same id, loses `DRAFT`) is fetched when the label change
  arrives. Outlook and IMAP never synced their Drafts folders.

Migration `131` (`provider_*` columns on `email_drafts`, the removals table).

## Consequences

- A crash loses at most 30s of typing; the draft is visible in the user's mail
  app within about a minute.
- Gmail drafts already mirrored before this change stay until their thread is
  re-synced (not swept).
- No new scope: `gmail.modify`, Graph `Mail.ReadWrite`, IMAP login already cover
  drafts.
- No chat tool: nothing new the user does — the bot's drafts (ADR 0214) are the
  same rows and get copied too.
- Not run against live Gmail/Graph/IMAP; built against the documented APIs and
  the mocks. The IMAP path needs UIDPLUS (it refuses rather than piling up
  unremovable copies).

## Alternatives rejected

**Provider drafts as the store** (ADR 0113's original objection still holds).
**A client-side 30s timer to the provider**: a killed app never fires it, and it
would need provider tokens on the device. **Copying attachments**: bandwidth
for nothing. **Two-way draft sync**: two writers, no conflict rule.

## Addendum 2026-11-10: a deletion elsewhere is read back

A copy deleted in Outlook on the web (or Gmail, or another IMAP client) came
back. The write treated "the provider no longer has this copy" as "write a new
one": Outlook `updateDraft` false and Gmail `updateDraft` null both fell
through to a create, and the IMAP `saveDraft` appended regardless. The Chord
draft also stayed in Chord's Drafts list, so the next save of it (any edit, or
reopening the reply composer) put the copy back.

Rule: **the one thing read back from the provider is a deletion, and the
deletion wins.** A copy that is gone, sent, or (Outlook) no longer in the
Drafts folder means the user finished with that draft somewhere else, so the
Chord draft is deleted too, with nothing queued for removal. It is found two
ways:

- **On the next copy.** `writeProviderDraft` returns GONE instead of creating,
  on all three providers (IMAP `saveDraft` checks the old UID before appending
  and returns `{ gone: true }` without writing).
- **By a check on drafts nobody is editing**, so a deleted draft also leaves
  Chord's list without waiting for an edit. Each draft whose copy is current is
  checked at most every 5 minutes (`email_drafts.provider_checked_at`,
  migration `144`), batched per mailbox through a new `missingDrafts(refs)` on
  each provider API: Gmail `drafts.get` 404; Outlook 404, `isDraft` false, or a
  `parentFolderId` other than Drafts; IMAP one UID SEARCH per folder. A failed
  check is not a deletion (logged, asked again next interval), and an IMAP
  folder whose UIDVALIDITY changed is never reported missing.

The delete only removes the version that was looked at (`updated_at`
unchanged, not queued to send), so a save that lands in between survives and
is judged on its own. A composer still open when its draft goes keeps
typing into a fresh draft (ADR 0113's fall-through to an insert), which gets
a fresh copy. The cost is text typed in Chord and left within the same 30
seconds as the deletion elsewhere: the deletion wins over it.

Still one-way, unchanged: an edit made in another app's editor is not read
back.

**Labels and folders follow the same rule.** Filing rules (ADR 0309), Chord
label push (ADR 0142) and the category label sync all ran "find by name,
create if missing", so a folder or `Chord/` label the user deleted came back
with the next email that needed it. Now Chord makes one only the FIRST time:
`users.defaults` `mailbox_folders_seen` (`email/mailbox-folder-memory.ts`)
remembers per mailbox ('primary' or account id) and name (case/spacing
folded) that it has existed; once seen, a missing one is recorded `removed`
and Chord stops writing to it in that mailbox - the filing pass skips it (the
mail stays in the inbox), label push leaves that label off (it stays on the
thread in Chord), the category sync forgets the dead `gmail_label_id`. One
resolver, `chordGmailLabel`, for every Gmail path; Outlook `ensureFolder` and
IMAP `moveToFolder` take `create: false` and the filing path turns a missing
folder into `FolderRemovedError`. Asking again re-arms it: a new filing rule
for that folder, switching label push or label sync back on, or an explicit
"apply category label". Labels Chord made before this are recorded when next
found; one already deleted by then is made once more, then remembered.
Outlook categories and IMAP keywords have no deletion to see (a category or
keyword simply stops showing), so label push there is unchanged.

**Suggested reply writes fresh.** A reply draft is keyed by its thread and
restored into the box on reopen, and Suggested only wrote when the box was
empty - so after a saved draft, every Suggested showed that old draft, even
with new messages since. Suggested now always writes a new reply from the
thread as it stands and does not send the saved draft as text to revise
(`aiDraftToRevise`/`placeAiReply`, kernel `email-signature.ts`); Continue
draft is the way back to the saved one, and a typed ask still revises the
box.
