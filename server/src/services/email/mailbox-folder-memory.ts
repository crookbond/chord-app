/**
 * Which labels and folders Chord has seen in each of the user's mailboxes
 * (ADR 0303 addendum 2026-11-10, same rule as a deleted draft): Chord makes a
 * label or folder only the FIRST time it needs one. Once it has existed in a
 * mailbox, finding it missing means the user deleted it there (in Gmail,
 * Outlook, another mail app), and Chord stops writing to it rather than
 * making it again. Used by filing rules (ADR 0309), Chord label push
 * (ADR 0142) and the category label sync.
 *
 * Keyed by mailbox ('primary' or an account id) and the name as the provider
 * compares it (case and spacing folded). A label Chord made before this
 * memory existed is recorded the first time it is found; one the user had
 * already deleted by then is made once more and remembered from then on.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';
import type { GmailApi, GmailLabel } from '../google/gmail-api.js';
import { defineUserDefault } from '../user-defaults.service.js';
import { findLabel, findOrCreateGmailLabel } from './gmail-label-find.js';

export type FolderState = 'new' | 'seen' | 'removed';

/** Thrown where a write was told not to make the folder and it is not there. */
export class FolderRemovedError extends Error {
  constructor(readonly folder: string) {
    super(`"${folder}" is no longer in this mailbox`);
    this.name = 'FolderRemovedError';
  }
}

/** Beyond this, the oldest entries go (a mailbox has far fewer labels Chord touches). */
const MAX_ENTRIES = 1000;

const memory = defineUserDefault(
  'mailbox_folders_seen',
  z.record(z.string(), z.enum(['seen', 'removed'])),
);

export const PRIMARY_MAILBOX_KEY = 'primary';

export function mailboxKeyOf(accountId: string | null | undefined): string {
  return accountId || PRIMARY_MAILBOX_KEY;
}

function folderKey(mailbox: string, name: string): string {
  return `${mailbox}|${name.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

export interface FolderMemory {
  state(mailbox: string, name: string): FolderState;
}

/** The whole memory in one read, for a pass that asks about many folders. */
export async function loadFolderMemory(db: Kysely<DB>, userId: string): Promise<FolderMemory> {
  const all = (await memory.get(db, userId)) ?? {};
  return { state: (mailbox, name) => all[folderKey(mailbox, name)] ?? 'new' };
}

export async function folderState(
  db: Kysely<DB>,
  userId: string,
  mailbox: string,
  name: string,
): Promise<FolderState> {
  return (await loadFolderMemory(db, userId)).state(mailbox, name);
}

async function record(
  db: Kysely<DB>,
  userId: string,
  mailbox: string,
  name: string,
  state: 'seen' | 'removed',
): Promise<void> {
  const key = folderKey(mailbox, name);
  await memory.update(db, userId, (current) => {
    if (current?.[key] === state) return { value: undefined, result: undefined };
    const next = { ...(current ?? {}) };
    delete next[key];
    next[key] = state;
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete next[k];
    return { value: next, result: undefined };
  });
}

export function noteFolderSeen(db: Kysely<DB>, userId: string, mailbox: string, name: string): Promise<void> {
  return record(db, userId, mailbox, name, 'seen');
}

export async function noteFolderRemoved(
  db: Kysely<DB>,
  userId: string,
  mailbox: string,
  name: string,
): Promise<void> {
  logger.info('label or folder deleted in the mailbox - Chord stops using it there', { userId, mailbox, name });
  await record(db, userId, mailbox, name, 'removed');
}

/**
 * The user asked again (a new filing rule, label push or label sync switched
 * back on, an explicit "apply label"): what they deleted may be made anew.
 * `match` picks which names; no `mailbox` = every mailbox.
 */
export async function forgetRemovedFolders(
  db: Kysely<DB>,
  userId: string,
  match: (name: string) => boolean,
  mailbox?: string,
): Promise<void> {
  await memory.update(db, userId, (current) => {
    if (!current) return { value: undefined, result: undefined };
    let changed = false;
    const next = { ...current };
    for (const [k, v] of Object.entries(current)) {
      if (v !== 'removed') continue;
      const cut = k.indexOf('|');
      if (mailbox && k.slice(0, cut) !== mailbox) continue;
      if (!match(k.slice(cut + 1))) continue;
      delete next[k];
      changed = true;
    }
    return { value: changed ? next : undefined, result: undefined };
  });
}

/** A stored name that is one of Chord's own `Chord/...` labels. */
export function isChordProviderLabel(storedName: string): boolean {
  return storedName.startsWith('chord/');
}

/** A folder name compared the way the memory stores it. */
export function sameFolderName(a: string, b: string): boolean {
  return folderKey('', a) === folderKey('', b);
}

/**
 * The Gmail label called `name` in this mailbox, made only if Chord has never
 * seen one there. Null when the user deleted it (or deleted it before, and
 * has not asked again). `labels` is the caller's list and gains what is made.
 */
export async function chordGmailLabel(
  db: Kysely<DB>,
  userId: string,
  mailbox: string,
  api: GmailApi,
  labels: GmailLabel[],
  name: string,
  opts: { explicit?: boolean } = {},
): Promise<GmailLabel | null> {
  const state = opts.explicit ? 'new' : await folderState(db, userId, mailbox, name);
  if (state === 'removed') return null;
  let found = findLabel(labels, name);
  if (!found && state === 'seen') {
    // The list may predate a label made elsewhere a moment ago.
    found = findLabel(await api.listLabels(), name);
    if (found) labels.push(found);
  }
  if (found) {
    if (state === 'new') await noteFolderSeen(db, userId, mailbox, name);
    return found;
  }
  if (state === 'seen') {
    await noteFolderRemoved(db, userId, mailbox, name);
    return null;
  }
  const made = await findOrCreateGmailLabel(api, labels, name);
  await noteFolderSeen(db, userId, mailbox, name);
  return made;
}
