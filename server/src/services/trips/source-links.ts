/**
 * Resolve, for one viewer, what each trip item was read from: the local email
 * thread behind a `gmail:<threadId>` provenance (ADR 0158 — email-derived legs
 * carry no file), and the file behind a `sourceDocId` (ADR 0071 / attachment
 * classifier). Per-viewer because email thread rows are per-user, and a file
 * is only described to someone allowed to read it.
 */
import type { Kysely } from 'kysely';

import type { TripSourceDoc, TripSourceLinks, TripStatus } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { gmailIdOfProvenance } from '../email/source-thread.js';
import { userCanRead } from '../permissions.service.js';

type Item = TripSourceLinks & { sourceRawContext?: string; sourceDocId?: string };

function itemsOf(s: TripStatus): Item[] {
  return [s.trip, ...s.legs, ...s.accommodations, ...s.reservations];
}

const gmailIdOf = gmailIdOfProvenance;

export async function attachTripSourceLinks(
  db: Kysely<DB>,
  userId: string,
  statuses: TripStatus[],
): Promise<TripStatus[]> {
  const items = statuses.flatMap(itemsOf);

  const gmailIds = [...new Set(items.map((i) => gmailIdOf(i.sourceRawContext)).filter((x): x is string => !!x))];
  const threadByGmailId = new Map<string, string>();
  if (gmailIds.length > 0) {
    const rows = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', 'in', gmailIds)
      .execute();
    for (const r of rows) threadByGmailId.set(r.gmail_thread_id, r.id);
  }

  const docIds = [...new Set(items.map((i) => i.sourceDocId).filter((x): x is string => !!x))];
  const docById = new Map<string, TripSourceDoc>();
  if (docIds.length > 0) {
    const rows = await db
      .selectFrom('attachments')
      .select(['id', 'filename', 'mime_type', 'summary', 'origin_email_thread_id'])
      .where('id', 'in', docIds)
      .execute();
    const originThreads = [...new Set(rows.map((r) => r.origin_email_thread_id).filter((x): x is string => !!x))];
    const ownThreads = new Set<string>();
    if (originThreads.length > 0) {
      const own = await db
        .selectFrom('email_threads')
        .select('id')
        .where('user_id', '=', userId)
        .where('id', 'in', originThreads)
        .execute();
      for (const r of own) ownThreads.add(r.id);
    }
    for (const r of rows) {
      if (!(await userCanRead(db, r.id, userId))) continue;
      docById.set(r.id, {
        id: r.id,
        filename: r.filename,
        mimeType: r.mime_type,
        ...(r.summary ? { summary: r.summary } : {}),
        ...(r.origin_email_thread_id && ownThreads.has(r.origin_email_thread_id)
          ? { emailThreadId: r.origin_email_thread_id }
          : {}),
      });
    }
  }

  const withLinks = <T extends Item>(item: T, viewerCreatedTrip: boolean): T => {
    const gid = gmailIdOf(item.sourceRawContext);
    const threadId = gid ? threadByGmailId.get(gid) : undefined;
    const gone = !!gid && !threadId && viewerCreatedTrip;
    const doc = item.sourceDocId ? docById.get(item.sourceDocId) : undefined;
    if (!threadId && !gone && !doc) return item;
    return {
      ...item,
      ...(threadId ? { sourceEmailThreadId: threadId } : {}),
      ...(gone ? { sourceEmailGone: true } : {}),
      ...(doc ? { sourceDoc: doc } : {}),
    };
  };

  return statuses.map((s) => {
    const mine = s.trip.createdBy === userId;
    const link = <T extends Item>(item: T): T => withLinks(item, mine);
    return {
      ...s,
      trip: link(s.trip),
      legs: s.legs.map(link),
      accommodations: s.accommodations.map(link),
      reservations: s.reservations.map(link),
    };
  });
}
