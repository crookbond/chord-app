/**
 * Chord labels Wave 1 (ADR 0141): local column, usage-derived list, no
 * provider call. Fixtures always include a message — `recomputeThread`
 * deletes a message-less thread (ADR 0128).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyChordLabelPatch, mergeChordLabels } from '@/services/email/chord-labels.js';
import { listBrowsableLabels } from '@/services/email/labels.js';
import * as gmailApi from '@/services/google/gmail-api.js';
import {
  applyThreadModify,
  listThreads,
  recomputeThread,
} from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

async function thread(opts: {
  subject?: string;
  gmailLabels?: string[];
  chordLabels?: string[];
  archived?: boolean;
}): Promise<{ id: string; gid: string }> {
  const now = new Date().toISOString();
  const id = newId('et');
  const gid = newId('gt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject: opts.subject ?? 'hi',
      from_email: 'someone@example.com',
      gmail_label_ids: JSON.stringify(opts.gmailLabels ?? ['INBOX']),
      chord_label_ids: JSON.stringify(opts.chordLabels ?? []),
      is_archived: opts.archived ? 1 : 0,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: id,
      gmail_message_id: newId('gm'),
      gmail_thread_id: gid,
      subject: opts.subject ?? 'hi',
      snippet: 'hi',
      from_email: 'someone@example.com',
      to_emails: JSON.stringify([]),
      cc_emails: JSON.stringify([]),
      gmail_label_ids: JSON.stringify(opts.gmailLabels ?? ['INBOX']),
      is_unread: 0,
      ics_text: '',
      internal_date: now,
      created_at: now,
    })
    .execute();
  return { id, gid };
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('mergeChordLabels', () => {
  it('dedupes case-insensitively and keeps the first spelling', () => {
    expect(mergeChordLabels(['Family'], ['family'], undefined)).toEqual(['Family']);
    expect(mergeChordLabels(['Family', 'School'], undefined, ['SCHOOL'])).toEqual(['Family']);
  });
});

describe('recomputeThread', () => {
  it('preserves chord_label_ids while rewriting provider labels', async () => {
    const { gid } = await thread({
      gmailLabels: ['INBOX', 'UNREAD'],
      chordLabels: ['Family'],
    });
    // Message labels diverge so recompute has something to write.
    await db
      .updateTable('email_messages')
      .set({ gmail_label_ids: JSON.stringify(['INBOX']) })
      .where('gmail_thread_id', '=', gid)
      .execute();

    await recomputeThread(db, userId, gid);

    const row = await db
      .selectFrom('email_threads')
      .select(['gmail_label_ids', 'chord_label_ids'])
      .where('gmail_thread_id', '=', gid)
      .executeTakeFirstOrThrow();
    expect(row.gmail_label_ids).toEqual(['INBOX']);
    expect(row.chord_label_ids).toEqual(['Family']);
  });
});

describe('browse', () => {
  it('lists Chord labels with scope chord and finds labelled+archived mail', async () => {
    await thread({ subject: 'live', chordLabels: ['Family'] });
    await thread({ subject: 'filed', chordLabels: ['Family'], archived: true });
    await thread({ subject: 'other', gmailLabels: ['INBOX', 'Label_7'] });

    const labels = await listBrowsableLabels(db, userId);
    expect(labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'Family', name: 'Family', threads: 2, scope: 'chord' }),
        expect.objectContaining({ id: 'Label_7', scope: 'provider', threads: 1 }),
      ]),
    );

    const rows = await listThreads(db, userId, { labelId: 'Family' });
    expect(rows.map((r) => r.subject).sort()).toEqual(['filed', 'live']);
  });
});

describe('apply / remove', () => {
  it('writes locally and never calls the provider', async () => {
    const { id } = await thread({});
    const spy = vi.spyOn(gmailApi, 'getGmailApi');

    const added = await applyThreadModify(db, userId, id, { addChordLabels: ['Family'] });
    expect(added?.chordLabelIds).toEqual(['Family']);
    expect(spy).not.toHaveBeenCalled();

    const removed = await applyThreadModify(db, userId, id, { removeChordLabels: ['family'] });
    expect(removed?.chordLabelIds).toEqual([]);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('applyChordLabelPatch is a no-op for a missing thread', async () => {
    expect(await applyChordLabelPatch(db, userId, 'et_nope', { addChordLabels: ['x'] })).toBe(
      false,
    );
  });
});
