/**
 * Pure Gmail helper logic (ADR 0060) — no DB, no Google.
 */
import { describe, expect, it } from 'vitest';

import {
  aggregateThread,
  applyLabelDelta,
  b64urlDecode,
  b64urlEncode,
  buildReplyRaw,
  diffHistory,
  extractBodies,
  listAttachmentParts,
  normalizeMessage,
  parseAddress,
  parseAddressList,
  replySubject,
  textToHtml,
  type GmailRawMessage,
  type ThreadMessageView,
} from '../gmail-sync.js';

describe('base64url', () => {
  it('round-trips utf8 with url-safe alphabet and no padding', () => {
    const s = 'Héllo, wörld! <a@b.com> — ok?';
    const enc = b64urlEncode(s);
    expect(enc).not.toMatch(/[+/=]/);
    expect(b64urlDecode(enc)).toBe(s);
  });
});

describe('parseAddress', () => {
  it('splits "Name <addr>" and lowercases the email', () => {
    expect(parseAddress('Chase <No-Reply@Chase.com>')).toEqual({
      name: 'Chase',
      email: 'no-reply@chase.com',
    });
  });
  it('handles a bare address', () => {
    expect(parseAddress('foo@BAR.com')).toEqual({ name: null, email: 'foo@bar.com' });
  });
  it('strips quotes around a display name', () => {
    expect(parseAddress('"Doe, John" <j@x.com>')).toEqual({ name: 'Doe, John', email: 'j@x.com' });
  });
  it('parses a comma-separated list', () => {
    expect(parseAddressList('a@x.com, B <b@y.com>')).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('extractBodies', () => {
  it('pulls text/plain and text/html from a multipart tree', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from('<b>hi</b>').toString('base64url') } },
      ],
    };
    expect(extractBodies(payload)).toEqual({ text: 'hi', html: '<b>hi</b>' });
  });
});

describe('normalizeMessage', () => {
  it('maps headers, labels, and internalDate to storage shape', () => {
    const raw: GmailRawMessage = {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      snippet: 'hello there',
      internalDate: '1700000000000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Grandma <grandma@example.com>' },
          { name: 'To', value: 'you@example.com' },
          { name: 'Subject', value: 'Sunday dinner?' },
          { name: 'Message-ID', value: '<fam1@example.com>' },
          { name: 'References', value: '<a@x> <b@y>' },
        ],
        body: { data: Buffer.from('come over').toString('base64url') },
      },
    };
    const nm = normalizeMessage(raw);
    expect(nm.fromEmail).toBe('grandma@example.com');
    expect(nm.subject).toBe('Sunday dinner?');
    expect(nm.isUnread).toBe(true);
    expect(nm.internalDate).toBe(new Date(1700000000000).toISOString());
    expect(nm.rfc822MessageId).toBe('<fam1@example.com>');
    expect(nm.headers.references).toBe('<a@x> <b@y>');
    expect(nm.bodyText).toBe('come over');
  });
});

