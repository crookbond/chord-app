/**
 * ADR 0225 — a message's remote images are fetched when it arrives, and
 * opening it later is answered from the stored copy without a fetch.
 */
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { API } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  deletePreloadedImages,
  type ImageFetcher,
  preloadEmailImages,
} from '@/services/email/image-preload.js';
import { mintImageToken } from '@/services/email/image-token.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

type Env = {
  GMAIL_ENABLED: boolean;
  EMAIL_IMAGE_PROXY: boolean;
  EMAIL_IMAGE_PRELOAD: boolean;
  EMAIL_IMAGE_PRELOAD_BATCH: number;
  EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES: number;
  EMAIL_IMAGE_PRELOAD_DAYS: number;
  DATA_DIR: string;
};
const e = env as unknown as Env;

const DAY_MS = 24 * 60 * 60 * 1000;

describe('email image preload (ADR 0225)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let dataDir: string;
  const saved = { ...e };

  beforeEach(async () => {
    process.env.MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
    _resetCryptoCacheForTests();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chord-img-'));
    Object.assign(e, {
      GMAIL_ENABLED: true,
      EMAIL_IMAGE_PROXY: true,
      EMAIL_IMAGE_PRELOAD: true,
      EMAIL_IMAGE_PRELOAD_BATCH: 20,
      EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES: 5 * 1024 * 1024,
      EMAIL_IMAGE_PRELOAD_DAYS: 30,
      DATA_DIR: dataDir,
    });
    db = await openTestDb();
    userId = await createUser(db, 'image-preloader');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetCryptoCacheForTests();
    Object.assign(e, {
      GMAIL_ENABLED: saved.GMAIL_ENABLED,
      EMAIL_IMAGE_PROXY: saved.EMAIL_IMAGE_PROXY,
      EMAIL_IMAGE_PRELOAD: saved.EMAIL_IMAGE_PRELOAD,
      EMAIL_IMAGE_PRELOAD_BATCH: saved.EMAIL_IMAGE_PRELOAD_BATCH,
      EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES: saved.EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES,
      EMAIL_IMAGE_PRELOAD_DAYS: saved.EMAIL_IMAGE_PRELOAD_DAYS,
      DATA_DIR: saved.DATA_DIR,
    });
    await closeTestDb(db);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function addMessage(
    html: string | null,
    opts: { labels?: string[]; ageDays?: number } = {},
  ): Promise<string> {
    const at = new Date(Date.now() - (opts.ageDays ?? 0) * DAY_MS).toISOString();
    const labels = JSON.stringify(opts.labels ?? ['INBOX', 'UNREAD']);
    const threadId = newId('et');
    const gid = newId('gt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: gid,
        subject: 'Sale',
        from_email: 'news@shop.example',
        gmail_label_ids: labels,
        is_unread: 1,
        last_message_at: at,
        created_at: at,
        updated_at: at,
      })
      .execute();
    const id = newId('emm');
    await db
      .insertInto('email_messages')
      .values({
        id,
        user_id: userId,
        thread_id: threadId,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        subject: 'Sale',
        snippet: 'Sale',
        from_email: 'news@shop.example',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        gmail_label_ids: labels,
        is_unread: 1,
        ics_text: '',
        body_html: html,
        internal_date: at,
        created_at: at,
      })
      .execute();
    return id;
  }

  const png = (text: string): { body: Buffer; contentType: string } => ({
    body: Buffer.from(text),
    contentType: 'image/png',
  });

  const preloadedAt = async (id: string): Promise<string | null> =>
    (
      await db
        .selectFrom('email_messages')
        .select('images_preloaded_at')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).images_preloaded_at ?? null;

  it('stores every remote image of a new message and marks it done', async () => {
    const id = await addMessage(
      '<img src="https://cdn.shop.example/hero.png">' +
        '<td style="background:url(https://ad.doubleclick.net/px.gif?u=1&amp;c=2)">x</td>' +
        '<img src="cid:logo@shop"><img src="data:image/gif;base64,R0lGOD">',
    );
    const asked: string[] = [];
    const fetcher: ImageFetcher = async (url) => {
      asked.push(url.toString());
      return png(url.hostname);
    };

    const out = await preloadEmailImages(db, userId, fetcher);

    expect(out).toEqual({ messages: 1, stored: 2 });
    // The inline part and the embedded image are not remote; the entity in the
    // tracker's query is decoded, as the reader's own request will be.
    expect(asked.sort()).toEqual([
      'https://ad.doubleclick.net/px.gif?u=1&c=2',
      'https://cdn.shop.example/hero.png',
    ]);
    expect(await preloadedAt(id)).not.toBeNull();
  });

  it('goes through a message once, so a second pass fetches nothing', async () => {
    await addMessage('<img src="https://cdn.shop.example/hero.png">');
    const fetcher = vi.fn<ImageFetcher>(async () => png('x'));

    await preloadEmailImages(db, userId, fetcher);
    const second = await preloadEmailImages(db, userId, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ messages: 0, stored: 0 });
  });

  it('never fetches for junk or trashed mail, which must not learn the address is live', async () => {
    const spam = await addMessage('<img src="https://spam.example/p.gif">', { labels: ['SPAM'] });
    const trash = await addMessage('<img src="https://x.example/p.gif">', { labels: ['TRASH'] });
    const fetcher = vi.fn<ImageFetcher>(async () => png('x'));

    await preloadEmailImages(db, userId, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(await preloadedAt(spam)).not.toBeNull();
    expect(await preloadedAt(trash)).not.toBeNull();
  });

  it('never fetches for mail that is not from who it says (ADR 0294)', async () => {
    const id = await addMessage('<img src="https://track.rh-account-review.com/p.gif">');
    await db
      .updateTable('email_messages')
      .set({ from_name: 'Robinhood', from_email: 'security@rh-account-review.com' })
      .where('id', '=', id)
      .execute();
    const fetcher = vi.fn<ImageFetcher>(async () => png('x'));

    await preloadEmailImages(db, userId, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    expect(await preloadedAt(id)).not.toBeNull();
  });

  it('fetches nothing for a reader who blocks remote images', async () => {
    await db.updateTable('users').set({ email_images_auto: 0 }).where('id', '=', userId).execute();
    const id = await addMessage('<img src="https://cdn.shop.example/hero.png">');
    const fetcher = vi.fn<ImageFetcher>(async () => png('x'));

    await preloadEmailImages(db, userId, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
    // Left unmarked: turning images back on should still preload recent mail.
    expect(await preloadedAt(id)).toBeNull();
  });

  it('leaves mail older than the retention window alone', async () => {
    await addMessage('<img src="https://cdn.shop.example/old.png">', { ageDays: 45 });
    const fetcher = vi.fn<ImageFetcher>(async () => png('x'));

    await preloadEmailImages(db, userId, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops storing once a message has used its byte allowance', async () => {
    e.EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES = 10;
    await addMessage(
      '<img src="https://a.example/1.png"><img src="https://a.example/2.png">' +
        '<img src="https://a.example/3.png">',
    );
    const limits: number[] = [];
    const fetcher: ImageFetcher = async (_url, maxBytes) => {
      limits.push(maxBytes);
      return png('123456');
    };

    const out = await preloadEmailImages(db, userId, fetcher);

    // Six bytes fit, a second six do not.
    expect(out.stored).toBe(1);
    expect(Math.max(...limits)).toBeLessThanOrEqual(10);
  });

  it('removes stored images past the retention window', async () => {
    await addMessage('<img src="https://cdn.shop.example/hero.png">');
    await preloadEmailImages(db, userId, async () => png('x'));
    await db
      .updateTable('email_image_cache')
      .set({ fetched_at: new Date(Date.now() - 31 * DAY_MS).toISOString() })
      .execute();

    await preloadEmailImages(db, userId, async () => png('x'));

    expect(await db.selectFrom('email_image_cache').selectAll().execute()).toEqual([]);
    expect(await fs.readdir(path.join(dataDir, 'email-images', userId))).toEqual([]);
  });

  it('removes the files of a deleted account', async () => {
    await addMessage('<img src="https://cdn.shop.example/hero.png">');
    await preloadEmailImages(db, userId, async () => png('x'));

    await deletePreloadedImages(userId);

    await expect(fs.stat(path.join(dataDir, 'email-images', userId))).rejects.toThrow();
  });

  describe('opening the mail', () => {
    let server: http.Server;
    let base: string;
    const realFetch = globalThis.fetch.bind(globalThis);

    beforeEach(async () => {
      server = http.createServer(buildApp(db));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const open = (target: string): Promise<Response> =>
      realFetch(
        `${base}${API.meEmailImageProxy}?k=${encodeURIComponent(mintImageToken(userId))}` +
          `&u=${encodeURIComponent(target)}`,
      );

    it('is answered from the stored copy, and the sender hears nothing', async () => {
      await addMessage('<img src="https://ad.doubleclick.net/px.gif?u=1&amp;c=2">');
      await preloadEmailImages(db, userId, async () => png('STORED'));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await open('https://ad.doubleclick.net/px.gif?u=1&c=2');

      expect(res.headers.get('content-type')).toBe('image/png');
      expect(await res.text()).toBe('STORED');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches now when nothing was stored for that image', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(Buffer.from('LIVE'), { status: 200, headers: { 'content-type': 'image/png' } }),
      );

      const res = await open('https://cdn.example/never-preloaded.png');

      expect(await res.text()).toBe('LIVE');
    });

    it("does not serve one reader's stored image to another", async () => {
      await addMessage('<img src="https://cdn.shop.example/hero.png">');
      await preloadEmailImages(db, userId, async () => png('STORED'));
      const other = await createUser(db, 'someone-else');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(Buffer.from('LIVE'), { status: 200, headers: { 'content-type': 'image/png' } }),
      );

      const res = await realFetch(
        `${base}${API.meEmailImageProxy}?k=${encodeURIComponent(mintImageToken(other))}` +
          `&u=${encodeURIComponent('https://cdn.shop.example/hero.png')}`,
      );

      expect(await res.text()).toBe('LIVE');
    });
  });
});
