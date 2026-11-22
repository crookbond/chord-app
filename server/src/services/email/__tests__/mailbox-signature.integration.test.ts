/**
 * ADR 0260 addendum - each mailbox can have its own signature.
 *
 * The reported bug: one signature for every mailbox, so mail from a work
 * Outlook went out signed like personal Gmail. What is pinned here: a mailbox
 * with its own signature uses it (composer text, rich HTML at send, chat
 * drafts, the bot tool), a mailbox without one falls back to the shared
 * signature, and `useShared` puts it back.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signatureForMailbox, swapSignature } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { buildToolDefs } from '@/services/bot/tools.js';
import { connectOutlookAccount, sendAccountNew } from '@/services/email-accounts/accounts.service.js';
import { __outlookMockSentHtml, __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import {
  mailboxSignatureRow,
  mailboxSignatures,
  namesMailbox,
  setMailboxSignature,
  signaturePatch,
  signedBody,
} from '@/services/email/signature.js';
import { saveFile } from '@/services/attachments.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('a signature per mailbox', () => {
  let db: Kysely<DB>;
  let userId: string;
  let outlookId: string;

  beforeEach(async () => {
    __resetOutlookMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'sig-user', 'John Doe');
    await db
      .updateTable('users')
      .set({ email_signature: 'John\nSent from Chord' })
      .where('id', '=', userId)
      .execute();
    const acct = await connectOutlookAccount(db, userId, { code: 'x', codeVerifier: 'y', redirectUri: 'z' } as never);
    outlookId = acct.id;
  });

  afterEach(async () => {
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    await closeTestDb(db);
  });

  it('was the same for every mailbox before one is given its own (the bug)', async () => {
    expect((await mailboxSignatureRow(db, userId, null)).email_signature).toBe('John\nSent from Chord');
    expect((await mailboxSignatureRow(db, userId, outlookId)).email_signature).toBe('John\nSent from Chord');
  });

  it('signs with "Get Chord at ..." when no signature was ever set, and nothing once cleared', async () => {
    await db.updateTable('users').set({ email_signature: null }).where('id', '=', userId).execute();
    expect(await signedBody(db, userId, 'Hi.', null)).toBe('Hi.\n\n-- \nGet Chord at https://www.chordapp.ai');
    expect(await signedBody(db, userId, 'Hi.', outlookId)).toBe('Hi.\n\n-- \nGet Chord at https://www.chordapp.ai');
    await db.updateTable('users').set(signaturePatch({ text: '' })).where('id', '=', userId).execute();
    expect(await signedBody(db, userId, 'Hi.', null)).toBe('Hi.');
  });

  it('gives one mailbox its own signature and leaves the others on the shared one', async () => {
    const out = await setMailboxSignature(db, userId, { mailbox: outlookId }, { text: 'John Doe\nAcme Corp' });
    expect(out).toMatchObject({ ok: true, own: true, signature: 'John Doe\nAcme Corp' });
    expect((await mailboxSignatureRow(db, userId, outlookId)).email_signature).toBe('John Doe\nAcme Corp');
    expect((await mailboxSignatureRow(db, userId, null)).email_signature).toBe('John\nSent from Chord');
    // Chat-drafted mail is signed with the mailbox it leaves from.
    expect(await signedBody(db, userId, 'Hi.', outlookId)).toBe('Hi.\n\n-- \nJohn Doe\nAcme Corp');
    expect(await signedBody(db, userId, 'Hi.', null)).toBe('Hi.\n\n-- \nJohn\nSent from Chord');
  });

  it('an empty own signature means that mailbox sends none; useShared puts it back', async () => {
    await setMailboxSignature(db, userId, { mailbox: outlookId }, { text: '' });
    expect(await signedBody(db, userId, 'Hi.', outlookId)).toBe('Hi.');
    const back = await setMailboxSignature(db, userId, { mailbox: outlookId }, { useShared: true });
    expect(back).toMatchObject({ ok: true, own: false, signature: 'John\nSent from Chord' });
    expect(await mailboxSignatures.get(db, userId)).toBeNull();
  });

  it('sends a mailbox its own rich signature, not the shared one', async () => {
    await setMailboxSignature(db, userId, { mailbox: outlookId }, { html: '<b>John Doe</b><br>Acme Corp' });
    const own = await mailboxSignatureRow(db, userId, outlookId);
    await sendAccountNew(db, userId, outlookId, {
      to: ['colleague@work.example'],
      subject: 'Q3',
      body: `Numbers attached.\n\n-- \n${own.email_signature}`,
    });
    const html = __outlookMockSentHtml(outlookId) ?? '';
    expect(html).toContain('<b>John Doe</b>');
    expect(html).not.toContain('Sent from Chord');
  });

  it('refuses a mailbox that is not the user\'s', async () => {
    expect(await setMailboxSignature(db, userId, { mailbox: 'nope' }, { text: 'x' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('is sayable in chat, only for a mailbox the user named', async () => {
    const personal = (await ensurePersonalGroup(db, userId)).id;
    const props = (buildToolDefs().find((d) => d.name === 'set_email_signature')?.parameters as {
      properties: Record<string, unknown>;
    }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['mailbox', 'useShared']));

    const said = async (body: string, args: Record<string, unknown>) => {
      const msg = await db
        .insertInto('messages')
        .values({ id: `m-${Math.random()}`, group_id: personal, sender_id: userId, kind: 'text', body, created_at: new Date().toISOString() } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      return applyToolCall(db, {
        groupId: personal,
        actorUserId: userId,
        triggeringMessageId: msg.id,
        call: { name: 'set_email_signature', args } as never,
        mode: 'commit',
        emit: () => {},
      } as never);
    };

    const acct = await db.selectFrom('email_accounts').select('email_address').where('id', '=', outlookId).executeTakeFirstOrThrow();
    const local = acct.email_address.split('@')[0];
    const out = await said(`set my ${local} signature to John / Acme`, { mailbox: local, text: 'John / Acme' });
    expect(out.data).toMatchObject({ ok: true, own: true });
    expect((await mailboxSignatureRow(db, userId, outlookId)).email_signature).toBe('John / Acme');

    // A mailbox the model filled in that nobody named changes the shared one.
    const shared = await said('set my signature to Ro', { mailbox: 'gmail', text: 'Ro' });
    expect(shared.data).toMatchObject({ ok: true, appliesTo: expect.any(String) });
    expect((await mailboxSignatureRow(db, userId, null)).email_signature).toBe('Ro');
    expect((await mailboxSignatureRow(db, userId, outlookId)).email_signature).toBe('John / Acme');
  });
});

describe('a picture sent in chat (ADR 0326)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personal: string;

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'sig-pic', 'John Doe');
    personal = (await ensurePersonalGroup(db, userId)).id;
    await db.updateTable('users').set({ email_signature: 'John' }).where('id', '=', userId).execute();
  });
  afterEach(async () => closeTestDb(db));

  const say = (groupId: string, args: Record<string, unknown>) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      call: { name: 'set_email_signature', args } as never,
      mode: 'commit',
      emit: () => {},
    } as never);

  it('puts the picture under the signature there now', async () => {
    const att = await saveFile(db, {
      scope: { kind: 'group', groupId: personal },
      uploadedBy: userId,
      filename: 'logo.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    const out = await say(personal, { pictureFileId: att.id });
    expect(out.data).toMatchObject({ ok: true, rich: true });
    const row = await mailboxSignatureRow(db, userId, null);
    expect(row.email_signature_html).toMatch(/^John<br \/><img src="http:\/\/[^"]+\/api\/v1\/signature-images\/[A-Za-z0-9_-]+"/);
  });

  it('will not take a picture from a chat the asker is not in', async () => {
    const other = await createUser(db, 'sig-other', 'Someone Else');
    const theirs = (await ensurePersonalGroup(db, other)).id;
    const att = await saveFile(db, {
      scope: { kind: 'group', groupId: theirs },
      uploadedBy: other,
      filename: 'logo.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    const out = await say(personal, { pictureFileId: att.id });
    expect(out.data).toMatchObject({ ok: false, reason: 'picture_not_found' });
    expect((await mailboxSignatureRow(db, userId, null)).email_signature).toBe('John');
  });

  it('a made-up picture id beside text saves the text', async () => {
    const out = await say(personal, { text: 'Ro', pictureFileId: 'a_doesnotexist' });
    expect(out.data).toMatchObject({ ok: true });
    expect((await mailboxSignatureRow(db, userId, null)).email_signature).toBe('Ro');
  });
});

describe('signature helpers', () => {
  it('picks a mailbox\'s own, else the shared one', () => {
    const own = { acct1: { text: 'Work', html: null }, primary: { text: null, html: null } };
    expect(signatureForMailbox('Shared', own, 'acct1')).toBe('Work');
    expect(signatureForMailbox('Shared', own, 'acct2')).toBe('Shared');
    expect(signatureForMailbox('Shared', own, null)).toBeNull();
  });

  it('swaps an untouched signature when the From changes, never an edited one', () => {
    expect(swapSignature('Hi.\n\n-- \nHome', 'Home', 'Work')).toBe('Hi.\n\n-- \nWork');
    expect(swapSignature('\n\n-- \nHome', 'Home', 'Work')).toBe('\n\n-- \nWork');
    expect(swapSignature('', 'Home', 'Work')).toBe('\n\n-- \nWork');
    expect(swapSignature('Hi.\n\n-- \nHome edited', 'Home', 'Work')).toBe('Hi.\n\n-- \nHome edited');
    expect(swapSignature('Hi.\n\n-- \nHome', 'Home', null)).toBe('Hi.');
    expect(swapSignature('Hi.', 'Home', 'Work')).toBe('Hi.');
  });

  it('matches a mailbox only by what the user said', () => {
    expect(namesMailbox('set my work signature', 'Work')).toBe(true);
    expect(namesMailbox('for john@acme.com', 'john@acme.com')).toBe(true);
    expect(namesMailbox('set my signature to Ro', 'gmail')).toBe(false);
  });
});