describe('aggregateThread', () => {
  const view = (over: Partial<ThreadMessageView>): ThreadMessageView => ({
    internalDate: '2024-01-01T00:00:00.000Z',
    subject: 'S',
    snippet: 'snip',
    fromName: 'A',
    fromEmail: 'a@x.com',
    labelIds: ['INBOX'],
    isUnread: false,
    ...over,
  });

  it('unread if any message is unread; latest drives display', () => {
    const agg = aggregateThread([
      view({ internalDate: '2024-01-01T00:00:00.000Z', subject: 'First', isUnread: false }),
      view({
        internalDate: '2024-01-02T00:00:00.000Z',
        subject: 'Second',
        snippet: 'newest',
        fromEmail: 'z@x.com',
        isUnread: true,
      }),
    ]);
    expect(agg.isUnread).toBe(true);
    expect(agg.messageCount).toBe(2);
    expect(agg.snippet).toBe('newest');
    expect(agg.fromEmail).toBe('z@x.com');
    expect(agg.subject).toBe('First'); // earliest non-empty subject = thread subject
    expect(agg.isArchived).toBe(false);
  });

  it('archived when no message carries INBOX', () => {
    const agg = aggregateThread([view({ labelIds: ['SENT'] })]);
    expect(agg.isArchived).toBe(true);
  });

  // Prod 2026-09-30, thread 1a0f340550bd0333: the older job alert was trashed,
  // the newer one is still in the inbox. Gmail shows the thread; Chord's union
  // carried TRASH, so the inbox predicate hid it.
  it('a thread with a trashed message and a live inbox message stays in the inbox', () => {
    const agg = aggregateThread([
      view({
        internalDate: '2026-09-30T16:57:54Z',
        snippet: 'trashed alert',
        labelIds: ['UNREAD', 'TRASH', 'Label_46'],
        isUnread: true,
      }),
      view({
        internalDate: '2026-09-30T18:57:53Z',
        snippet: 'live alert',
        labelIds: ['UNREAD', 'INBOX'],
        isUnread: true,
      }),
    ]);
    expect(agg.labelIds).not.toContain('TRASH');
    expect(agg.isArchived).toBe(false);
    expect(agg.messageCount).toBe(1);
  });

  // Prod 2026-09-30, thread 1a0f2d276d5b07de: the NEWER message was trashed,
  // so the row showed the trashed message's snippet.
  it('the row shows the newest live message, not a newer trashed one', () => {
    const agg = aggregateThread([
      view({ internalDate: '2026-09-30T14:57:53Z', snippet: 'live', labelIds: ['UNREAD', 'INBOX', 'Label_46'] }),
      view({ internalDate: '2026-09-30T20:57:55Z', snippet: 'trashed', labelIds: ['UNREAD', 'TRASH'] }),
    ]);
    expect(agg.snippet).toBe('live');
    expect(agg.lastMessageAt).toBe('2026-09-30T14:57:53Z');
    expect(agg.labelIds).not.toContain('TRASH');
  });

  it('a thread trashed throughout still reads as trashed', () => {
    const agg = aggregateThread([
      view({ labelIds: ['TRASH'] }),
      view({ internalDate: '2024-01-02T00:00:00.000Z', labelIds: ['TRASH', 'UNREAD'] }),
    ]);
    expect(agg.labelIds).toContain('TRASH');
    expect(agg.isArchived).toBe(true);
    expect(agg.messageCount).toBe(2);
  });
});

describe('listAttachmentParts', () => {
  it('collects named attachment parts from a nested MIME tree, skipping inline bodies', () => {
    const parts = listAttachmentParts({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: 'aGk' } },
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/html', body: { data: 'aGk' } },
            {
              mimeType: 'application/pdf',
              filename: 'itinerary.pdf',
              body: { attachmentId: 'att1', size: 1234 },
            },
          ],
        },
        {
          mimeType: 'image/png',
          filename: 'photo.png',
          body: { attachmentId: 'att2', size: 99_000 },
        },
        // Named but no attachmentId (inline) — not fetchable, skipped.
        { mimeType: 'image/gif', filename: 'sig.gif', body: { data: 'aGk' } },
      ],
    });
    expect(parts).toEqual([
      { filename: 'itinerary.pdf', mimeType: 'application/pdf', attachmentId: 'att1', size: 1234 },
      { filename: 'photo.png', mimeType: 'image/png', attachmentId: 'att2', size: 99_000 },
    ]);
  });

  it('records the Content-ID of an inline image, including one with no filename', () => {
    const parts = listAttachmentParts({
      mimeType: 'multipart/related',
      parts: [
        { mimeType: 'text/html', body: { data: 'aGk' } },
        {
          mimeType: 'image/png',
          filename: 'image001.png',
          headers: [{ name: 'Content-ID', value: '<image001.png@01DC2B1A.5E3F>' }],
          body: { attachmentId: 'att-logo', size: 812 },
        },
        {
          mimeType: 'image/jpeg',
          headers: [{ name: 'content-id', value: '<ii_mfq9x2k00>' }],
          body: { attachmentId: 'att-photo', size: 40_000 },
        },
        // No filename and no Content-ID: nothing can ever reference it.
        { mimeType: 'image/gif', body: { attachmentId: 'att-orphan', size: 43 } },
      ],
    });
    expect(parts).toEqual([
      {
        filename: 'image001.png',
        mimeType: 'image/png',
        attachmentId: 'att-logo',
        size: 812,
        contentId: 'image001.png@01dc2b1a.5e3f',
      },
      {
        filename: 'ii_mfq9x2k00',
        mimeType: 'image/jpeg',
        attachmentId: 'att-photo',
        size: 40_000,
        contentId: 'ii_mfq9x2k00',
      },
    ]);
  });
});

