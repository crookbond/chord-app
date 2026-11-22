/**
 * The bot drafts a reply; the user sends it.
 *
 * `chord_email.md` §3.4 makes this a rule — *nothing is sent without a human
 * tap* — and it is the one write in the registry that leaves the building under
 * the user's name. So `reply_to_email` is the sole member of `PROPOSABLE_TOOLS`:
 * the bot's own call must stage a proposal and touch no mailbox, and only the
 * confirm path (`mode: 'commit'`) may reach the send.
 *
 * What this pins is the *seam*, not the transport: if someone later drops the
 * tool from PROPOSABLE_TOOLS, or the propose branch stops covering it, the bot
 * starts silently mailing people and no other test would notice.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { listProposalsForGroup } from '@/services/proposals.service.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('reply_to_email stages a draft rather than sending', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = newId('u');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: userId,
        username: 'ro',
        display_name: 'Ro',
        email: 'me@example.com',
        created_at: now,
        shadow: 0,
      })
      .execute();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'My Chord',
        kind: 'personal',
        invite_code: 'XMAIL',
        ingest_email: 'me-mail@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({ group_id: groupId, user_id: userId, role: 'owner', tier: 'verified', joined_at: now })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('proposes instead of sending, and carries the draft on the card', async () => {
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      call: {
        name: 'reply_to_email',
        // A thread id that does not exist: proof the propose branch returns
        // before anything tries to reach a mailbox.
        args: { threadId: 'et_nonexistent', body: 'We will be there, thank you!' },
      },
    });

    expect(res.summary).toContain('awaiting confirmation');
    expect(res.card?.kind).toBe('email');
    // The draft itself is the decision — a summary would not let the user judge
    // whether it says what they mean.
    expect(res.card?.subtitle).toBe('We will be there, thank you!');

    const pending = await listProposalsForGroup(db, groupId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolName: 'reply_to_email', status: 'pending' });
    expect(JSON.parse(pending[0].argsJson)).toMatchObject({
      body: 'We will be there, thank you!',
    });
  });

  it('is personal-chat only — a shared group must not answer mail it cannot see', () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('reply_to_email')).toBe(true);
  });

  it('bakes the resolved audience into the proposal so the card cannot lie', async () => {
    // A thread whose newest message has a sender, three To's (one of them the
    // user) and a Cc. Reply-all must drop the user's own address and keep the
    // rest; a plain reply must carry no cc at all.
    const now = new Date().toISOString();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: 'gt_1',
        subject: 'Field trip',
        from_name: 'Ms Chen',
        from_email: 'chen@school.org',
        snippet: '',
        last_message_at: now,
        is_unread: 1,
        is_archived: 0,
        message_count: 1,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_thread_id: 'gt_1',
        gmail_message_id: 'gm_1',
        from_name: 'Ms Chen',
        from_email: 'chen@school.org',
        to_emails: JSON.stringify(['me@example.com', 'parent2@example.com']),
        cc_emails: JSON.stringify(['office@school.org']),
        subject: 'Field trip',
        snippet: '',
        body_text: 'Please confirm.',
        body_html: null,
        internal_date: now,
        is_unread: 1,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: now,
      })
      .execute();

    const all = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      call: {
        name: 'reply_to_email',
        args: { threadId, body: 'We will be there.', replyAll: true },
      },
    });
    const args = JSON.parse((await listProposalsForGroup(db, groupId))[0].argsJson);
    expect(args.to).toEqual(['chen@school.org']);
    // The user's own address is gone; the other parent and the office remain.
    expect(args.cc).toEqual(['parent2@example.com', 'office@school.org']);
    // And the audience is ON the card, which is the whole point of allowing
    // reply-all at all.
    expect(all.card?.title).toBe('Reply all');
    expect(all.card?.meta).toContain('chen@school.org');
    expect(all.card?.meta).toContain('parent2@example.com');
  });

  it('a plain reply carries no cc — widening is always explicit', async () => {
    const now = new Date().toISOString();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: 'gt_2',
        subject: 'Field trip',
        from_name: 'Ms Chen',
        from_email: 'chen@school.org',
        snippet: '',
        last_message_at: now,
        is_unread: 1,
        is_archived: 0,
        message_count: 1,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_thread_id: 'gt_2',
        gmail_message_id: 'gm_2',
        from_name: 'Ms Chen',
        from_email: 'chen@school.org',
        to_emails: JSON.stringify(['me@example.com', 'parent2@example.com']),
        cc_emails: JSON.stringify(['office@school.org']),
        subject: 'Field trip',
        snippet: '',
        body_text: 'Please confirm.',
        body_html: null,
        internal_date: now,
        is_unread: 1,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: now,
      })
      .execute();

    const one = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      call: { name: 'reply_to_email', args: { threadId, body: 'Yes.' } },
    });
    const args = JSON.parse((await listProposalsForGroup(db, groupId))[0].argsJson);
    expect(args.to).toEqual(['chen@school.org']);
    expect(args.cc).toEqual([]);
    expect(one.card?.title).toBe('Reply');
  });

  it('answers the correspondent, not yourself, on a thread you already replied to', async () => {
    // Found by driving the mock: after one reply the newest message in the
    // thread is your OWN, so 'reply to the latest message' addresses the draft
    // back to the user. The composer showed `To: me@example.com`; on the bot
    // path nobody sees the address at all before it is sent.
    const t0 = new Date(Date.now() - 3600_000).toISOString();
    const t1 = new Date().toISOString();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: 'gt_3',
        subject: 'Sunday dinner?',
        from_name: 'Grandma',
        from_email: 'grandma@example.com',
        snippet: '',
        last_message_at: t1,
        is_unread: 0,
        is_archived: 0,
        message_count: 2,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: t0,
        updated_at: t1,
      })
      .execute();
    const msg = async (id: string, from: string, at: string, labels: string[]) =>
      db
        .insertInto('email_messages')
        .values({
          id: newId('em'),
          user_id: userId,
          thread_id: threadId,
          gmail_thread_id: 'gt_3',
          gmail_message_id: id,
          from_name: null,
          from_email: from,
          to_emails: JSON.stringify([from === 'grandma@example.com' ? 'me@example.com' : 'grandma@example.com']),
          cc_emails: JSON.stringify([]),
          subject: 'Sunday dinner?',
          snippet: '',
          body_text: 'x',
          body_html: null,
          internal_date: at,
          is_unread: 0,
          gmail_label_ids: JSON.stringify(labels),
          created_at: at,
        })
        .execute();
    await msg('gm_in', 'grandma@example.com', t0, ['INBOX']);
    // Our own reply is newest, and carries SENT.
    await msg('gm_out', 'me@example.com', t1, ['SENT']);

    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      call: { name: 'reply_to_email', args: { threadId, body: 'Make it 6:30?' } },
    });
    const args = JSON.parse((await listProposalsForGroup(db, groupId))[0].argsJson);
    expect(args.to).toEqual(['grandma@example.com']);
    expect(res.card?.meta).toContain('grandma@example.com');
  });

  // ADR 0294 addendum: the fake "Robinhood" email that passed the provider's
  // spam filter, replies collected at a personal Outlook address.
  async function seedSender(fromName: string, fromEmail: string, replyTo: string): Promise<string> {
    const now = new Date().toISOString();
    const threadId = newId('et');
    const gt = newId('gt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: gt,
        subject: 'Unusual sign-in',
        from_name: fromName,
        from_email: fromEmail,
        snippet: '',
        last_message_at: now,
        is_unread: 1,
        is_archived: 0,
        message_count: 1,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_thread_id: gt,
        gmail_message_id: newId('gm'),
        from_name: fromName,
        from_email: fromEmail,
        reply_to: replyTo,
        to_emails: JSON.stringify(['me@example.com']),
        cc_emails: JSON.stringify([]),
        subject: 'Unusual sign-in',
        snippet: '',
        body_text: 'Reply with your account number to verify.',
        body_html: null,
        internal_date: now,
        is_unread: 1,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: now,
      })
      .execute();
    return threadId;
  }

  it('puts the Reply-To danger warning on the card of a reply to a fake', async () => {
    const threadId = await seedSender('Robinhood', 'no-reply@rh-securealerts.com', 'friend.test@outlook.com');
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      call: { name: 'reply_to_email', args: { threadId, body: 'Here is my account number.' } },
    });
    expect(res.card?.meta).toContain('friend.test@outlook.com');
    expect(res.card?.meta).toContain('which is not Robinhood');
    const data = res.data as { senderWarning?: string; instruction?: string };
    expect(data.senderWarning).toContain("Don't reply");
    expect(data.instruction).toBeTruthy();
  });

  it('adds nothing for an ordinary Reply-To elsewhere', async () => {
    const threadId = await seedSender('Netflix', 'info@mailer.netflix.com', 'netflix.help.desk@outlook.com');
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'propose',
      call: { name: 'reply_to_email', args: { threadId, body: 'Thanks.' } },
    });
    expect(res.card?.meta).not.toContain('⛔');
    // The reply goes where the sender asked, and the card says so.
    expect(res.card?.meta).toContain('To: netflix.help.desk@outlook.com');
    expect((res.data as { senderWarning?: string }).senderWarning).toBeUndefined();
  });
});
