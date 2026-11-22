/**
 * Mailbox folders as PREDICATES (ADR 0108).
 *
 * Sent and archived mail was never missing from the mirror: Gmail's backfill
 * lists all mail (`newer_than:Nd`, no `in:inbox`), and a thread archived on
 * the provider side keeps its row and merely loses INBOX. Every listing
 * carried an unconditional `is_archived = 0` (ADR 0073), so the rows were
 * there and unreachable. A folder is therefore a WHERE clause over the label
 * set we already store, not a column and not a second sync.
 *
 * SPAM has no predicate on purpose: junk is never mirrored (the sync skips it
 * and the live peek reads the provider directly), so a label that cannot
 * appear in this table gets no clause pretending to filter it.
 *
 * `prefix` is the caller's table alias, because these predicates are shared by
 * the thread list and both search paths (ADR 0085) and each builds its query
 * differently.
 */
import { sql, type Expression } from 'kysely';

import type { EmailFolder } from '@chord/kernel';

const has = (prefix: string, label: string) =>
  sql<boolean>`${sql.ref(`${prefix}gmail_label_ids`)} @> ${JSON.stringify([label])}::jsonb`;

const hasChord = (prefix: string, label: string) =>
  sql<boolean>`${sql.ref(`${prefix}chord_label_ids`)} @> ${JSON.stringify([label])}::jsonb`;

export function folderPredicate(folder: EmailFolder, prefix = ''): Expression<boolean> {
  const archived = sql.ref(`${prefix}is_archived`);
  // ADR 0129 - a snoozed thread is out of the inbox until its moment. Compared
  // as ISO text, which sorts correctly and needs no clock on the database.
  const now = new Date().toISOString();
  const snoozed = sql.ref(`${prefix}snoozed_until`);
  const awake = sql<boolean>`(${snoozed} is null or ${snoozed} <= ${now})`;
  switch (folder) {
    case 'snoozed':
      return sql<boolean>`${snoozed} is not null and ${snoozed} > ${now} and ${archived} = 0`;
    case 'sent':
      return sql<boolean>`${has(prefix, 'SENT')} and not ${has(prefix, 'TRASH')}`;
    case 'archive':
      // Left the inbox and is not filed anywhere else. Excluding SENT is what
      // keeps your own replies out of the pile of mail you dealt with.
      return sql<boolean>`${archived} = 1 and not ${has(prefix, 'SENT')} and not ${has(prefix, 'TRASH')}`;
    case 'inbox':
    default:
      // A provider may keep INBOX on a trashed message; Trash is never inbox.
      return sql<boolean>`${archived} = 0 and ${awake} and not ${has(prefix, 'TRASH')}`;
  }
}

/**
 * Threads carrying a given label (ADR 0125 + ADR 0141). Provider labels live
 * in `gmail_label_ids`; Chord labels in `chord_label_ids`. Browse uses
 * `searchablePredicate`, not inbox-only, so labelled+archived stays findable.
 */
export function labelPredicate(labelId: string, prefix = ''): Expression<boolean> {
  return sql<boolean>`(${has(prefix, labelId)} or ${hasChord(prefix, labelId)})`;
}

/**
 * ADR 0142 — search `label:` match: Chord names case-insensitively, or an
 * exact provider label id paste. Shared by both search paths (ADR 0085).
 */
export function searchLabelPredicate(label: string, prefix = ''): Expression<boolean> {
  const needle = label.trim().toLowerCase();
  const exact = JSON.stringify([label.trim()]);
  return sql<boolean>`(
    ${sql.ref(`${prefix}gmail_label_ids`)} @> ${exact}::jsonb
    or exists (
      select 1
        from jsonb_array_elements_text(${sql.ref(`${prefix}chord_label_ids`)}) as t(v)
       where lower(t.v) = ${needle}
    )
  )`;
}

/**
 * What search may reach: everything the mirror holds except deleted mail.
 *
 * Search deliberately does NOT reuse `folderPredicate` — a folder answers
 * "where does this live", search answers "does this exist", and the whole
 * point of the fix is that you can find a message without knowing which
 * folder it landed in.
 */
export function searchablePredicate(prefix = ''): Expression<boolean> {
  return sql<boolean>`not ${has(prefix, 'TRASH')}`;
}