describe('buildReplyRaw', () => {
  it('writes the subject VERBATIM, plus In-Reply-To and appended References', () => {
    // The builder serves compose as well as reply (ADR 0107), so it no longer
    // forces "Re: " — it used to, which sent composed mail out as "Re: <the
    // subject the user typed>". Prefixing is the reply caller's job now.
    const raw = buildReplyRaw({
      fromEmail: 'me@example.com',
      to: ['grandma@example.com'],
      toName: 'Grandma',
      subject: replySubject('Sunday dinner?'),
      inReplyTo: '<fam1@example.com>',
      references: '<a@x>',
      body: 'Yes! See you at 5.',
    });
    const decoded = b64urlDecode(raw);
    expect(decoded).toContain('To: Grandma <grandma@example.com>');
    expect(decoded).toContain('Subject: Re: Sunday dinner?');
    expect(decoded).toContain('In-Reply-To: <fam1@example.com>');
    expect(decoded).toContain('References: <a@x> <fam1@example.com>');
    expect(decoded).toContain('Content-Type: text/plain');
    expect(decoded).toContain('\r\n\r\nYes! See you at 5.');
    expect(decoded).not.toContain('Cc:');
    expect(decoded).not.toContain('multipart/alternative');
  });
  it('does not double the Re: prefix', () => {
    expect(replySubject('Re: hi')).toBe('Re: hi');
    expect(replySubject('hi')).toBe('Re: hi');
  });
  it('leaves a composed subject alone', () => {
    const raw = buildReplyRaw({
      fromEmail: 'me@example.com',
      to: ['neighbour@example.com'],
      subject: 'Borrowing the ladder',
      inReplyTo: null,
      references: null,
      body: 'Saturday?',
    });
    const decoded = b64urlDecode(raw);
    expect(decoded).toContain('Subject: Borrowing the ladder');
    expect(decoded).not.toContain('Re:');
    // A new conversation carries no threading headers.
    expect(decoded).not.toContain('In-Reply-To:');
    expect(decoded).not.toContain('References:');
  });
  it('writes Cc/Bcc headers and a multipart/alternative body with htmlBody', () => {
    const raw = buildReplyRaw({
      fromEmail: 'me@example.com',
      to: ['a@x.com', 'b@x.com'],
      toName: 'Ignored For Multi', // name only applies to a single-recipient To
      cc: ['c@x.com', 'd@x.com'],
      bcc: ['e@x.com'],
      subject: 'Potluck',
      inReplyTo: null,
      references: null,
      body: 'Count us in.\nWe bring plates.',
      htmlBody: textToHtml('Count us in.\nWe bring plates.'),
    });
    const decoded = b64urlDecode(raw);
    expect(decoded).toContain('To: a@x.com, b@x.com');
    expect(decoded).toContain('Cc: c@x.com, d@x.com');
    expect(decoded).toContain('Bcc: e@x.com');
    expect(decoded).toContain('Content-Type: multipart/alternative; boundary=');
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decoded).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(decoded).toContain('Count us in.\nWe bring plates.');
    expect(decoded).toContain('<div>Count us in.<br>We bring plates.</div>');
  });
  it('textToHtml escapes markup and converts newlines', () => {
    expect(textToHtml('a<b & "c"\nd')).toBe('<div>a&lt;b &amp; &quot;c&quot;<br>d</div>');
  });
});

describe('diffHistory', () => {
  it('collapses added/deleted/label records and lists touched threads', () => {
    const diff = diffHistory([
      { messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
      { labelsRemoved: [{ message: { id: 'm2', threadId: 't2' }, labelIds: ['UNREAD'] }] },
      { messagesDeleted: [{ message: { id: 'm3', threadId: 't3' } }] },
    ]);
    expect(diff.addedMessageIds).toEqual(['m1']);
    expect(diff.deletedMessageIds).toEqual(['m3']);
    expect(diff.labelChanges).toEqual([{ messageId: 'm2', add: [], remove: ['UNREAD'] }]);
    expect(new Set(diff.touchedThreadIds)).toEqual(new Set(['t1', 't2', 't3']));
  });

  it('a later delete cancels an earlier add for the same message', () => {
    const diff = diffHistory([
      { messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
      { messagesDeleted: [{ message: { id: 'm1', threadId: 't1' } }] },
    ]);
    expect(diff.addedMessageIds).toEqual([]);
    expect(diff.deletedMessageIds).toEqual(['m1']);
  });
});

describe('applyLabelDelta', () => {
  it('adds and removes idempotently', () => {
    expect(applyLabelDelta(['INBOX', 'UNREAD'], ['STARRED'], ['UNREAD'])).toEqual([
      'INBOX',
      'STARRED',
    ]);
  });
});
