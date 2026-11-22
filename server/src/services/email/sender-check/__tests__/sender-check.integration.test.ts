/**
 * ADR 0294 end to end: a "Robinhood" email from a domain that is not
 * Robinhood's passes the provider's spam filter, Chord syncs it, and opening
 * it shows who really sent it - in the reader and in the read-time prompt.
 *
 * The prod message (2026-10-23) is not reproduced byte for byte: the sender
 * line here is the usual shape of that campaign (brand display name, an
 * unrelated domain, a provider verdict that passes SPF for the sender's own
 * domain). The regression it pins is the one that matters: before this, the
 * read-time pass was asked to spot impersonation without ever being shown
 * the From line.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { normalizeMessage, type GmailRawMessage } from '@/services/google/gmail-sync.js';
import { ensureThreadRow, getThread, recomputeThread, upsertMessageMeta } from '@/services/google/gmail.service.js';
import { senderContextBlock } from '@/services/email/sender-check/prompt.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';

const ME = 'ownertest@gmail.com';

function raw(opts: {
  id: string;
  gid: string;
  from: string;
  replyTo?: string;
  auth: string[];
  html: string;
  at: number;
}): GmailRawMessage {
  const headers = [
    { name: 'From', value: opts.from },
    { name: 'To', value: ME },
    { name: 'Subject', value: 'Unusual sign-in activity on your account' },
    { name: 'Message-ID', value: `<${opts.id}@mail.example>` },
    ...(opts.replyTo ? [{ name: 'Reply-To', value: opts.replyTo }] : []),
    ...opts.auth.map((value) => ({ name: 'Authentication-Results', value })),
  ];
  return {
    id: opts.id,
    threadId: opts.gid,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'We noticed a sign-in from a new device',
    internalDate: String(opts.at),
    payload: {
      mimeType: 'text/html',
      headers,
      body: { size: opts.html.length, data: Buffer.from(opts.html).toString('base64url') },
    } as GmailRawMessage['payload'],
  };
}

describe('sender checks on an opened thread', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    await db.updateTable('users').set({ email: ME }).where('id', '=', userId).execute();
  });
  afterEach(async () => closeTestDb(db));

  const store = async (r: GmailRawMessage): Promise<string> => {
    const now = new Date(Number(r.internalDate)).toISOString();
    const threadRowId = await ensureThreadRow(db, userId, r.threadId, now);
    await upsertMessageMeta(db, userId, threadRowId, normalizeMessage(r), now);
    await recomputeThread(db, userId, r.threadId);
    return threadRowId;
  };

  it('flags a Robinhood display name on another domain and tells the read-time pass', async () => {
    const gid = newId('gt');
    const threadRowId = await store(
      raw({
        id: newId('gm'),
        gid,
        from: '"Robinhood" <security@rh-account-review.com>',
        replyTo: 'robinhood.helpdesk@outlook.com',
        auth: [
          // Topmost: the user's provider. Lower: a header the sender wrote.
          'mx.google.com; dkim=pass header.i=@rh-account-review.com; spf=pass smtp.mailfrom=rh-account-review.com; dmarc=pass header.from=rh-account-review.com',
          'robinhood.com; dkim=pass header.i=@robinhood.com; dmarc=pass header.from=robinhood.com',
        ],
        html: '<p>Verify your account</p><a href="http://45.133.1.20/verify">Sign in to Robinhood</a>',
        at: Date.parse('2026-10-23T14:02:00Z'),
      }),
    );

    const stored = await db
      .selectFrom('email_messages')
      .select(['reply_to', 'auth_results'])
      .where('thread_id', '=', threadRowId)
      .executeTakeFirstOrThrow();
    expect(stored.reply_to).toBe('robinhood.helpdesk@outlook.com');
    // The forged lower header must not be what was kept.
    expect(stored.auth_results).toMatchObject({ dmarc: 'pass', dmarcFrom: 'rh-account-review.com' });

    const detail = await getThread(db, userId, threadRowId);
    const check = detail!.messages[0]!.senderCheck!;
    expect(check.level).toBe('danger');
    expect(check.claimedBrand).toBe('Robinhood');
    expect(check.signals.map((s) => s.code)).toEqual(
      expect.arrayContaining(['brand_mismatch', 'reply_to_elsewhere', 'suspicious_link', 'first_contact']),
    );
    // DMARC passing for the sender's OWN domain proves only that domain.
    expect(check.verifiedDomain).toBe(true);
    expect(check.domain).toBe('rh-account-review.com');

    const block = await senderContextBlock(db, userId, threadRowId);
    expect(block).toContain('From: Robinhood <security@rh-account-review.com>');
    expect(block).toContain('The display name presents itself as: Robinhood');
    expect(block).toContain("(danger) Says it is from Robinhood, but it was sent from rh-account-review.com");
  });

  it('a vacation auto-reply to a sender does not make them someone the user wrote to', async () => {
    // ADR 0314 audit sweep: the responder answers a phish, and the sender
    // check then counted that as the user writing to them.
    const gid = newId('gt');
    const at = Date.parse('2026-10-23T14:02:00Z');
    const threadRowId = await store(
      raw({
        id: newId('gm'),
        gid,
        from: '"Robinhood" <security@rh-account-review.com>',
        auth: ['mx.google.com; dkim=pass header.i=@rh-account-review.com; dmarc=pass header.from=rh-account-review.com'],
        html: '<p>Verify your account</p>',
        at,
      }),
    );
    const sentAt = new Date(at + 60_000).toISOString();
    await upsertMessageMeta(
      db,
      userId,
      threadRowId,
      {
        gmailMessageId: newId('gm'),
        gmailThreadId: gid,
        fromName: null,
        fromEmail: ME,
        toEmails: ['security@rh-account-review.com'],
        ccEmails: [],
        subject: 'Re: Unusual sign-in activity on your account',
        snippet: 'I am away',
        bodyText: 'I am away',
        bodyHtml: null,
        internalDate: sentAt,
        isUnread: false,
        labelIds: ['SENT'],
        rfc822MessageId: null,
        headers: { references: null, inReplyTo: null, date: null },
        attachmentsJson: '[]',
        autoReply: true,
      },
      sentAt,
    );
    await recomputeThread(db, userId, gid);

    const detail = await getThread(db, userId, threadRowId);
    const incoming = detail!.messages.find((m) => m.fromEmail !== ME)!;
    expect(incoming.senderCheck!.history?.wrote).toBe(0);
    expect(incoming.senderCheck!.signals.map((s) => s.code)).toContain('first_contact');
  });

  it('finds nothing on real Robinhood mail from a known sender', async () => {
    const at = Date.parse('2026-10-20T09:00:00Z');
    for (const [i, gid] of [newId('gt'), newId('gt')].entries()) {
      await store(
        raw({
          id: newId('gm'),
          gid,
          from: 'Robinhood <notifications@robinhood.com>',
          auth: ['mx.google.com; dkim=pass header.i=@robinhood.com; spf=pass; dmarc=pass (p=REJECT) header.from=robinhood.com'],
          html: '<a href="https://robinhood.com/account">Open Robinhood</a>',
          at: at + i * 86_400_000,
        }),
      );
    }
    const threads = await db.selectFrom('email_threads').select('id').where('user_id', '=', userId).execute();
    const detail = await getThread(db, userId, threads[1]!.id);
    const check = detail!.messages[0]!.senderCheck!;
    expect(check.level).toBe('none');
    expect(check.history).toEqual({ received: 1, wrote: 0, inPeople: false });
  });

  it('flags a saved person\'s name from a different address', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('people')
      .values({
        id: newId('per'),
        owner_user_id: userId,
        display_name: 'Alice  Stone',
        email: 'spouse.test@gmail.com',
        notes: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const threadRowId = await store(
      raw({
        id: newId('gm'),
        gid: newId('gt'),
        from: 'Alice Stone <spouse.office.mail@gmail.com>',
        auth: ['mx.google.com; dkim=pass header.i=@gmail.com; spf=pass; dmarc=pass header.from=gmail.com'],
        html: '<p>Can you buy two gift cards for me? I am in a meeting.</p>',
        at: Date.parse('2026-10-23T14:02:00Z'),
      }),
    );
    const check = (await getThread(db, userId, threadRowId))!.messages[0]!.senderCheck!;
    expect(check.signals.map((s) => s.code)).toContain('impersonates_contact');
    expect(check.level).toBe('danger');
  });

  it('a later fetch without the headers keeps what an earlier one stored', async () => {
    const gid = newId('gt');
    const r = raw({
      id: newId('gm'),
      gid,
      from: 'Robinhood <security@rh-account-review.com>',
      auth: ['mx.google.com; dmarc=fail header.from=rh-account-review.com'],
      html: '<p>x</p>',
      at: Date.parse('2026-10-23T14:02:00Z'),
    });
    const threadRowId = await store(r);
    // A metadata-format fetch: no body, no Authentication-Results.
    const meta: GmailRawMessage = {
      ...r,
      payload: { headers: r.payload!.headers!.filter((h) => h.name !== 'Authentication-Results') } as GmailRawMessage['payload'],
    };
    await upsertMessageMeta(db, userId, threadRowId, normalizeMessage(meta), new Date().toISOString());
    const stored = await db
      .selectFrom('email_messages')
      .select('auth_results')
      .where('thread_id', '=', threadRowId)
      .executeTakeFirstOrThrow();
    expect(stored.auth_results).toMatchObject({ dmarc: 'fail' });
  });
});
