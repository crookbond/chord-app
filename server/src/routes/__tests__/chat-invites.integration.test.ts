/**
 * ADR 0318 - inviting someone to chat by their email, through the routes the
 * Messages screen calls. Three paths: not on Chord (an email with the chat's
 * link; following it answers the invite), on Chord but not yet connected (an
 * invite to accept or decline), and already connected (added at once).
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { claimChatInvitesFor } from '@/services/chat-invites.service.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

let db: Kysely<DB>;
let server: http.Server;
let base: string;
let priorProvider: string;
let john: string;
let johnTok: string;

async function mintToken(uid: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: uid, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

async function call(method: string, path: string, tok: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function person(username: string, name: string, email: string): Promise<{ id: string; tok: string }> {
  const id = await createUser(db, username, name);
  await db.updateTable('users').set({ email }).where('id', '=', id).execute();
  return { id, tok: await mintToken(id) };
}

const members = async (groupId: string) =>
  (await db.selectFrom('group_members').select('user_id').where('group_id', '=', groupId).execute())
    .map((r) => r.user_id)
    .sort();

const bodies = async (groupId: string) =>
  (await db.selectFrom('messages').select(['body', 'sender_id']).where('group_id', '=', groupId).orderBy('created_at').execute());

beforeEach(async () => {
  priorProvider = env.GMAIL_PROVIDER;
  db = await openTestDb();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  john = await createUser(db, 'ownertest', 'John Doe');
  await db.updateTable('users').set({ email: 'ownertest@gmail.com' }).where('id', '=', john).execute();
  johnTok = await mintToken(john);
});

afterEach(async () => {
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

describe('invite to chat by email', () => {
  it('someone not on Chord gets an email with the chat link; following it joins and connects them', async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    const sent = await call('POST', API.chatInviteByEmail, johnTok, { email: 'Karl@Media.example', message: 'Lunch Thursday?' });
    expect(sent.status).toBe(200);
    expect(sent.json).toMatchObject({ status: 'emailed', email: 'queued' });
    const groupId = sent.json.groupId as string;
    const code = (await db.selectFrom('groups').select('invite_code').where('id', '=', groupId).executeTakeFirstOrThrow()).invite_code;
    expect(sent.json.link).toContain(`/join/${code}`);

    // The email goes from John's mailbox and carries his message and the link.
    const [mail] = await db.selectFrom('email_drafts').select(['to_emails', 'body']).where('user_id', '=', john).execute();
    expect(mail!.to_emails).toEqual(['karl@media.example']);
    expect(mail!.body).toContain('Lunch Thursday?');
    expect(mail!.body).toContain(`/join/${code}`);
    // The message is already in the chat for when he arrives.
    expect((await bodies(groupId)).map((m) => m.body)).toEqual(['Lunch Thursday?']);

    // He signs in with a DIFFERENT address and follows the link: a direct
    // chat's link went to one person, so it is his.
    const karl = await person('karl', 'Karl Dale', 'karl.guest@gmail.com');
    const joined = await call('POST', API.groupJoin, karl.tok, { inviteCode: code });
    expect(joined.status).toBe(200);
    expect(await members(groupId)).toEqual([karl.id, john].sort());
    const [lo, hi] = [john, karl.id].sort();
    expect((await db.selectFrom('groups').select('pair_key').where('id', '=', groupId).executeTakeFirstOrThrow()).pair_key).toBe(`${lo}|${hi}`);

    // Connected now: inviting him again (by his real address) adds at once, into the same chat.
    const again = await call('POST', API.chatInviteByEmail, johnTok, { email: 'karl.guest@gmail.com', message: 'Still on?' });
    expect(again.json).toEqual({ status: 'added', groupId, name: 'Karl Dale' });
    expect((await bodies(groupId)).map((m) => m.body)).toEqual(['Lunch Thursday?', 'Still on?']);
  });

  it('with no mailbox to send from it says the email did NOT go and hands back the link', async () => {
    const sent = await call('POST', API.chatInviteByEmail, johnTok, { email: 'karl@media.example' });
    expect(sent.json.status).toBe('emailed');
    expect(sent.json.email).toBe('no_mailbox');
    expect(sent.json.link).toMatch(/\/join\/[A-Z0-9]+$/);
  });

  it('someone on Chord must accept first; accepting opens the direct chat with the message in it', async () => {
    const priya = await person('priya', 'Priya Shah', 'priya@example.com');
    const sent = await call('POST', API.chatInviteByEmail, johnTok, { email: 'PRIYA@example.com', message: 'Hi Priya' });
    expect(sent.json).toEqual({ status: 'asked', groupId: null, name: 'Priya Shah' });
    // Nothing exists between them until she answers.
    expect(await db.selectFrom('groups').select('id').where('pair_key', 'is not', null).execute()).toHaveLength(0);

    const waiting = await call('GET', API.meChatInvites, priya.tok);
    expect(waiting.json).toHaveLength(1);
    expect(waiting.json[0]).toMatchObject({ fromName: 'John Doe', groupName: null, message: 'Hi Priya' });
    // John cannot answer his own invite.
    expect((await call('POST', API.meChatInviteAccept(waiting.json[0].id), johnTok, {})).status).toBe(404);

    const accepted = await call('POST', API.meChatInviteAccept(waiting.json[0].id), priya.tok, {});
    expect(accepted.status).toBe(200);
    const groupId = accepted.json.groupId as string;
    expect(await members(groupId)).toEqual([priya.id, john].sort());
    expect(await bodies(groupId)).toEqual([{ body: 'Hi Priya', sender_id: john }]);
    expect((await call('GET', API.meChatInvites, priya.tok)).json).toHaveLength(0);

    // Either direction counts once accepted.
    const back = await call('POST', API.chatInviteByEmail, priya.tok, { email: 'ownertest@gmail.com' });
    expect(back.json).toEqual({ status: 'added', groupId, name: 'John Doe' });
  });

  it('someone who blocked the inviter is not asked, and the inviter cannot tell', async () => {
    const priya = await person('priya', 'Priya Shah', 'priya@example.com');
    await db
      .insertInto('blocks')
      .values({ blocker_user_id: priya.id, blocked_user_id: john, created_at: new Date().toISOString() })
      .execute();
    const sent = await call('POST', API.chatInviteByEmail, johnTok, { email: 'priya@example.com' });
    expect(sent.json).toEqual({ status: 'asked', groupId: null, name: 'Priya Shah' });
    expect((await call('GET', API.meChatInvites, priya.tok)).json).toHaveLength(0);
  });

  it('a declined invite adds nobody and the next invite asks again', async () => {
    const priya = await person('priya', 'Priya Shah', 'priya@example.com');
    await call('POST', API.chatInviteByEmail, johnTok, { email: 'priya@example.com' });
    const [inv] = (await call('GET', API.meChatInvites, priya.tok)).json;
    expect((await call('POST', API.meChatInviteDecline(inv.id), priya.tok, {})).json).toEqual({ ok: true, groupId: null });
    expect((await call('POST', API.chatInviteByEmail, johnTok, { email: 'priya@example.com' })).json.status).toBe('asked');
  });

  it('a group invite to someone on Chord adds them to that group on accept', async () => {
    const priya = await person('priya', 'Priya Shah', 'priya@example.com');
    const family = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john, nameIsCustom: true });
    const sent = await call('POST', API.chatInviteByEmail, johnTok, { email: 'priya@example.com', groupId: family.id });
    expect(sent.json).toEqual({ status: 'asked', groupId: family.id, name: 'Priya Shah' });
    const [inv] = (await call('GET', API.meChatInvites, priya.tok)).json;
    expect(inv.groupName).toBe('Doe Family');
    await call('POST', API.meChatInviteAccept(inv.id), priya.tok, {});
    expect(await members(family.id)).toEqual([priya.id, john].sort());
    // Already in it now.
    expect((await call('POST', API.chatInviteByEmail, johnTok, { email: 'priya@example.com', groupId: family.id })).status).toBe(409);
  });

  it('refuses a bad address, your own address, a chat you are not in, and your personal chat', async () => {
    expect((await call('POST', API.chatInviteByEmail, johnTok, { email: 'not-an-email' })).status).toBe(400);
    const self = await call('POST', API.chatInviteByEmail, johnTok, { email: 'OWNERTEST@gmail.com' });
    expect(self.status).toBe(400);
    expect(self.json.reason).toBe('self');
    const other = await person('other', 'Other', 'other@example.com');
    const theirs = await createGroup(db, { name: 'Theirs', kind: 'group', createdBy: other.id });
    expect((await call('POST', API.chatInviteByEmail, johnTok, { email: 'x@y.com', groupId: theirs.id })).status).toBe(403);
    const personal = await createGroup(db, { name: 'Me', kind: 'personal', createdBy: john });
    expect((await call('POST', API.chatInviteByEmail, johnTok, { email: 'x@y.com', groupId: personal.id })).status).toBe(400);
  });

  it('an emailed invite waits in the app for someone who signs up with that address without following the link', async () => {
    await call('POST', API.chatInviteByEmail, johnTok, { email: 'sam@example.com', message: 'Welcome' });
    const sam = await person('sam', 'Sam Lee', 'sam@example.com');
    expect(await claimChatInvitesFor(db, sam.id)).toBe(1);
    const [inv] = (await call('GET', API.meChatInvites, sam.tok)).json;
    expect(inv).toMatchObject({ fromName: 'John Doe', groupName: null });
    const accepted = await call('POST', API.meChatInviteAccept(inv.id), sam.tok, {});
    // The message was posted when the email went; accepting does not post it twice.
    expect((await bodies(accepted.json.groupId)).map((m) => m.body)).toEqual(['Welcome']);
    expect(await members(accepted.json.groupId)).toEqual([john, sam.id].sort());
  });
});
