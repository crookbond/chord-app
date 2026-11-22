/**
 * ADR 0060 — HTTP routes for the in-app Gmail reader, driven by the mock Gmail
 * provider (no network). Covers the feature gate, auth, backfill sync, the
 * thread list + detail shapes, reply (marks read), and archive write-back.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import {
  API,
  CLASSIFIER_TOKEN_HEADER,
  SESSION_HEADER,
  type EmailStatus,
  type EmailThreadDetail,
  type EmailThreadSummary,
  type EmailTileLevel,
} from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { __settleAfterSyncForTests, runAiPassesInBackground } from '@/services/google/gmail.service.js';
import { __resetLlmCacheForTests } from '@/services/llm/factory.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

async function mintToken(db: Kysely<DB>, userId: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

describe('GET/POST /me/email/* (routes, mock provider)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tok: string;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'mock';
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tok = await mintToken(db, await createUser(db, 'mail-user'));
  });

  afterEach(async () => {
    // env is a shared module singleton across the worker — restore the defaults
    // so this suite doesn't leak GMAIL_ENABLED=true into other tests.
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    (env as { EMAIL_CLASSIFIER_SERVICE_TOKEN: string }).EMAIL_CLASSIFIER_SERVICE_TOKEN = '';
    __resetLlmCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const get = (path: string, token = tok) =>
    fetch(`${base}${path}`, { headers: { [SESSION_HEADER]: token } });
  const post = (path: string, body: unknown = {}, token = tok) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: token },
      body: JSON.stringify(body),
    });
  /**
   * The sync response is the mirror; classification, magics and the rest run
   * after it and tell the client with `email.synced`. Tests that read what those
   * passes produce wait for them to drain, as a client does for that event.
   */
  const syncSettled = async () => {
    const res = await post(API.meEmailSync);
    await __settleAfterSyncForTests();
    return res;
  };

  it('404s the whole surface when GMAIL_ENABLED is off', async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    const res = await get(API.meEmailStatus);
    expect(res.status).toBe(404);
  });

  it('401s without a session', async () => {
    const res = await fetch(`${base}${API.meEmailStatus}`);
    expect(res.status).toBe(401);
  });

  it('reports connected + backfill state, then syncs the mock inbox', async () => {
    const before = (await (await get(API.meEmailStatus)).json()) as EmailStatus;
    expect(before).toMatchObject({ connected: true, backfillDone: false });

    const sync = await syncSettled();
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ backfillDone: true, inserted: 4 });

    const after = (await (await get(API.meEmailStatus)).json()) as EmailStatus;
    expect(after.backfillDone).toBe(true);
    expect(after.lastSyncedAt).toBeTruthy();
  });

  it('lists threads newest-first and opens a thread with a body', async () => {
    await syncSettled();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    expect(threads).toHaveLength(4);
    // Grandma's "Sunday dinner?" is the newest mock message.
    expect(threads[0].subject).toBe('Sunday dinner?');
    expect(threads[0].isUnread).toBe(true);

    const detail = (await (await get(API.meEmailThread(threads[0].id))).json()) as EmailThreadDetail;
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0].bodyText).toContain('Sunday');
  });

  it('reply marks the thread read and appends the sent message', async () => {
    await syncSettled();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const target = threads.find((t) => t.subject === 'Sunday dinner?')!;

    const res = await post(API.meEmailThreadReply(target.id), { body: 'Yes! See you at 5.' });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as EmailThreadDetail;
    expect(detail.thread.isUnread).toBe(false);
    expect(detail.messages.length).toBe(2);
    expect(detail.messages[detail.messages.length - 1].bodyText).toBe('Yes! See you at 5.');
  });

  it('archive write-back removes the thread from the traditional list', async () => {
    await syncSettled();
    let threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const target = threads.find((t) => t.subject === 'Your package is arriving today')!;

    const res = await post(API.meEmailThreadModify(target.id), { archive: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ isArchived: true });

    threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    expect(threads.find((t) => t.id === target.id)).toBeUndefined();
  });

  it('imports email attachments into the personal-group knowledge base (ADR 0071)', async () => {
    await syncSettled();

    // The mock flight email carries UA512-itinerary.txt; afterSync imports it
    // into the user's personal group via the normal saveFile pipeline.
    const att = await db
      .selectFrom('attachments')
      .selectAll()
      .where('filename', '=', 'UA512-itinerary.txt')
      .executeTakeFirst();
    expect(att).toBeDefined();
    expect(att!.scope_kind).toBe('group');

    const user = await db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'mail-user')
      .executeTakeFirstOrThrow();
    const personal = await db
      .selectFrom('groups')
      .innerJoin('group_members', 'group_members.group_id', 'groups.id')
      .where('groups.kind', '=', 'personal')
      .where('group_members.user_id', '=', user.id)
      .select('groups.id as id')
      .executeTakeFirstOrThrow();
    expect(att!.scope_id).toBe(personal.id);
    expect(att!.uploaded_by).toBe(user.id);

    // A second sync neither rescans (per-message marker) nor duplicates.
    await syncSettled();
    const count = await db
      .selectFrom('attachments')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('filename', '=', 'UA512-itinerary.txt')
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);

    const unscanned = await db
      .selectFrom('email_messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('attachments_imported_at', 'is', null)
      .executeTakeFirstOrThrow();
    expect(Number(unscanned.n)).toBe(0);
  });

  it('a blob-missing row does not satisfy the dupe check — re-arrival heals the loss', async () => {
    await syncSettled();
    const att = await db
      .selectFrom('attachments')
      .select(['id'])
      .where('filename', '=', 'UA512-itinerary.txt')
      .executeTakeFirstOrThrow();

    // The blob is lost; the same file arrives again (clearing the per-message
    // marker stands in for a re-forward — the dupe check under test is the
    // same either way).
    await db
      .updateTable('attachments')
      .set({ blob_missing_at: new Date().toISOString() })
      .where('id', '=', att.id)
      .execute();
    await db
      .updateTable('email_messages')
      .set({ attachments_imported_at: null })
      .execute();

    // No new mail arrives, so the Email-tab sync starts no AI passes; the
    // background sweep runs them instead.
    const user = await db.selectFrom('users').select('id').where('username', '=', 'mail-user').executeTakeFirstOrThrow();
    runAiPassesInBackground(db, user.id);
    await __settleAfterSyncForTests();
    const rows = await db
      .selectFrom('attachments')
      .select(['id', 'blob_missing_at'])
      .where('filename', '=', 'UA512-itinerary.txt')
      .execute();
    expect(rows).toHaveLength(2); // ghost kept (visible in Attachments) + fresh live copy
    expect(rows.filter((r) => !r.blob_missing_at)).toHaveLength(1);
  });

  it('reply-all with cc/bcc + signature: recipients honored, the signature sent as written', async () => {
    // Signature lives in Settings (users.email_signature) via the email-prefs patch.
    const prefs = await fetch(`${base}${API.meEmailPrefs}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
      body: JSON.stringify({ emailSignature: 'John\nSent from Chord' }),
    });
    expect(prefs.status).toBe(200);

    await syncSettled();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const target = threads.find((t) => t.subject === 'Sunday dinner?')!;

    // The composer opens with the signature in the box (ADR 0260 addendum).
    const res = await post(API.meEmailThreadReply(target.id), {
      body: 'Count us in.\n\n-- \nJohn\nSent from Chord',
      to: ['grandma@example.com', 'uncle@example.com'],
      cc: ['aunt@example.com'],
      bcc: ['secret@example.com'],
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as EmailThreadDetail;
    const sent = detail.messages[detail.messages.length - 1];
    expect(sent.toEmails).toEqual(['grandma@example.com', 'uncle@example.com']);
    expect(sent.ccEmails).toEqual(['aunt@example.com']);
    // Exactly once, after the conventional "-- " separator; html mirrors it.
    expect(sent.bodyText).toBe('Count us in.\n\n-- \nJohn\nSent from Chord');
    expect(sent.bodyHtml).toContain('Count us in.<br><br>-- <br>John<br>Sent from Chord');
  });

  it('a reply the user deleted the signature from goes out with none', async () => {
    const prefs = await fetch(`${base}${API.meEmailPrefs}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
      body: JSON.stringify({ emailSignature: 'John\nSent from Chord' }),
    });
    expect(prefs.status).toBe(200);
    await syncSettled();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const target = threads.find((t) => t.subject === 'Sunday dinner?')!;

    const res = await post(API.meEmailThreadReply(target.id), { body: 'Count us in.' });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as EmailThreadDetail;
    const sent = detail.messages[detail.messages.length - 1];
    expect(sent.bodyText).toBe('Count us in.');
    expect(sent.bodyHtml).not.toContain('Sent from Chord');
  });

  it('a rich signature: cleaned on the way in, sent as HTML, and the text half still reads', async () => {
    const putPrefs = (body: unknown) =>
      fetch(`${base}${API.meEmailPrefs}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
        body: JSON.stringify(body),
      });
    const stored = async () =>
      (await (await get(API.meSettings)).json()) as {
        emailSignature: string | null;
        emailSignatureHtml: string | null;
      };

    // Pasted from anywhere, so what is hostile in it never reaches storage.
    const saved = await putPrefs({
      emailSignatureHtml:
        '<b>John Doe</b><br><a href="https://chordapp.ai">My site</a><script>alert(1)</script>' +
        '<img src="https://chordapp.ai/logo.png" onerror="alert(1)">',
    });
    expect(saved.status).toBe(200);
    const now = await stored();
    expect(now.emailSignatureHtml).toContain('<b>John Doe</b>');
    expect(now.emailSignatureHtml).toContain('href="https://chordapp.ai"');
    expect(now.emailSignatureHtml).not.toMatch(/script|onerror|alert/);
    // The plain half is derived from it, links included.
    expect(now.emailSignature).toContain('My site (https://chordapp.ai)');

    await syncSettled();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const target = threads.find((t) => t.subject === 'Sunday dinner?')!;
    // The composer put the plain version in the box; the html half shows the rich one.
    const res = await post(API.meEmailThreadReply(target.id), {
      body: `Count us in.\n\n-- \n${now.emailSignature}`,
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as EmailThreadDetail;
    const sent = detail.messages[detail.messages.length - 1];
    expect(sent.bodyHtml).toContain('Count us in.');
    expect(sent.bodyHtml).toContain('<a href="https://chordapp.ai" rel="noopener noreferrer">My site</a>');
    expect(sent.bodyHtml).not.toMatch(/script|onerror/);
    expect(sent.bodyText).toContain('Count us in.\n\n-- \nJohn Doe');
    expect(sent.bodyText).toContain('My site (https://chordapp.ai)');

    // Typing a plain signature replaces the rich one - the old HTML must not ride along.
    expect((await putPrefs({ emailSignature: 'John' })).status).toBe(200);
    expect(await stored()).toMatchObject({ emailSignature: 'John', emailSignatureHtml: null });

    // Clearing the HTML clears it.
    await putPrefs({ emailSignatureHtml: '<i>x</i>' });
    await putPrefs({ emailSignatureHtml: null });
    expect(await stored()).toMatchObject({ emailSignatureHtml: null });
  });

  it('rejects a malformed reply recipient', async () => {
    await syncSettled();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const res = await post(API.meEmailThreadReply(threads[0].id), {
      body: 'hi',
      cc: ['not-an-email'],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty reply body', async () => {
    await syncSettled();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const res = await post(API.meEmailThreadReply(threads[0].id), { body: '' });
    expect(res.status).toBe(400);
  });

  it('builds AI tiles from the mock classifier and drills into a subtree', async () => {
    await syncSettled(); // backfill → mock classifier runs

    // Root tiles: the four mock threads land under four top tiles.
    const root = (await (await get(API.meEmailTiles)).json()) as EmailTileLevel;
    expect(root.parent).toBeNull();
    const titles = root.tiles.map((t) => t.title).sort();
    expect(titles).toEqual(['Deliveries', 'Finance', 'Friends & family', 'Travel']);
    const travel = root.tiles.find((t) => t.title === 'Travel')!;
    expect(travel.count).toBe(1);
    expect(travel.hasChildren).toBe(true);

    // Drill into Travel → its Flights leaf.
    const level = (await (await get(`${API.meEmailTiles}?parent=${encodeURIComponent(travel.id)}`)).json()) as EmailTileLevel;
    expect(level.parent?.id).toBe(travel.id);
    const flights = level.tiles.find((t) => t.title === 'Flights')!;
    expect(flights).toMatchObject({ count: 1, hasChildren: false });

    // Flip the leaf to its thread list.
    const threads = (await (
      await get(`${API.meEmailThreads}?mode=category&category=${encodeURIComponent(flights.id)}`)
    ).json()) as EmailThreadSummary[];
    expect(threads).toHaveLength(1);
    expect(threads[0].subject).toContain('SFO');
  });

  it('accepts a classifier snapshot via the ingest route and rejects a cyclic one', async () => {
    await syncSettled();

    const good = await post(API.meEmailClassification, {
      version: 1,
      userId: 'ignored',
      categories: [{ id: 'root', parentId: null, title: 'All', depth: 0 }],
      assignments: [],
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ categories: 1, assignments: 0 });

    const bad = await post(API.meEmailClassification, {
      version: 1,
      userId: 'ignored',
      categories: [
        { id: 'a', parentId: 'b', title: 'A', depth: 1 },
        { id: 'b', parentId: 'a', title: 'B', depth: 1 },
      ],
      assignments: [],
    });
    expect(bad.status).toBe(422);
  });

  it('accepts classifier ingest with a valid service token (no session)', async () => {
    const userId = await createUser(db, 'svc-classifier');
    (env as { EMAIL_CLASSIFIER_SERVICE_TOKEN: string }).EMAIL_CLASSIFIER_SERVICE_TOKEN = 'test-clf-token';

    const userTok = await mintToken(db, userId);
    await fetch(`${base}${API.meEmailSync}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: userTok },
      body: '{}',
    });

    const res = await fetch(`${base}${API.meEmailClassification}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CLASSIFIER_TOKEN_HEADER]: 'test-clf-token',
      },
      body: JSON.stringify({
        version: 1,
        userId,
        categories: [{ id: 'svc-root', parentId: null, title: 'Service', depth: 0 }],
        assignments: [],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ categories: 1 });

    const wrong = await fetch(`${base}${API.meEmailClassification}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CLASSIFIER_TOKEN_HEADER]: 'wrong-token',
      },
      body: JSON.stringify({
        version: 1,
        userId,
        categories: [{ id: 'x', parentId: null, title: 'X', depth: 0 }],
        assignments: [],
      }),
    });
    expect(wrong.status).toBe(401);
  });

  it('populates tiles via EMAIL_CLASSIFIER=llm + mock LLM after sync', async () => {
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'llm';
    (env as { LLM_PROVIDER: string }).LLM_PROVIDER = 'mock';
    __resetLlmCacheForTests();

    const sync = await syncSettled();
    expect(sync.status).toBe(200);

    const root = (await (await get(API.meEmailTiles)).json()) as EmailTileLevel;
    expect(root.tiles.length).toBeGreaterThan(0);
  });

  it('applyCategoryLabel creates a Chord/<category> Gmail label on the thread', async () => {
    await syncSettled();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const target = threads.find((t) => t.categoryId)!;
    expect(target.categoryId).toBeTruthy();

    const res = await post(API.meEmailThreadModify(target.id), { applyCategoryLabel: true });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as EmailThreadSummary;
    expect(summary.labelIds.length).toBeGreaterThan(0);

    const cat = await db
      .selectFrom('email_categories')
      .select(['title', 'gmail_label_id'])
      .where('id', '=', target.categoryId!)
      .executeTakeFirst();
    expect(cat?.gmail_label_id).toBeTruthy();
    expect(summary.labelIds).toContain(cat!.gmail_label_id!);
  });

  it('disconnect clears threads and categories', async () => {
    await syncSettled();
    const beforeCats = await db
      .selectFrom('email_categories')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    expect(Number(beforeCats?.n ?? 0)).toBeGreaterThan(0);

    const res = await post(API.meEmailDisconnect);
    expect(res.status).toBe(200);

    const threads = await db.selectFrom('email_threads').select('id').execute();
    expect(threads).toHaveLength(0);
    const cats = await db.selectFrom('email_categories').select('id').execute();
    expect(cats).toHaveLength(0);
  });

  it('PUT /me/email/prefs patches digest + label-sync flags', async () => {
    const put = (body: unknown) =>
      fetch(`${base}${API.meEmailPrefs}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
        body: JSON.stringify(body),
      });
    const res = await put({
      emailDigestEnabled: false,
      gmailSyncLabelsEnabled: true,
      chordLabelPushEnabled: true,
    });
    expect(res.status).toBe(200);

    const settings = (await (await get(API.meSettings)).json()) as {
      emailDigestEnabled: boolean;
      gmailSyncLabelsEnabled: boolean;
      chordLabelPushEnabled: boolean;
    };
    expect(settings.emailDigestEnabled).toBe(false);
    expect(settings.gmailSyncLabelsEnabled).toBe(true);
    expect(settings.chordLabelPushEnabled).toBe(true);

    const off = await put({ chordLabelPushEnabled: false });
    expect(off.status).toBe(200);
    const again = (await (await get(API.meSettings)).json()) as {
      chordLabelPushEnabled: boolean;
    };
    expect(again.chordLabelPushEnabled).toBe(false);
  });
});
