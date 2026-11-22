/**
 * Files going OUT on a message (ADR 0111).
 *
 * The wire carries Chord attachment ids, never bytes: the file is already on
 * the server, and a device pick uploads through the normal attachment route
 * first, so compose, reply and "send me the itinerary" all use one shape.
 *
 * Two rules live here rather than at the call sites, because there are three
 * providers and three routes and any of them could forget:
 *
 * 1. **An id is not permission.** `getAttachment` looks up by id with no scope
 *    check at all, so resolving one straight from a request body would let any
 *    user mail themselves any file in the system by guessing an id. Every id
 *    goes through `canRead` first.
 * 2. **Size is refused, never truncated.** Providers differ by an order of
 *    magnitude, and a message that silently loses its attachment is the ADR
 *    0107 failure — a write we did not really perform, reported as done.
 */

import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import { readBlob } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { absolutePathFor, getAttachment } from '../attachments.service.js';
import { isMember } from '../groups.service.js';

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Raised for anything the sender should be told before the message goes. */
export class AttachmentRejected extends Error {}

/**
 * What each provider will actually accept, in bytes of source (before base64
 * inflates it by a third).
 *
 * Deliberately per-provider rather than one shared floor. Graph's inline
 * `fileAttachment` path tops out around 3MB while Gmail's raw upload takes
 * tens of MB, so a common cap would cripple Gmail to flatter Outlook. "This
 * file is too big for that mailbox" is a true and useful sentence; pretending
 * every mailbox is the smallest one is not.
 */
const PROVIDER_LIMIT: Record<string, number> = {
  gmail: 24 * 1024 * 1024,
  outlook: 3 * 1024 * 1024,
  imap: 18 * 1024 * 1024,
};

const PROVIDER_LABEL: Record<string, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  imap: 'this mailbox',
};

function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** Can this user actually see this file? Group files need membership; a
 *  personal file needs to be theirs. */
async function canRead(
  db: Kysely<DB>,
  userId: string,
  scope: { kind: 'group'; groupId: string } | { kind: 'user'; userId: string },
): Promise<boolean> {
  if (scope.kind === 'user') return scope.userId === userId;
  return isMember(db, scope.groupId, userId);
}

/**
 * Names and sizes for a draft's files, so a resumed draft can list them. A file
 * that is gone or not the user's is left out rather than named - the same
 * "an id is not permission" rule as the loader, applied to a read.
 */
export async function describeOutgoingAttachments(
  db: Kysely<DB>,
  userId: string,
  ids: string[],
): Promise<Array<{ id: string; filename: string; size: number }>> {
  const found = await Promise.all(
    ids.map(async (id) => {
      const att = await getAttachment(db, id);
      if (!att || att.blobMissing || !(await canRead(db, userId, att.scope))) return null;
      return { id, filename: att.filename, size: att.size };
    }),
  );
  return found.filter((f): f is { id: string; filename: string; size: number } => f !== null);
}

/**
 * Load the files for one outgoing message.
 *
 * Throws `AttachmentRejected` with a sentence meant for the sender: a missing
 * file, a file that is not theirs, a blob that outlived its row, or a total
 * over what the mailbox takes. A caller that catches this should show it and
 * NOT send — a message that goes without its attachment has quietly failed.
 */
export async function loadOutgoingAttachments(
  db: Kysely<DB>,
  userId: string,
  ids: string[] | undefined,
  provider: 'gmail' | 'outlook' | 'imap',
): Promise<OutgoingAttachment[]> {
  if (!ids?.length) return [];

  // Independent per id — the kernel's `attachmentIdList` already caps this at
  // 10, so a plain `Promise.all` is enough; no need for a concurrency bound.
  const out = await Promise.all(
    ids.map(async (id) => {
      const att = await getAttachment(db, id);
      // One message for absent and for forbidden. Distinguishing them tells a
      // caller which ids exist, which is the whole of an id-guessing attack.
      if (!att || !(await canRead(db, userId, att.scope))) {
        throw new AttachmentRejected('That file could not be attached.');
      }
      if (att.blobMissing) {
        throw new AttachmentRejected(`"${att.filename}" is no longer stored and cannot be sent.`);
      }
      let content: Buffer;
      try {
        content = await readBlob(absolutePathFor(att));
      } catch (err) {
        // The row says the blob is there and the disk disagrees. Refusing beats
        // sending a message whose attachment is a zero-byte file.
        logger.warn('outgoing attachment unreadable', {
          userId,
          id,
          err: (err as Error).message,
        });
        throw new AttachmentRejected(`"${att.filename}" could not be read and was not sent.`);
      }
      return { filename: att.filename, mimeType: att.mimeType, content };
    }),
  );

  checkOutgoingSize(out, provider);
  return out;
}

/**
 * Refuse a set of files the mailbox will not take.
 *
 * Separate from the loader because a forward carries files fetched from the
 * PROVIDER rather than from Chord (ADR 0112), and those need the same cap — a
 * limit enforced on one of the two paths is not a limit.
 */
export function checkOutgoingSize(
  files: OutgoingAttachment[],
  provider: 'gmail' | 'outlook' | 'imap',
): void {
  const total = files.reduce((n, f) => n + f.content.byteLength, 0);
  const limit = PROVIDER_LIMIT[provider];
  if (total > limit) {
    throw new AttachmentRejected(
      `Those files come to ${mb(total)}. ${PROVIDER_LABEL[provider]} accepts up to ${mb(limit)} on a message.`,
    );
  }
}
