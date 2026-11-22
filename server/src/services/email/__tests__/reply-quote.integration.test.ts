/**
 * ADR 0338 - a reply carries the email it answers.
 *
 * Prod, 2026-11-13: replies from Chord went out as the composer text alone.
 * The original (Tom Kent's "Neural Investor Deck" email, Outlook HTML with
 * its own signature and logo) was not under the reply at all, so the reply
 * read as a short plain note in the recipient's mail app.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { saveDraft } from '@/services/email/drafts.service.js';
import { quoteOriginal, sanitizeQuotedHtml } from '@/services/email/reply-quote.js';
import type { NormalizedMessage } from '@/services/google/gmail-sync.js';
import {
  ensureThreadRow,
  listThreads,
  recomputeThread,
  sendReply,
  upsertMessageMeta,
} from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TOM = 'tom@neuralads.ai';

// The shape of Tom's message as Outlook sent it: a whole document, a <style>
// block, Aptos inline styles, his own signature with a logo and a link.
const TOM_HTML =
  '<html><head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style type="text/css" style="display:none">\r\n' +
  '<!--\r\np\r\n\t{margin-top:0;\r\n\tmargin-bottom:0}\r\n-->\r\n</style></head><body dir="ltr">' +
  '<div class="elementToProof" style="font-family:Aptos,Aptos_EmbeddedFont,Aptos_MSFontService,Calibri,Helvetica,sans-serif;font-size:12pt;color:rgb(0,0,0)">' +
  'John - here is the deck we talked about. Rusty at Swell Capital is worth a call.</div>' +
  '<div id="Signature"><p><b>Tom Kent</b><br><img src="https://neuralads.ai/logo.png" width="120" alt="Neural Ads"><br>' +
  '<a href="https://neuralads.ai/">neuralads.ai</a></p>' +
  '<img src="cid:image001.png@01DC" alt="inline"><script>alert(1)</script>' +
  '<a href="javascript:alert(2)" onclick="alert(3)">bad</a></div></body></html>';

describe('a reply quotes the message it answers', () => {
  let db: Kysely<DB>;
  let userId: string;
  let threadRowId: string;
  let gid: string;
  let priorProvider: string;

  const put = async (html: string | null, text: string | null) => {
    const at = '2026-11-13T21:05:11Z';
    const nm: NormalizedMessage = {
      gmailMessageId: newId('gm'),
      gmailThreadId: gid,
      fromName: 'Tom Kent',
      fromEmail: TOM,
      toEmails: ['john@neuralads.ai'],
      ccEmails: [],
      subject: 'Neural Investor Deck',
      snippet: '',
      bodyText: text,
      bodyHtml: html,
      internalDate: at,
      isUnread: false,
      labelIds: ['INBOX'],
      rfc822MessageId: '<tom-deck@mail.example>',
      headers: { references: null, inReplyTo: null, date: null },
      attachmentsJson: '[]',
      icsText: '',
    };
    await upsertMessageMeta(db, userId, threadRowId, nm, at);
    await recomputeThread(db, userId, gid);
  };

  const lastSent = async () =>
    db
      .selectFrom('email_messages')
      .select(['body_text', 'body_html'])
      .where('thread_id', '=', threadRowId)
      .where('from_email', '!=', TOM)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    await db.updateTable('users').set({ last_tz: 'America/New_York' }).where('id', '=', userId).execute();
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    gid = newId('gt');
    threadRowId = await ensureThreadRow(db, userId, gid, '2026-11-13T21:05:11Z');
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  it('puts the original, formatting and all, under the reply', async () => {
    await put(TOM_HTML, null);
    await sendReply(db, userId, { threadRowId, body: 'Hi Tom,\n\nThanks for sharing the deck.' });
    const sent = await lastSent();

    expect(sent.body_html).toContain('Thanks for sharing the deck.');
    expect(sent.body_html).toContain('class="gmail_quote"');
    expect(sent.body_html).toContain('On Fri, Nov 13, 2026');
    expect(sent.body_html).toContain('Tom Kent &lt;tom@neuralads.ai&gt; wrote:');
    expect(sent.body_html).toContain('<b>Tom Kent</b>');
    expect(sent.body_html).toContain('src="https://neuralads.ai/logo.png"');
    expect(sent.body_html).toContain('font-family:Aptos');
    // The reply comes first.
    expect(sent.body_html!.indexOf('Thanks for sharing')).toBeLessThan(sent.body_html!.indexOf('gmail_quote'));

    expect(sent.body_text).toContain('Thanks for sharing the deck.\n\nOn Fri, Nov 13, 2026');
    expect(sent.body_text).toContain('> John - here is the deck we talked about.');
  });

  it('sends nothing that runs, and no cid picture it cannot attach', async () => {
    await put(TOM_HTML, null);
    await sendReply(db, userId, { threadRowId, body: 'Thanks' });
    const html = (await lastSent()).body_html!;
    expect(html).not.toMatch(/<script|alert\(|javascript:|onclick|cid:|<style|margin-top:0;/i);
  });

  it('quotes a text-only original as text', async () => {
    await put(null, 'Line one <b>not bold</b>\nLine two');
    await sendReply(db, userId, { threadRowId, body: 'Thanks' });
    const sent = await lastSent();
    expect(sent.body_html).toContain('Line one &lt;b&gt;not bold&lt;/b&gt;<br>Line two');
    expect(sent.body_text).toContain('> Line one <b>not bold</b>\n> Line two');
  });

  it('the list says which thread holds an unsent reply, and a queued one is not a draft', async () => {
    await put(TOM_HTML, null);
    const before = await listThreads(db, userId, { mode: 'traditional' });
    expect(before.find((t) => t.id === threadRowId)?.hasDraft).toBeUndefined();

    const draft = await saveDraft(db, userId, { kind: 'reply', threadId: threadRowId, body: 'Hi Tom, thanks' });
    const after = await listThreads(db, userId, { mode: 'traditional' });
    expect(after.find((t) => t.id === threadRowId)?.hasDraft).toBe(true);

    await db.updateTable('email_drafts').set({ send_after: new Date().toISOString() }).where('id', '=', draft.id).execute();
    const queued = await listThreads(db, userId, { mode: 'traditional' });
    expect(queued.find((t) => t.id === threadRowId)?.hasDraft).toBeUndefined();
  });

  // ADR 0339: the Plain / Rich switch decides what goes out.
  it('a rich reply sends what the editor held, cleaned, with the original quoted', async () => {
    await put(TOM_HTML, null);
    await sendReply(db, userId, {
      threadRowId,
      body: 'Hi Tom, thanks',
      format: 'rich',
      bodyHtml: '<div>Hi Tom, <b>thanks</b></div><img src="x" onerror="alert(1)"><script>alert(2)</script>',
    });
    const sent = await lastSent();
    expect(sent.body_html).toContain('<div>Hi Tom, <b>thanks</b></div>');
    expect(sent.body_html).not.toMatch(/onerror|<script|alert\(2\)/);
    expect(sent.body_html).toContain('class="gmail_quote"');
    expect(sent.body_text).toContain('Hi Tom, thanks');
    expect(sent.body_text).toContain('> John - here is the deck');
  });

  it('a draft keeps how it was written, and an older app leaves it alone', async () => {
    await put(TOM_HTML, null);
    const rich = await saveDraft(db, userId, {
      kind: 'reply',
      threadId: threadRowId,
      body: 'Hi Tom',
      format: 'rich',
      bodyHtml: '<div><b>Hi</b> Tom</div>',
    });
    expect(rich.format).toBe('rich');
    expect(rich.bodyHtml).toBe('<div><b>Hi</b> Tom</div>');
    const older = await saveDraft(db, userId, { kind: 'reply', threadId: threadRowId, body: 'Hi Tom!' });
    expect(older.format).toBe('rich');
    const plain = await saveDraft(db, userId, { kind: 'reply', threadId: threadRowId, body: 'Hi Tom', format: 'plain' });
    expect(plain.format).toBe('plain');
    expect(plain.bodyHtml).toBeUndefined();
  });

  it('a plain reply goes as text only', async () => {
    await put(TOM_HTML, null);
    await sendReply(db, userId, { threadRowId, body: 'Hi Tom, **thanks**', format: 'plain' });
    const sent = await lastSent();
    expect(sent.body_html).toBeNull();
    expect(sent.body_text).toContain('Hi Tom, **thanks**');
    expect(sent.body_text).toContain('> John - here is the deck');
  });

  it('an automatic reply quotes nothing', async () => {
    await put(TOM_HTML, null);
    await sendReply(db, userId, { threadRowId, body: 'I am away', autoReply: true });
    expect((await lastSent()).body_html).not.toContain('gmail_quote');
  });
});

describe('quoteOriginal', () => {
  const bodies = { text: 'Hi', html: '<div>Hi</div>' };

  it('leaves a reply alone when the original has no body', () => {
    const o = { from_name: 'Tom', from_email: TOM, internal_date: '2026-11-13T21:05:11Z', body_text: null, body_html: null };
    expect(quoteOriginal(bodies, o, 'America/New_York')).toEqual(bodies);
  });

  it('quotes a very large original as text', () => {
    const big = `<div>${'x'.repeat(500_000)}</div>`;
    const o = { from_name: null, from_email: TOM, internal_date: '2026-11-13T21:05:11Z', body_text: null, body_html: big };
    const out = quoteOriginal(bodies, o, 'UTC');
    expect(out.html).toContain(`${TOM} wrote:`);
    expect(out.html).toContain('<blockquote');
    expect(out.html).not.toContain(`<div>${'x'.repeat(10)}`.replace('<div>', '<div><div>'));
  });

  it('keeps an inline style but drops the parts that run', () => {
    expect(sanitizeQuotedHtml('<p style="color:red;background:expression(alert(1))">x</p>')).toBe('<p style="color:red">x</p>');
  });
});
