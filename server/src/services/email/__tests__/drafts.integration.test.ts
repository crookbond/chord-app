/**
 * Unsent mail (ADR 0113). The behaviour that matters is that autosave is
 * idempotent: typing a reply across two sittings must leave ONE draft, not one
 * per sitting.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { saveFile } from '@/services/attachments.service.js';
import {
  deleteDraft,
  getDraft,
  getThreadDraft,
  listDrafts,
  saveDraft,
} from '@/services/email/drafts.service.js';
import { queueSend } from '@/services/email/outbox.service.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedThread(userId: string): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: id,
      subject: 'Permission slip',
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

describe('drafts', () => {
  it('keeps what was typed', async () => {
    const uid = await createUser(db, 'alice');

    const draft = await saveDraft(db, uid, {
      kind: 'new',
      to: ['them@example.com'],
      subject: 'Ladder',
      body: 'Can we borrow it Saturday?',
    });

    expect(await getDraft(db, uid, draft.id)).toMatchObject({
      to: ['them@example.com'],
      subject: 'Ladder',
      body: 'Can we borrow it Saturday?',
    });
  });

  it('updates in place when handed its own id', async () => {
    // Autosave runs every second or so. One row per save would be a draft list
    // full of the same half-finished message.
    const uid = await createUser(db, 'alice');
    const first = await saveDraft(db, uid, { kind: 'new', body: 'Can we' });

    const second = await saveDraft(db, uid, {
      id: first.id,
      kind: 'new',
      body: 'Can we borrow the ladder',
    });

    expect(second.id).toBe(first.id);
    expect(await listDrafts(db, uid)).toHaveLength(1);
  });

  it('finds a reply draft by its thread, with no id to go on', async () => {
    // The second sitting: the composer reopens and has forgotten the id, but
    // the thread is the same one.
    const uid = await createUser(db, 'alice');
    const threadId = await seedThread(uid);
    const first = await saveDraft(db, uid, { kind: 'reply', threadId, body: 'We will' });

    const second = await saveDraft(db, uid, {
      kind: 'reply',
      threadId,
      body: 'We will be there',
    });

    expect(second.id).toBe(first.id);
    expect(await listDrafts(db, uid)).toHaveLength(1);
  });

  it('a forward draft remembers which message it forwards (ADR 0112 addendum)', async () => {
    // Reported: reopening a forward draft from Drafts showed the newest
    // message, not the one that had been selected.
    const uid = await createUser(db, 'alice');
    const threadId = await seedThread(uid);
    const first = await saveDraft(db, uid, {
      kind: 'forward',
      threadId,
      body: 'FYI',
      forwardMessageId: 'msg_older',
    });

    // An older app's autosave knows nothing of the field; it must not unpin it.
    await saveDraft(db, uid, { kind: 'forward', threadId, body: 'FYI, see below' });

    expect((await getDraft(db, uid, first.id))?.forwardMessageId).toBe('msg_older');
    expect((await getThreadDraft(db, uid, 'forward', threadId))?.forwardMessageId).toBe('msg_older');
    expect((await listDrafts(db, uid))[0].forwardMessageId).toBe('msg_older');

    // null says "the newest" again.
    await saveDraft(db, uid, { kind: 'forward', threadId, forwardMessageId: null, body: 'x' });
    expect((await getDraft(db, uid, first.id))?.forwardMessageId).toBeNull();
  });

  it('keeps a reply and a forward on one thread apart', async () => {
    const uid = await createUser(db, 'alice');
    const threadId = await seedThread(uid);

    const reply = await saveDraft(db, uid, { kind: 'reply', threadId, body: 'yes' });
    const forward = await saveDraft(db, uid, { kind: 'forward', threadId, body: 'see this' });

    expect(forward.id).not.toBe(reply.id);
    expect(await listDrafts(db, uid)).toHaveLength(2);
  });

  it('shows the subject, or the first real line, or says there is neither', async () => {
    const uid = await createUser(db, 'alice');

    const titled = await saveDraft(db, uid, { kind: 'new', subject: 'Ladder', body: 'x' });
    const untitled = await saveDraft(db, uid, { kind: 'new', body: '\n\n  Can we borrow it' });
    const empty = await saveDraft(db, uid, { kind: 'new' });

    expect(titled.preview).toBe('Ladder');
    expect(untitled.preview).toBe('Can we borrow it');
    expect(empty.preview).toBe('(no subject)');
  });

  it('is scoped to its owner', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const hers = await saveDraft(db, alice, { kind: 'new', body: 'private' });

    expect(await getDraft(db, bob, hers.id)).toBeNull();
    expect(await listDrafts(db, bob)).toHaveLength(0);
  });

  it('treats deleting a draft that is already gone as done', async () => {
    // A send clears its own draft; failing there would fail a message that has
    // already left.
    const uid = await createUser(db, 'alice');
    const draft = await saveDraft(db, uid, { kind: 'new', body: 'x' });

    await deleteDraft(db, uid, draft.id);
    await expect(deleteDraft(db, uid, draft.id)).resolves.toBeUndefined();
  });

  it('starts a new row when the one it was updating was deleted elsewhere', async () => {
    // Two windows. Throwing at someone who is still typing loses their words.
    const uid = await createUser(db, 'alice');
    const draft = await saveDraft(db, uid, { kind: 'new', body: 'half a thought' });
    await deleteDraft(db, uid, draft.id);

    const again = await saveDraft(db, uid, { id: draft.id, kind: 'new', body: 'half a thought' });

    expect(again.id).not.toBe(draft.id);
    expect(again.body).toBe('half a thought');
  });
});

describe('picking a draft back up', () => {
  it("finds the reply a thread already has, and not its forward or anyone else's", async () => {
    // The reply composer starts empty every time it opens. Without this read a
    // reply typed yesterday is saved, listed under Drafts, and never shown again
    // in the place it was written - and the first keystroke overwrites it.
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const threadId = await seedThread(alice);
    await saveDraft(db, alice, { kind: 'reply', threadId, body: 'Yes, Saturday works.' });
    await saveDraft(db, alice, { kind: 'forward', threadId, body: 'FYI' });

    expect(await getThreadDraft(db, alice, 'reply', threadId)).toMatchObject({
      kind: 'reply',
      body: 'Yes, Saturday works.',
    });
    expect(await getThreadDraft(db, alice, 'forward', threadId)).toMatchObject({ body: 'FYI' });
    expect(await getThreadDraft(db, bob, 'reply', threadId)).toBeNull();
    expect(await getThreadDraft(db, alice, 'reply', await seedThread(alice))).toBeNull();
  });

  it('does not hand back a reply that is already on its way out', async () => {
    const alice = await createUser(db, 'alice');
    const threadId = await seedThread(alice);
    const draft = await saveDraft(db, alice, { kind: 'reply', threadId, body: 'Sending this.' });
    await queueSend(db, alice, draft.id);

    expect(await getThreadDraft(db, alice, 'reply', threadId)).toBeNull();
  });

  it('names the files a draft carries, but only ones its owner can read', async () => {
    // A draft stores attachment ids. Opened again it showed no files, and the
    // next autosave wrote that empty list back over the saved one.
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const hers = await createGroup(db, { name: 'Hers', kind: 'group', createdBy: alice });
    const his = await createGroup(db, { name: 'His', kind: 'group', createdBy: bob });
    const mine = await saveFile(db, {
      scope: { kind: 'group', groupId: hers.id },
      uploadedBy: alice,
      filename: 'form.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('signed'),
    });
    const notMine = await saveFile(db, {
      scope: { kind: 'group', groupId: his.id },
      uploadedBy: bob,
      filename: 'private.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not for alice'),
    });
    const draft = await saveDraft(db, alice, {
      kind: 'new',
      body: 'Form attached',
      attachmentIds: [mine.id, notMine.id],
    });

    const opened = await getDraft(db, alice, draft.id);

    expect(opened?.attachments).toEqual([{ id: mine.id, filename: 'form.txt', size: 6 }]);
  });
});
