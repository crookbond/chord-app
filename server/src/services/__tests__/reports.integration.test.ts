/**
 * ADR 0301 — reporting a message someone else posted in a shared chat: what
 * can be reported, one report per person per message, the email to the
 * support address, and the retry when the email does not go out.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import {
  reportMessage,
  setReportMailer,
  sweepReportEmails,
  type ReportMail,
} from '@/services/reports.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { addMember, closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('reporting a message (ADR 0301)', () => {
  let db: Kysely<DB>;
  let john: string;
  let sam: string;
  let outsider: string;
  let family: string;
  let personal: string;
  let sent: ReportMail[];
  let failNext: number;

  const post = async (groupId: string, senderId: string, body: string, attachmentId?: string) =>
    (await insertMessage(db, { groupId, senderId, body, attachmentId })).id;

  const tool = (name: string, args: Record<string, unknown>) =>
    applyToolCall(db, { groupId: personal, actorUserId: john, provenance: null, call: { name, args } as never });

  beforeEach(async () => {
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    sam = await createUser(db, 'sam', 'Sam Lee');
    outsider = await createUser(db, 'zed', 'Zed Outside');
    family = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: john })).id;
    await addMember(db, family, sam);
    // A third member, so the chat is called "Family" rather than by the
    // other person's name (ADR 0101).
    await addMember(db, family, await createUser(db, 'priya', 'Priya Rao'));
    personal = (await ensurePersonalGroup(db, john)).id;
    sent = [];
    failNext = 0;
    setReportMailer(async (mail) => {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('smtp down');
      }
      sent.push(mail);
    });
  });
  afterEach(async () => {
    await settleBackgroundWork();
    setReportMailer(null);
    await closeTestDb(db);
  });

  it('saves the report and emails it, with the file name and reason', async () => {
    const fileId = newId('att');
    const now = new Date().toISOString();
    await db
      .insertInto('attachments')
      .values({
        id: fileId,
        scope_kind: 'group',
        scope_id: family,
        uploaded_by: sam,
        filename: 'awful.jpg',
        mime_type: 'image/jpeg',
        size: 10,
        path: `test/${fileId}`,
        summary: null,
        extracted_text: null,
        image_meta: null,
        pinned: 0,
        indexed_at: now,
        created_at: now,
      })
      .execute();
    const msg = await post(family, sam, 'look at this', fileId);

    const result = await reportMessage(db, { reporterId: john, messageId: msg, reason: 'abusive' });
    expect(result).toMatchObject({ ok: true, alreadyReported: false, reportedUserId: sam, reportedName: 'Sam Lee' });
    await settleBackgroundWork();

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('hello@chordapp.ai');
    expect(sent[0].subject).toContain('Sam Lee');
    expect(sent[0].text).toContain('look at this');
    expect(sent[0].text).toContain('awful.jpg');
    expect(sent[0].text).toContain('abusive');
    const row = await db.selectFrom('content_reports').selectAll().executeTakeFirstOrThrow();
    expect(row.emailed_at).not.toBeNull();
    expect(row.email_attempts).toBe(1);
  });

  it('reports a message once per person', async () => {
    const msg = await post(family, sam, 'rude');
    const first = await reportMessage(db, { reporterId: john, messageId: msg });
    const again = await reportMessage(db, { reporterId: john, messageId: msg });
    expect(again).toMatchObject({ ok: true, alreadyReported: true });
    if (first.ok && again.ok) expect(again.reportId).toBe(first.reportId);
    await settleBackgroundWork();
    expect(sent).toHaveLength(1);
  });

  it('refuses own messages, bot replies, the personal chat, and chats the reporter is not in', async () => {
    const mine = await post(family, john, 'mine');
    expect(await reportMessage(db, { reporterId: john, messageId: mine })).toEqual({ ok: false, reason: 'own_message' });

    const botId = newId('m');
    await db
      .insertInto('messages')
      .values({
        id: botId,
        group_id: family,
        sender_id: null,
        kind: 'bot',
        body: 'Chord says hi',
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 0,
        created_at: new Date().toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: 1,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: null,
        is_proactive: 0,
      } as never)
      .execute();
    expect(await reportMessage(db, { reporterId: john, messageId: botId })).toEqual({ ok: false, reason: 'bot_message' });

    const note = await post(personal, john, 'a note');
    expect(await reportMessage(db, { reporterId: john, messageId: note })).toEqual({ ok: false, reason: 'personal_chat' });

    const other = (await createGroup(db, { name: 'Other', kind: 'group', createdBy: outsider })).id;
    const theirs = await post(other, outsider, 'private');
    expect(await reportMessage(db, { reporterId: john, messageId: theirs })).toEqual({ ok: false, reason: 'not_found' });
    expect(await reportMessage(db, { reporterId: john, messageId: 'm_nope' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await db.selectFrom('content_reports').select('id').execute()).toHaveLength(0);
  });

  it('keeps a report whose email failed and the sweep sends it later', async () => {
    const msg = await post(family, sam, 'rude');
    failNext = 1;
    await reportMessage(db, { reporterId: john, messageId: msg });
    await settleBackgroundWork();
    expect(sent).toHaveLength(0);
    const failed = await db.selectFrom('content_reports').selectAll().executeTakeFirstOrThrow();
    expect(failed.emailed_at).toBeNull();
    expect(failed.last_error).toBe('smtp down');

    // Too soon: the sweep waits 10 minutes between tries.
    expect(await sweepReportEmails(db)).toBe(0);
    expect(await sweepReportEmails(db, new Date(Date.now() + 11 * 60_000))).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await sweepReportEmails(db, new Date(Date.now() + 30 * 60_000))).toBe(0);
  });

  describe('report_message bot tool', () => {
    it('is personal-chat only', () => {
      expect(PERSONAL_ONLY_TOOL_NAMES.has('report_message')).toBe(true);
    });

    it('reports the newest message from the named person in the named chat', async () => {
      await post(family, sam, 'older');
      const newest = await post(family, sam, 'newest');
      await db
        .updateTable('messages')
        .set({ created_at: new Date(Date.now() + 1000).toISOString() })
        .where('id', '=', newest)
        .execute();

      const out = await tool('report_message', { groupName: 'family', person: 'Sam', reason: 'spam' });
      expect(out.data).toMatchObject({ ok: true, name: 'Sam Lee', group: 'Family', alreadyReported: false });
      const row = await db.selectFrom('content_reports').selectAll().executeTakeFirstOrThrow();
      expect(row.message_id).toBe(newest);
      expect(row.reason).toBe('spam');
    });

    it('asks when the chat or person does not match, and never reports someone outside the chat', async () => {
      expect((await tool('report_message', { groupName: 'Nowhere', person: 'Sam' })).data).toMatchObject({
        ok: false,
        reason: 'group_not_found',
      });
      expect((await tool('report_message', { groupName: 'Family', person: 'Zed Outside' })).data).toMatchObject({
        ok: false,
        reason: 'person_not_found',
      });
      expect((await tool('report_message', { groupName: 'Family', person: 'Sam' })).data).toMatchObject({
        ok: false,
        reason: 'no_message',
      });
    });
  });
});
