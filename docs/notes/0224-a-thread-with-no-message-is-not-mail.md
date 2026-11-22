# 0224 — A thread with no message is not mail

Status: accepted (2026-10-02)

## Context

Reported from prod: the AI views listed emails that "don't exist"; tapping
one opened an empty screen.

Checked in the prod database rather than assumed. The dead entries were real
rows on the server, not a stale list on the phone. 47 `email_threads` rows
held no `email_messages` row at all (37 IMAP, 10 Outlook). All but one were
created on 2026-09-24, and every one has `created_at = updated_at =
last_message_at`, `message_count` 1 and no labels. That is exactly what
`ensureThreadRow` writes, and nothing else.

Every sync path writes the thread row first and its message second
(`ensureThreadRow`, then `upsertMessageMeta`) as two separate statements.
When the second throws, the first stays. 24 September is the day the content
key was missing during the encryption rollout (ADR 0201/0206), so sealing the
message failed and the thread rows were left behind. `recomputeThread` deletes
a message-less thread, but a sync that threw never reaches its recompute, and
nothing else looks.

Such a row is unarchived (`is_archived` 0), so the inbox list, the category
tiles and the recent-mail lines all show it. `getThreadWith` returned it with
an empty message list, which the reader drew as a blank email with a reply
button.

A second way to the same screen was found while reading that path: opening a
Gmail thread fetches any body not yet stored, and `messages.get` returning 404
(deleted for good at Gmail, with the history record never having reached us)
was `if (!raw) continue` — the row stayed, listed as inbox mail, with no body.
Not shown to be in the report, but it is the same failure and the same line.

## Decision

A thread with no message is not mail, and it is removed wherever it is met.

- **On every sync** — `reapEmptyThreads(db, userId)` runs first in the
  post-sync passes, above the ADR 0079 gate and at `mirror` depth, and removes
  the user's message-less threads older than five minutes through
  `recomputeThread` (so anything suggested from one is retired too). The five
  minutes is the gap between the two inserts: a row that young may still be
  waiting for its message. No migration: the first sync after deploy clears
  the existing rows.
- **On open** — `getThreadWith` treats a thread with no message as not found:
  it recomputes (which deletes it) and returns null, so the route answers 404.
- **A message the provider no longer has is dropped on open** — the body
  fetcher returns the row ids that came back 404 (`BodyFetchOutcome.gone`);
  `getThreadWith` deletes them and recomputes. Primary and attached Gmail.
  Gmail's `getMessage` returns null for a 404 and throws for everything else,
  so a transient failure never deletes mail.
- **The reader says so** — a 404 shows "This email is no longer in your
  mailbox" with a way back, and clears the old copy from the screen.
- **The recent-mail lines re-read on focus** — their stream is closed while
  the reader is in front, so a change made there was not heard.

## Rejected

- **Making the two inserts one transaction** — the right fix for new rows,
  but there are nine call sites across four providers, and it would not remove
  the 47 that exist. The sweep covers both, at the cost of a blank row living
  for at most one sync.
- **A migration to delete them** — clears today's rows and nothing after.
- **Filtering message-less threads out of each list query** — every list,
  count and search would need the same `EXISTS`, and the row would still be
  there for the next query that forgot it (ADR 0085's lesson).
- **Dropping an Outlook message on a 404** — Graph re-issues a message's id
  when it moves folders (ADR 0199), so a 404 there can mean "moved", not
  "deleted". Left alone; Outlook stores bodies at sync, so that fetch is rare.

## Consequences

- The mail those 47 rows stood for was never mirrored: the message write
  failed and the cursor moved on. Removing the rows makes the lists honest; it
  does not bring that mail back. Whether a failed message write should hold
  the sync cursor is a separate question, not answered here.
- A message deleted at Gmail without a history record is only noticed when
  its thread is opened. A background check is not built.
- One of the two emails in the report (the LinkedIn one) is in the Gmail inbox
  and in the mirror with its body, so this does not explain it.
