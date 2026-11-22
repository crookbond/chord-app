/**
 * Browsing by label (ADR 0125 + ADR 0141).
 *
 * The list is derived from the MIRROR rather than fetched from a provider,
 * which is what makes it provider-agnostic: every provider lands its label set
 * in the same `gmail_label_ids` column, so one query answers for all of them.
 * Chord labels (ADR 0141) live in `chord_label_ids` and are unioned in with
 * `scope: 'chord'`. Where a provider gives us no user labels (Outlook and IMAP
 * carry only the synthetic INBOX / UNREAD / SENT), the provider half is
 * honestly short rather than absent.
 *
 * Provider labelling stays a Gmail write (ADR 0107). Chord labels are local.
 */
import { listNameKey } from '@chord/kernel';
import { sql, type Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import { getGmailApi } from '../google/gmail-api.js';
import { cachedGmailLabels } from './gmail-label-cache.js';
import type { DB } from '../../db/schema.js';

/**
 * Gmail's system labels. Every one is an uppercase constant; a user label's id
 * looks like `Label_17`, so "not in this set and not a CATEGORY_" is a
 * complete test without asking the API what type each label is.
 */
const SYSTEM_LABELS = new Set([
  'INBOX',
  'SENT',
  'UNREAD',
  'READ',
  'DRAFT',
  'SPAM',
  'TRASH',
  'STARRED',
  'IMPORTANT',
  'CHAT',
  'ARCHIVE',
]);

function isUserLabel(id: string): boolean {
  return !SYSTEM_LABELS.has(id) && !id.startsWith('CATEGORY_');
}

export interface EmailLabelRow {
  id: string;
  name: string;
  threads: number;
  scope: 'provider' | 'chord';
}

/** Distinct provider label ids across this user's mirror, with how much is filed under each. */
async function providerLabelCounts(db: Kysely<DB>, userId: string): Promise<Map<string, number>> {
  const rows = await sql<{ label: string; n: string }>`
    select jsonb_array_elements_text(gmail_label_ids) as label, count(*)::text as n
    from email_threads
    where user_id = ${userId}
    group by 1
  `.execute(db);
  const out = new Map<string, number>();
  for (const r of rows.rows) {
    if (isUserLabel(r.label)) out.set(r.label, Number(r.n));
  }
  return out;
}

/**
 * Chord labels, collapsed by `listNameKey` so "Family" and "family" count as
 * one. Display name is the first spelling we saw.
 */
async function chordLabelCounts(
  db: Kysely<DB>,
  userId: string,
): Promise<Map<string, { name: string; threads: number }>> {
  const rows = await sql<{ label: string; n: string }>`
    select jsonb_array_elements_text(chord_label_ids) as label, count(*)::text as n
    from email_threads
    where user_id = ${userId}
    group by 1
  `.execute(db);
  const out = new Map<string, { name: string; threads: number }>();
  for (const r of rows.rows) {
    const key = listNameKey(r.label);
    if (!key) continue;
    const n = Number(r.n);
    const prev = out.get(key);
    if (prev) {
      prev.threads += n;
    } else {
      out.set(key, { name: r.label, threads: n });
    }
  }
  return out;
}

/**
 * Resolve Gmail's opaque label ids to their names.
 *
 * Only Gmail needs this - it is the only provider whose ids are not already
 * the name - and only when the mirror actually holds some, so a mailbox with
 * no user labels costs no API call.
 */
async function gmailLabelNames(
  db: Kysely<DB>,
  userId: string,
  wanted: Set<string>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (wanted.size === 0) return names;
  try {
    const api = await getGmailApi(db, userId);
    for (const l of await cachedGmailLabels(db, userId, api)) {
      if (wanted.has(l.id)) names.set(l.id, l.name);
    }
  } catch (err) {
    // A disconnected or unscoped mailbox is not an error here: the ids still
    // browse, they just show as themselves.
    logger.info('label names unavailable', { userId, err: (err as Error).message });
  }
  return names;
}

/**
 * The labels this user can browse (provider + Chord).
 *
 * Sorted by how much is filed under each, because a label with two threads in
 * it is not what someone is looking for.
 */
export async function listBrowsableLabels(
  db: Kysely<DB>,
  userId: string,
): Promise<EmailLabelRow[]> {
  const [providerCounts, chordCounts] = await Promise.all([
    providerLabelCounts(db, userId),
    chordLabelCounts(db, userId),
  ]);
  const names = await gmailLabelNames(db, userId, new Set(providerCounts.keys()));
  const rows: EmailLabelRow[] = [
    ...[...providerCounts.entries()].map(([id, threads]) => ({
      id,
      name: names.get(id) ?? id,
      threads,
      scope: 'provider' as const,
    })),
    ...[...chordCounts.values()].map(({ name, threads }) => ({
      id: name,
      name,
      threads,
      scope: 'chord' as const,
    })),
  ];
  return rows.sort((a, b) => b.threads - a.threads || a.name.localeCompare(b.name));
}
