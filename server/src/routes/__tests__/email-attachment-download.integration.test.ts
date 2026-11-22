/**
 * Prod, 2026-10-27: every attachment download from the email reader answered
 * Express's own "Cannot GET /api/v1/me/email/messages/<id>/attachments/<id>".
 * The route was registered through API.meEmailMessageAttachment, which encodes
 * the attachment id - so its `:attId` placeholder became the literal text
 * `%3AattId` and the route matched nothing. No test went through the route.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import { connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { __resetOutlookMock, __setOutlookMockAttachments } from '@/services/email-accounts/outlook-api.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// The shape of the id in the prod report: Graph's, with `=` padding (and a
// `/` and `+`, which Graph ids can carry, so the encoding is exercised).
const ATT_ID = 'AQMkADAwATExAGI4Ny00YzQwLTE5NmYtMDACLTAwCgBGAAAD/Zp+NVOMXfUe2jdUnOjYGTgcAB0OrWXf440iZ5xGPnkczVAAAAgEJAAAAESABAAE-1hBkGQNESNzC71bWgsMQ==';

describe('downloading an email attachment over HTTP', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tok: string;
  let userId: string;

  beforeEach(async () => {
    __resetOutlookMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'download');
    tok = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now }).execute();
  });

  afterEach(async () => {
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  it('serves the file for the path the app builds', async () => {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    __setOutlookMockAttachments(account.id, 'ol-msg-1', [
      { id: ATT_ID, name: 'SQ009000.pdf', contentType: 'application/pdf', size: 11, contentBytes: Buffer.from('PDF-RECEIPT').toString('base64') },
    ]);
    await syncAccount(db, account);
    const row = await db
      .selectFrom('email_messages')
      .select('id')
      .where('user_id', '=', userId)
      .where('gmail_message_id', 'like', '%ol-msg-1')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('email_messages')
      .set({ attachments_json: JSON.stringify([{ id: ATT_ID, filename: 'SQ009000.pdf', mimeType: 'application/pdf', size: 11 }]) })
      .where('id', '=', row.id)
      .execute();

    const res = await fetch(`${base}${API.meEmailMessageAttachment(row.id, ATT_ID)}`, {
      headers: { [SESSION_HEADER]: tok },
    });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe('PDF-RECEIPT');
  });
});
