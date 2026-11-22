/**
 * ADR 0142 — one-way push of Chord labels into the provider mailbox.
 *
 * Local `chord_label_ids` always win. Failures here are logged and never
 * thrown to the route. Never read categories/keywords back into Chord.
 */
import { chordImapKeyword, chordProviderLabel } from '@chord/kernel';
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import { mapConcurrent } from '../../utils/concurrency.js';
import { getGmailApi, type GmailApi, type GmailLabel } from '../google/gmail-api.js';
import {
  getAccount,
  nativeId,
  openAuthBlob,
  type AccountRow,
  type ImapAuth,
} from '../email-accounts/account-utils.js';
import { gmailAccountApi } from '../email-accounts/gmail-account.service.js';
import { mockImapApi, withImapSession } from '../email-accounts/imap-api.js';
import { uidFromNativeMessageId } from '../email-accounts/imap-sync.js';
import { getOutlookApi } from '../email-accounts/outlook-api.js';
import { forgetGmailLabels } from './gmail-label-cache.js';
import { findLabel } from './gmail-label-find.js';
import { chordGmailLabel, mailboxKeyOf } from './mailbox-folder-memory.js';


export async function pushChordLabels(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  patch: { addChordLabels?: string[]; removeChordLabels?: string[] },
): Promise<void> {
  const add = (patch.addChordLabels ?? []).map((s) => s.trim()).filter(Boolean);
  const remove = (patch.removeChordLabels ?? []).map((s) => s.trim()).filter(Boolean);
  if (add.length === 0 && remove.length === 0) return;

  try {
    const thread = await db
      .selectFrom('email_threads')
      .select(['id', 'account_id', 'gmail_thread_id'])
      .where('id', '=', threadRowId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!thread) return;

    if (!thread.account_id) {
      await pushPrimaryGmail(db, userId, thread.gmail_thread_id, add, remove);
      return;
    }
    const account = await getAccount(db, userId, thread.account_id);
    if (!account) return;
    if (Number(account.label_push_supported ?? 0) !== 1) return;
    if (Number(account.label_push_enabled ?? 0) !== 1) return;

    if (account.provider === 'gmail') {
      await pushGmailAccount(db, account, thread.gmail_thread_id, add, remove);
    } else if (account.provider === 'outlook') {
      await pushOutlook(db, account, threadRowId, add, remove);
    } else if (account.provider === 'imap') {
      await pushImap(db, account, threadRowId, add, remove);
    }
  } catch (err) {
    logger.warn('chord label push failed', {
      userId,
      threadRowId,
      err: (err as Error).message,
    });
  }
}

async function pushPrimaryGmail(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
  add: string[],
  remove: string[],
): Promise<void> {
  const prefs = await db
    .selectFrom('users')
    .select('chord_label_push_enabled')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (Number(prefs?.chord_label_push_enabled ?? 0) !== 1) return;

  const api = await getGmailApi(db, userId);
  try {
    await modifyGmailLabels(db, userId, mailboxKeyOf(null), api, gmailThreadId, add, remove);
  } finally {
    // It may have created a label in this mailbox; the remembered list is stale.
    if (add.length > 0) forgetGmailLabels(db, userId);
  }
}

async function pushGmailAccount(
  db: Kysely<DB>,
  account: AccountRow,
  scopedThreadId: string,
  add: string[],
  remove: string[],
): Promise<void> {
  const api = await gmailAccountApi(db, account);
  await modifyGmailLabels(
    db,
    account.user_id,
    mailboxKeyOf(account.id),
    api,
    nativeId(account.id, scopedThreadId),
    add,
    remove,
  );
}

async function modifyGmailLabels(
  db: Kysely<DB>,
  userId: string,
  mailbox: string,
  api: GmailApi,
  threadId: string,
  add: string[],
  remove: string[],
): Promise<void> {
  if (add.length === 0 && remove.length === 0) return;
  // One listLabels() for the whole call instead of one per name applied.
  const labels: GmailLabel[] = await api.listLabels();
  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];
  for (const name of add) {
    // A Chord/ label the user deleted in Gmail is not made again (the label
    // stays on the thread in Chord; only the push stops).
    const label = await chordGmailLabel(db, userId, mailbox, api, labels, chordProviderLabel(name));
    if (label) addLabelIds.push(label.id);
  }
  for (const name of remove) {
    const want = chordProviderLabel(name);
    const found = findLabel(labels, want);
    if (found) removeLabelIds.push(found.id);
  }
  if (addLabelIds.length === 0 && removeLabelIds.length === 0) return;
  await api.modifyThread(threadId, { addLabelIds, removeLabelIds });
}

async function pushOutlook(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
  add: string[],
  remove: string[],
): Promise<void> {
  const msgs = await db
    .selectFrom('email_messages')
    .select('gmail_message_id')
    .where('thread_id', '=', threadRowId)
    .where('user_id', '=', account.user_id)
    .execute();
  if (msgs.length === 0) return;

  const api = await getOutlookApi(db, account);
  const addCats = add.map(chordProviderLabel);
  const removeCats = new Set(remove.map(chordProviderLabel));
  // Graph has no batch endpoint for categories (OutlookApi has no $batch), so
  // this is bounded-concurrent per message rather than sequential.
  await mapConcurrent(msgs, env.GMAIL_FETCH_CONCURRENCY, async (m) => {
    const native = nativeId(account.id, m.gmail_message_id);
    const current = await api.getCategories(native);
    if (current === null) return;
    const next = [
      ...current.filter((c) => !removeCats.has(c) && !addCats.includes(c)),
      ...addCats,
    ];
    // Skip no-ops.
    if (
      next.length === current.length &&
      next.every((c, i) => c === current[i])
    ) {
      return;
    }
    await api.setCategories(native, next);
  });
}

async function pushImap(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
  add: string[],
  remove: string[],
): Promise<void> {
  const msgs = await db
    .selectFrom('email_messages')
    .select('gmail_message_id')
    .where('thread_id', '=', threadRowId)
    .where('user_id', '=', account.user_id)
    .execute();
  const uids = msgs
    .map((m) => uidFromNativeMessageId(nativeId(account.id, m.gmail_message_id)))
    .filter((n): n is number => n != null && n > 0);
  if (uids.length === 0) return;

  const addKw = add.map(chordImapKeyword);
  const removeKw = remove.map(chordImapKeyword);
  // Mock mailboxes store no sealed auth (ADR 0080 connect path); openAuthBlob
  // would throw and the outer fail-soft would swallow a push that never ran.
  if (env.IMAP_PROVIDER === 'mock') {
    await mockImapApi(account.id).setKeywords(uids, addKw, removeKw);
    return;
  }
  const auth = openAuthBlob<ImapAuth>(account);
  await withImapSession(account.id, auth, async (api) => {
    await api.setKeywords(uids, addKw, removeKw);
  });
}

/** Persist IMAP keyword capability from a probe (connect / sync). */
export async function recordImapLabelPushSupport(
  db: Kysely<DB>,
  accountId: string,
  supported: boolean,
): Promise<void> {
  await db
    .updateTable('email_accounts')
    .set({
      label_push_supported: supported ? 1 : 0,
      // Turning capability off must clear opt-in so the UI cannot claim push.
      ...(supported ? {} : { label_push_enabled: 0 }),
      updated_at: new Date().toISOString(),
    })
    .where('id', '=', accountId)
    .execute();
}
