/**
 * Forwarding a thread onward (ADR 0112). The behaviour worth pinning is that
 * the original's files travel with it, and that a file we cannot fetch stops
 * the send rather than thinning it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { buildForwardBody } from '@chord/kernel';

import { forwardSubject, forwardThread } from '@/services/email/forward.service.js';
import { AttachmentRejected } from '@/services/email/outgoing-attachments.js';
import { backfillGmail } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

describe('forwardSubject', () => {
  it('adds one prefix and only one', () => {
    expect(forwardSubject('Permission slip')).toBe('Fwd: Permission slip');
    expect(forwardSubject('Fwd: Permission slip')).toBe('Fwd: Permission slip');
    expect(forwardSubject('Fwd: Fwd: Permission slip')).toBe('Fwd: Permission slip');
  });

  it('replaces a reply prefix rather than stacking on it', () => {
    // "Fwd: Re: Re: x" is what every client that got this wrong produces.
    expect(forwardSubject('Re: Re: Permission slip')).toBe('Fwd: Permission slip');
  });
});

describe('buildForwardBody', () => {
  const original = {
    fromName: 'Ms Chen',
    fromEmail: 'chen@school.example',
    date: '2026-08-20T10:00:00.000Z',
    subject: 'Permission slip',
    to: ['me@example.com'],
    body: 'Please return it by Friday.',
  };

  it('quotes the original under the standard header block', () => {
    const out = buildForwardBody(undefined, original);

    expect(out).toContain('---------- Forwarded message ----------');
    expect(out).toContain('From: Ms Chen <chen@school.example>');
    expect(out).toContain('Subject: Permission slip');
    expect(out).toContain('Please return it by Friday.');
  });

  it('puts the sender\'s note above the quote', () => {
    const out = buildForwardBody('Can you sign this?', original);

    expect(out.indexOf('Can you sign this?')).toBeLessThan(
      out.indexOf('---------- Forwarded message ----------'),
    );
  });

  it('sends with no note at all', () => {
    // "here, look at this" is the whole message most of the time.
    expect(buildForwardBody('   ', original)).toMatch(/^---------- Forwarded/);
  });
});

describe('forwardThread', () => {
  let userId: string;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'alice');
    await backfillGmail(db, userId);
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await closeTestDb(db);
  });

  const someThread = async () =>
    db
      .selectFrom('email_threads')
      .select(['id', 'subject'])
      .where('user_id', '=', userId)
      .orderBy('last_message_at', 'desc')
      .executeTakeFirstOrThrow();

  it('sends, and reports the address it left from', async () => {
    const thread = await someThread();

    const out = await forwardThread(db, userId, thread.id, {
      to: ['neighbour@example.com'],
      body: 'Thought you should see this.',
    });

    expect(out?.fromEmail).toBeTruthy();
  });

  it('returns null for a thread that is not the user\'s', async () => {
    const bob = await createUser(db, 'bob');
    const thread = await someThread();

    expect(await forwardThread(db, bob, thread.id, { to: ['x@example.com'] })).toBeNull();
  });

  it('refuses the whole send when a carried file cannot be fetched', async () => {
    // Thinning a forward is the failure the sender cannot see. Opting out with
    // includeAttachments:false is their call, not ours.
    const thread = await someThread();
    const msg = await db
      .selectFrom('email_messages')
      .select(['id'])
      .where('thread_id', '=', thread.id)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('email_messages')
      .set({
        body_text: 'Please see attached.',
        attachments_json: JSON.stringify([
          { id: 'no_such_part', filename: 'ghost.pdf', mimeType: 'application/pdf', size: 10 },
        ]),
      })
      .where('id', '=', msg.id)
      .execute();

    await expect(
      forwardThread(db, userId, thread.id, { to: ['x@example.com'] }),
    ).rejects.toBeInstanceOf(AttachmentRejected);
  });

  it('sends without the files when the sender says so', async () => {
    const thread = await someThread();
    const msg = await db
      .selectFrom('email_messages')
      .select(['id'])
      .where('thread_id', '=', thread.id)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('email_messages')
      .set({
        body_text: 'Please see attached.',
        attachments_json: JSON.stringify([
          { id: 'no_such_part', filename: 'ghost.pdf', mimeType: 'application/pdf', size: 10 },
        ]),
      })
      .where('id', '=', msg.id)
      .execute();

    const out = await forwardThread(db, userId, thread.id, {
      to: ['x@example.com'],
      includeAttachments: false,
    });

    expect(out?.fromEmail).toBeTruthy();
  });
});
