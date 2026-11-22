/**
 * attachSourceHrefs — the ADR 0059-style link from a proposal row back to
 * whatever generated it (source email thread / chat / attachments tab).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { attachSourceHrefs, createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedMessage(db2: Kysely<DB>, groupId: string, id: string): Promise<string> {
  await db2
    .insertInto('messages')
    .values({
      id,
      group_id: groupId,
      sender_id: null,
      kind: 'bot',
      body: 'context',
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      mentions_others: 0,
      chord_visible: 1,
      auto_mirror: 1,
      is_proactive: 0,
      created_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

describe('attachSourceHrefs', () => {
  it('resolves gmail provenance to the viewer local thread, attachments to the tab, chat to the group', async () => {
    const userId = await createUser(db, 'href-user');
    const personal = await ensurePersonalGroup(db, userId);

    const threadRowId = newId('emt');
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: threadRowId,
        user_id: userId,
        gmail_thread_id: 'g-soccer',
        subject: 'Soccer sign-up',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const base = {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'Todo', items: ['x'] },
    };
    const fromEmail = await createProposal(db, { ...base, provenance: 'gmail:g-soccer' });
    const fromUnknownEmail = await createProposal(db, { ...base, provenance: 'gmail:g-missing' });
    const fromAttachment = await createProposal(db, { ...base, provenance: 'attachment:att1' });
    const fromChat = await createProposal(db, {
      ...base,
      provenance: null,
      proposedByMessageId: await seedMessage(db, personal.id, 'msg1'),
    });
    const fromNowhere = await createProposal(db, { ...base, provenance: null });

    const withHrefs = await attachSourceHrefs(db, userId, [
      fromEmail,
      fromUnknownEmail,
      fromAttachment,
      fromChat,
      fromNowhere,
    ]);
    const hrefOf = (id: string) => withHrefs.find((p) => p.id === id)?.sourceHref;

    expect(hrefOf(fromEmail.id)).toBe(`/email/${threadRowId}`);
    expect(hrefOf(fromUnknownEmail.id)).toBeUndefined();
    expect(hrefOf(fromAttachment.id)).toBe('/catchup/files');
    expect(hrefOf(fromChat.id)).toBe(`/groups/${personal.id}`);
    expect(hrefOf(fromNowhere.id)).toBeUndefined();
  });

  it('is per-viewer: another user does not get a link into someone else\'s mailbox', async () => {
    const owner = await createUser(db, 'href-owner');
    const other = await createUser(db, 'href-other');
    const personal = await ensurePersonalGroup(db, owner);
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: owner,
        gmail_thread_id: 'g-1',
        subject: 's',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const p = await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: owner,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'Todo', items: ['x'] },
      provenance: 'gmail:g-1',
    });
    const [forOther] = await attachSourceHrefs(db, other, [p]);
    expect(forOther.sourceHref).toBeUndefined();
  });
});
