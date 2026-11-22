/**
 * Previews stored before Gmail's escaping was decoded at sync are rewritten,
 * on the message and on the thread that shows it - and only for Gmail.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { decodeStoredGmailSnippets } from '@/services/email/gmail-snippet-heal.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const ESCAPED = 'We noticed you haven&#39;t been able to attend &lt;ownertest@gmail.com&gt;';
const DECODED = "We noticed you haven't been able to attend <ownertest@gmail.com>";

describe('decodeStoredGmailSnippets', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'snippet-heal');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const seed = async (gid: string, snippet: string, accountId: string | null): Promise<void> => {
    const now = new Date().toISOString();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        account_id: accountId,
        gmail_thread_id: gid,
        subject: 'IIT Delhi Alumni Mixer',
        snippet,
        from_email: 'someone@example.com',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        account_id: accountId,
        thread_id: threadId,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        from_email: 'someone@example.com',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        subject: 'IIT Delhi Alumni Mixer',
        snippet,
        internal_date: now,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: now,
      })
      .execute();
  };

  const account = async (provider: 'gmail' | 'outlook'): Promise<string> => {
    const id = newId('ea');
    const now = new Date().toISOString();
    await db
      .insertInto('email_accounts')
      .values({
        id,
        user_id: userId,
        provider,
        email_address: `${provider}@example.com`,
        created_at: now,
        updated_at: now,
      } as never)
      .execute();
    return id;
  };

  const snippets = async (gid: string): Promise<{ thread: string; message: string }> => {
    const t = await db
      .selectFrom('email_threads')
      .select('snippet')
      .where('gmail_thread_id', '=', gid)
      .executeTakeFirstOrThrow();
    const m = await db
      .selectFrom('email_messages')
      .select('snippet')
      .where('gmail_thread_id', '=', gid)
      .executeTakeFirstOrThrow();
    return { thread: t.snippet, message: m.snippet };
  };

  it('decodes the primary Gmail mailbox and an attached Gmail, not Outlook', async () => {
    const attachedGmail = await account('gmail');
    const outlook = await account('outlook');
    await seed('g-primary', ESCAPED, null);
    await seed('g-attached', ESCAPED, attachedGmail);
    await seed('o-1', 'Type &amp; to get an ampersand', outlook);

    const res = await decodeStoredGmailSnippets(db, userId, { apply: true });

    expect(res).toEqual({ scanned: 2, changed: 2, threads: 2 });
    expect(await snippets('g-primary')).toEqual({ thread: DECODED, message: DECODED });
    expect(await snippets('g-attached')).toEqual({ thread: DECODED, message: DECODED });
    expect((await snippets('o-1')).message).toBe('Type &amp; to get an ampersand');
  });

  it('writes nothing on a dry run', async () => {
    await seed('g-primary', ESCAPED, null);

    const res = await decodeStoredGmailSnippets(db, userId, { apply: false });

    expect(res.changed).toBe(1);
    expect(await snippets('g-primary')).toEqual({ thread: ESCAPED, message: ESCAPED });
  });
});
