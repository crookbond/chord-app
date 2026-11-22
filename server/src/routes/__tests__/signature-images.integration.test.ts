/**
 * ADR 0326 - a picture in a pasted signature is kept by Chord and served at a
 * public link, so the recipients of mail signed with it can load it.
 *
 * The reported failure: a signature pasted from Outlook or Apple Mail carries
 * its logo as a `data:` URL (or a clipboard-only `cid:`), the signature
 * cleaner drops both, and the signature is saved without its picture.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  API,
  cleanPastedSignatureHtml,
  listImageSources,
  pastedImageNeed,
  plainTextToSignatureHtml,
  replaceImageSources,
} from '@chord/kernel';
import type { Kysely } from 'kysely';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { sanitizeSignatureHtml } from '@/services/email/signature.js';
import { isSignatureImageUrl, sniffImageType } from '@/services/email/signature-images.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/** A real 1x1 PNG. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

describe('signature pictures over HTTP', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'sig-pictures', 'John Doe');
    token = `tok-${userId}`;
    const now = new Date().toISOString();
    await db
      .insertInto('sessions')
      .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
      .execute();
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const upload = (data: string) =>
    fetch(`${base}${API.meEmailSignatureImages}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chord-token': token },
      body: JSON.stringify({ data }),
    });

  it('the bug: a pasted signature\'s data: picture does not survive saving', () => {
    const pasted = `<b>John Doe</b><br><img src="${PNG_DATA_URL}" width="120">`;
    expect(sanitizeSignatureHtml(pasted)).not.toContain('<img');
  });

  it('keeps an uploaded picture and serves it publicly, with no session', async () => {
    const res = await upload(PNG_DATA_URL);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith(`${base}/api/v1/signature-images/`)).toBe(true);
    expect(isSignatureImageUrl(url)).toBe(true);

    const pic = await fetch(url);
    expect(pic.status).toBe(200);
    expect(pic.headers.get('content-type')).toBe('image/png');
    expect(pic.headers.get('x-content-type-options')).toBe('nosniff');
    expect(pic.headers.get('cache-control')).toContain('public');
    expect(Buffer.from(await pic.arrayBuffer()).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);

    // The signature that links to it is kept whole when saved.
    const saved = sanitizeSignatureHtml(`<b>John Doe</b><br><img src="${url}" width="120">`);
    expect(saved).toContain(`src="${url}"`);
  });

  it('the same picture twice is one link', async () => {
    const a = (await (await upload(PNG_DATA_URL)).json()) as { url: string };
    const b = (await (await upload(PNG_B64)).json()) as { url: string };
    expect(b.url).toBe(a.url);
    const rows = await db.selectFrom('signature_images').select('id').where('user_id', '=', userId).execute();
    expect(rows).toHaveLength(1);
  });

  it('refuses what is not a picture, an SVG included, and anything too large to shrink', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect((await upload(`data:image/svg+xml;base64,${svg}`)).status).toBe(400);
    const big = Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.alloc(1_500_000)]).toString('base64');
    expect((await upload(big)).status).toBe(413);
  });

  it('draws a wide picture smaller before keeping it', async () => {
    const wide = await sharp({ create: { width: 2400, height: 600, channels: 3, background: '#3366cc' } })
      .png()
      .toBuffer();
    const { url } = (await (await upload(wide.toString('base64'))).json()) as { url: string };
    const kept = Buffer.from(await (await fetch(url)).arrayBuffer());
    const meta = await sharp(kept).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(200);
  });

  it('needs a session to upload, and an unknown link is a 404', async () => {
    const res = await fetch(`${base}${API.meEmailSignatureImages}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: PNG_B64 }),
    });
    expect(res.status).toBe(401);
    expect((await fetch(`${base}${API.signatureImage('AAAAAAAAAAAAAAAAAAAAAAAA')}`)).status).toBe(404);
  });

  it('an http picture that is not one of ours is still dropped', () => {
    expect(sanitizeSignatureHtml('<img src="http://tracker.example/p.png">')).toBe('');
  });
});

describe('a pasted signature', () => {
  // The clipboard HTML Outlook on Windows puts there when a signature is copied.
  const OUTLOOK = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>p.MsoNormal{margin:0}</style><!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]--></head><body><!--StartFragment--><p class="MsoNormal"><b>John Doe</b><o:p></o:p></p><p class="MsoNormal"><!--[if gte vml 1]><v:shape><v:imagedata src="file:///C:/Users/r/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png"/></v:shape><![endif]--><![if !vml]><img width="120" height="40" src="file:///C:/Users/r/AppData/Local/Temp/msohtmlclip1/01/clip_image002.png"><![endif]><o:p></o:p></p><!--EndFragment--></body></html>`;

  it('keeps only what was copied, without Office markup', () => {
    const clean = cleanPastedSignatureHtml(OUTLOOK);
    expect(clean).toBe(
      '<p style="margin: 0" class="MsoNormal"><b>John Doe</b></p><p style="margin: 0" class="MsoNormal"><img width="120" height="40" src="file:///C:/Users/r/AppData/Local/Temp/msohtmlclip1/01/clip_image002.png"></p>',
    );
  });

  // Outlook and Word keep a signature's look in classes, not on the elements;
  // the saved signature keeps only inline styles, so the look went with them.
  it("keeps the signature's formatting when it lives in a style block", () => {
    const doc = `<html><head><style><!--
@font-face {font-family:"Segoe UI"; panose-1:2 11 5 2 4 2 4 2 2 3;}
@media print { p.MsoNormal {color:red} }
p.MsoNormal, li.MsoNormal {margin:0in; font-size:11.0pt; font-family:"Calibri",sans-serif; mso-fareast-language:EN-US;}
span.Title {color:#1F4E79; font-weight:bold;}
a {color:#0563C1; text-decoration:underline;}
body {font-family:"Segoe UI",sans-serif;}
--></style></head><body lang="EN-US" style="word-wrap:break-word"><!--StartFragment--><p class="MsoNormal"><span class="Title">John Doe</span><o:p></o:p></p><p class="MsoNormal" style="font-size:9pt"><a href="https://www.chordapp.ai">chordapp.ai</a></p><!--EndFragment--></body></html>`;
    const clean = cleanPastedSignatureHtml(doc);
    expect(clean).toContain('font-family: &quot;Calibri&quot;,sans-serif');
    expect(clean).toContain('color: #1F4E79; font-weight: bold');
    // The element's own style wins over its class.
    expect(clean).toContain('font-size: 9pt');
    expect(clean).not.toMatch(/mso-|color: red|panose/);
    // The page's font is carried by a wrapper, since <body> is not kept.
    expect(clean.startsWith('<div style="font-family: &quot;Segoe UI&quot;,sans-serif; word-wrap: break-word">')).toBe(true);

    const saved = sanitizeSignatureHtml(clean);
    expect(saved).toContain('font-family:&quot;Calibri&quot;,sans-serif');
    expect(saved).toContain('color:#1F4E79');
    expect(saved).toContain('font-weight:bold');
    expect(saved).toContain('font-size:9pt');
  });

  it('says what each picture needs', () => {
    expect(pastedImageNeed('https://lh3.googleusercontent.com/logo.png')).toBe('keep');
    expect(pastedImageNeed(PNG_DATA_URL)).toBe('upload');
    expect(pastedImageNeed('cid:image001.png@01DB')).toBe('from_clipboard');
    expect(pastedImageNeed('file:///C:/x.png')).toBe('from_clipboard');
    expect(pastedImageNeed('data:image/svg+xml;base64,AAAA')).toBe('from_clipboard');
  });

  it('gives each picture its new link, and drops one with none', () => {
    const html = `<img src="cid:a"><img alt="x" src='file:///b'><img src=https://x.example/c.png>`;
    expect(listImageSources(html)).toEqual(['cid:a', 'file:///b', 'https://x.example/c.png']);
    const out = replaceImageSources(html, (src, i) => (i === 1 ? null : `https://chordapp.ai/p/${i}?a=1&b=2`));
    expect(out).toBe(
      '<img src="https://chordapp.ai/p/0?a=1&amp;b=2"><img src="https://chordapp.ai/p/2?a=1&amp;b=2">',
    );
  });

  it('plain text becomes escaped HTML with its line breaks', () => {
    expect(plainTextToSignatureHtml('John <r@x.com>\nChord')).toBe('John &lt;r@x.com&gt;<br>Chord');
  });

  it('knows a picture by its bytes, not its name', () => {
    expect(sniffImageType(Buffer.from(PNG_B64, 'base64'))).toBe('image/png');
    expect(sniffImageType(Buffer.from('<svg/>'))).toBeNull();
  });
});
