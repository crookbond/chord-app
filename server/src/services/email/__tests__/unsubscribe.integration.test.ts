/**
 * Unsubscribing (ADR 0122). The tests that matter are about what we CLAIM:
 * only a completed one-click POST may come back "Unsubscribed", and the URL we
 * POST to came out of an email, so it goes through the SSRF guard.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newId } from '@/utils/ids.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// The guard is real; only DNS is faked, so a private answer still refuses.
vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) =>
    hostname === 'internal.example'
      ? [{ address: '10.0.0.5' }]
      : [{ address: '93.184.216.34' }],
}));

const sent: { to: string[]; subject: string }[] = [];
vi.mock('@/services/google/gmail.service.js', () => ({
  sendNewMessage: async (
    _db: unknown,
    _userId: string,
    input: { to: string[]; subject: string },
  ) => {
    sent.push(input);
    return { fromEmail: 'me@example.com' };
  },
}));

const { resolveThreadUnsubscribe, unsubscribeThread } = await import(
  '@/services/email/unsubscribe.service.js'
);

let db: Kysely<DB>;
let userId: string;

async function thread(headers: {
  listUnsubscribe: string | null;
  listUnsubscribePost?: string | null;
  from?: string;
}): Promise<string> {
  const now = new Date().toISOString();
  const id = newId('et');
  const gid = newId('gt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject: 'Weekly deals',
      from_email: headers.from ?? 'news@list.example',
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: id,
      gmail_message_id: newId('gm'),
      gmail_thread_id: gid,
      subject: 'Weekly deals',
      snippet: 'deals',
      from_email: headers.from ?? 'news@list.example',
      to_emails: JSON.stringify([]),
      cc_emails: JSON.stringify([]),
      list_unsubscribe: headers.listUnsubscribe,
      list_unsubscribe_post: headers.listUnsubscribePost ?? null,
      ics_text: '',
      internal_date: now,
      created_at: now,
    })
    .execute();
  return id;
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  sent.length = 0;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

describe('what a thread offers', () => {
  it('offers nothing when the sender sent no header', async () => {
    const id = await thread({ listUnsubscribe: null });

    expect(await resolveThreadUnsubscribe(db, userId, id)).toBeNull();
  });

  it('reads the kind from the headers', async () => {
    const id = await thread({
      listUnsubscribe: '<https://list.example/u/abc>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });

    expect((await resolveThreadUnsubscribe(db, userId, id))?.kind).toBe('one_click');
  });
});

describe('one-click', () => {
  it('POSTs the RFC 8058 body and reports the truth when it works', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('', { status: 200 });
    });
    const id = await thread({
      listUnsubscribe: '<https://list.example/u/abc>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });

    const out = await unsubscribeThread(db, userId, id);

    expect(out).toMatchObject({ kind: 'one_click', unsubscribed: true });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('List-Unsubscribe=One-Click');
  });

  it('does not claim success when the endpoint refuses', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const id = await thread({
      listUnsubscribe: '<https://list.example/u/abc>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });

    const out = await unsubscribeThread(db, userId, id);

    expect(out.unsubscribed).toBe(false);
    expect(out.message).not.toMatch(/^Unsubscribed/);
  });

  it('refuses a URL that resolves to a private address', async () => {
    // The URL came out of an email, so it is exactly as trustworthy as the
    // sender - which is to say, not.
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('', { status: 200 });
    });
    const id = await thread({
      listUnsubscribe: '<https://internal.example/u/abc>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });

    const out = await unsubscribeThread(db, userId, id);

    expect(called).toBe(false);
    expect(out.unsubscribed).toBe(false);
  });

  it('records the sender so the thread can show it was asked', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 200 }));
    const id = await thread({
      listUnsubscribe: '<https://list.example/u/abc>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });

    await unsubscribeThread(db, userId, id);

    expect((await resolveThreadUnsubscribe(db, userId, id))?.requestedAt).toBeTruthy();
  });
});

describe('mailto', () => {
  it('sends the request and says only that it was sent', async () => {
    const id = await thread({ listUnsubscribe: '<mailto:leave@list.example?subject=stop>' });

    const out = await unsubscribeThread(db, userId, id);

    expect(sent).toEqual([{ to: ['leave@list.example'], subject: 'stop', body: 'unsubscribe' }]);
    // A mailto is a request. Whether the list honours it is not observable.
    expect(out.unsubscribed).toBe(false);
    expect(out.requested).toBe(true);
  });
});

describe('link', () => {
  it('hands back the page rather than pretending to have finished it', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response('', { status: 200 });
    });
    const id = await thread({ listUnsubscribe: '<https://list.example/prefs>' });

    const out = await unsubscribeThread(db, userId, id);

    expect(out).toMatchObject({ kind: 'link', unsubscribed: false, url: 'https://list.example/prefs' });
    expect(called).toBe(false);
  });
});
