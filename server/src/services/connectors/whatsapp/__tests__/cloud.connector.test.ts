/**
 * WhatsApp Cloud API connector (ADR 0090).
 *
 * Focus is the webhook contract, because that is where Meta differs from
 * Twilio on every axis and where a mistake is silent: a bad signature check
 * accepts forged traffic, a missed batch drops user messages, and a JSON
 * challenge response fails subscription verification with no error anywhere.
 */
import crypto from 'node:crypto';

import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyMetaSignature } from '../cloud.api';
import {
  WhatsAppCloudConnector,
  toChannelId,
  toWaId,
} from '../cloud.connector';

const APP_SECRET = 'app-secret-123';
const VERIFY_TOKEN = 'verify-me';

function connector(): WhatsAppCloudConnector {
  return new WhatsAppCloudConnector({
    token: 'tok',
    phoneNumberId: '111222333',
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    graphVersion: 'v21.0',
    nudgeTemplateName: 'morning_nudge',
    nudgeTemplateLanguage: 'en_US',
  });
}

function req(init: {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}): Request {
  const headers = init.headers ?? {};
  const raw = init.body === undefined ? '' : JSON.stringify(init.body);
  return {
    method: init.method ?? 'POST',
    body: init.body,
    query: init.query ?? {},
    rawBody: raw,
    header: (n: string) => headers[n.toLowerCase()],
  } as unknown as Request;
}

function signed(body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  const sig =
    'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  return req({ body, headers: { 'x-hub-signature-256': sig } });
}

function textMessage(from: string, body: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Sam' }, wa_id: from }],
              messages: [
                { from, id: `wamid.${body}`, timestamp: '1755000000', type: 'text', text: { body } },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** A notification carrying one media message of `type` (ADR 0140). */
function mediaNotification(
  type: 'image' | 'document' | 'audio' | 'video' | 'sticker',
  media: { id: string; caption?: string; filename?: string; mime_type?: string },
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Sam' }, wa_id: '13475550100' }],
              messages: [
                {
                  from: '13475550100',
                  id: 'wamid.media',
                  timestamp: '1755000000',
                  type,
                  [type]: media,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('channel id normalisation', () => {
  it('round-trips Meta wa_id to the persisted Twilio shape', () => {
    expect(toChannelId('13475550100')).toBe('whatsapp:+13475550100');
    expect(toWaId('whatsapp:+13475550100')).toBe('13475550100');
  });

  it('normalises an already-prefixed id idempotently', () => {
    expect(toChannelId('+1 (347) 555-0100')).toBe('whatsapp:+13475550100');
  });
});

describe('webhook subscription handshake', () => {
  it('echoes the challenge as plain text, not JSON', () => {
    const out = connector().handleVerificationChallenge(
      req({
        method: 'GET',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1158201444',
        },
      }),
    );
    expect(out).toEqual({ status: 200, text: '1158201444' });
    // JSON would send `"1158201444"` with quotes and fail verification.
    expect(out?.body).toBeUndefined();
  });

  it('rejects a wrong verify token', () => {
    const out = connector().handleVerificationChallenge(
      req({
        method: 'GET',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong',
          'hub.challenge': 'x',
        },
      }),
    );
    expect(out?.status).toBe(403);
  });

  it('ignores a GET that is not a subscribe', () => {
    expect(
      connector().handleVerificationChallenge(req({ method: 'GET', query: {} })),
    ).toBeNull();
  });
});

describe('signature verification', () => {
  it('accepts a correctly signed body', () => {
    expect(connector().verifySignature(signed(textMessage('13475550100', 'hi')))).toBe(true);
  });

  it('rejects a body signed with the wrong secret', () => {
    expect(
      connector().verifySignature(signed(textMessage('13475550100', 'hi'), 'not-it')),
    ).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(connector().verifySignature(req({ body: textMessage('1', 'hi') }))).toBe(false);
  });

  it('rejects a tampered body under a valid-looking signature', () => {
    const good = signed(textMessage('13475550100', 'hi'));
    const tampered = req({
      body: textMessage('13475550100', 'hi'),
      headers: { 'x-hub-signature-256': good.header('x-hub-signature-256')! },
    });
    (tampered as unknown as { rawBody: string }).rawBody = JSON.stringify(
      textMessage('13475550100', 'TAMPERED'),
    );
    expect(connector().verifySignature(tampered)).toBe(false);
  });

  it('does not blow up on a length-mismatched signature', () => {
    expect(
      verifyMetaSignature({
        appSecret: APP_SECRET,
        signatureHeader: 'sha256=short',
        rawBody: '{}',
      }),
    ).toBe(false);
  });
});

describe('inbound parsing', () => {
  it('parses a text message and normalises the channel id', async () => {
    const [m] = await connector().parseInboundBatch(
      req({ body: textMessage('13475550100', 'hello there') }),
    );
    expect(m.externalChannelId).toBe('whatsapp:+13475550100');
    expect(m.externalUserId).toBe('whatsapp:+13475550100');
    expect(m.text).toBe('hello there');
    expect(m.externalUserDisplay).toBe('Sam');
    expect(m.isPrivate).toBe(true);
    expect(m.mentionsBot).toBe(true);
    expect(m.ts.toISOString()).toBe(new Date(1755000000 * 1000).toISOString());
  });

  it('keeps every message in a batched notification', async () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                contacts: [{ profile: { name: 'Sam' }, wa_id: '13475550100' }],
                messages: [
                  { from: '13475550100', id: 'w1', timestamp: '1755000000', type: 'text', text: { body: 'one' } },
                  { from: '13475550100', id: 'w2', timestamp: '1755000001', type: 'text', text: { body: 'two' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const batch = await connector().parseInboundBatch(req({ body }));
    expect(batch.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('routes an in-session button tap to the callback path', async () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '13475550100',
                    id: 'w3',
                    timestamp: '1755000000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'p+:prop_1', title: 'Confirm' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const [m] = await connector().parseInboundBatch(req({ body }));
    expect(m.buttonPayload).toBe('p+:prop_1');
    expect(m.text).toBe('Confirm');
  });

  it('routes a TEMPLATE button tap too — a different payload shape', async () => {
    // ADR 0089's nudge comes back as type 'button', not 'interactive'.
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '13475550100',
                    id: 'w4',
                    timestamp: '1755000000',
                    type: 'button',
                    button: { payload: 'n+:briefing', text: 'Yes, send it' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const [m] = await connector().parseInboundBatch(req({ body }));
    expect(m.buttonPayload).toBe('n+:briefing');
  });

  it('ignores delivery receipts instead of posting them as messages', async () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [{ id: 'wamid.x', status: 'delivered', recipient_id: '13475550100' }],
              },
            },
          ],
        },
      ],
    };
    expect(await connector().parseInboundBatch(req({ body }))).toEqual([]);
  });

  it('ignores a payload that is not a WABA notification', async () => {
    expect(
      await connector().parseInboundBatch(req({ body: { object: 'page', entry: [] } })),
    ).toEqual([]);
  });

  it('drops an unsupported message type rather than posting it empty', async () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  { from: '13475550100', id: 'w5', timestamp: '1755000000', type: 'sticker' },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(await connector().parseInboundBatch(req({ body }))).toEqual([]);
  });

  it('parseInbound returns the first of a batch, for interface compatibility', async () => {
    const m = await connector().parseInbound(req({ body: textMessage('13475550100', 'solo') }));
    expect(m?.text).toBe('solo');
  });
});

describe('nudge template ref follows the active provider (ADR 0090)', () => {
  it('reads the Meta template name under cloud, the Twilio SID under twilio', async () => {
    const { env } = await import('@/config/env.js');
    const { nudgeTemplateRef } = await import(
      '@/services/connectors/outbound-publisher.js'
    );
    const mut = env as unknown as {
      WHATSAPP_PROVIDER: string;
      META_NUDGE_TEMPLATE_NAME: string;
      TWILIO_NUDGE_TEMPLATE_SID: string;
    };
    const saved = {
      p: mut.WHATSAPP_PROVIDER,
      m: mut.META_NUDGE_TEMPLATE_NAME,
      t: mut.TWILIO_NUDGE_TEMPLATE_SID,
    };
    try {
      mut.META_NUDGE_TEMPLATE_NAME = 'morning_nudge_v2';
      mut.TWILIO_NUDGE_TEMPLATE_SID = 'HXdeadbeef';

      mut.WHATSAPP_PROVIDER = 'cloud';
      expect(nudgeTemplateRef()).toBe('morning_nudge_v2');

      mut.WHATSAPP_PROVIDER = 'twilio';
      expect(nudgeTemplateRef()).toBe('HXdeadbeef');

      // The regression: a configured Meta template must not read as absent
      // just because the Twilio SID is empty.
      mut.WHATSAPP_PROVIDER = 'cloud';
      mut.TWILIO_NUDGE_TEMPLATE_SID = '';
      expect(!!nudgeTemplateRef()).toBe(true);
    } finally {
      mut.WHATSAPP_PROVIDER = saved.p;
      mut.META_NUDGE_TEMPLATE_NAME = saved.m;
      mut.TWILIO_NUDGE_TEMPLATE_SID = saved.t;
    }
  });
});

/**
 * ADR 0091 — the out-of-window template carries the briefing, so the send has
 * to put five body parameters on the wire in order. Meta rejects an empty
 * parameter outright, and a rejected template is a briefing that silently
 * never arrives, so both are asserted at the transport boundary.
 */
/** Capture the Graph payload instead of sending it. */
function captureSend(): { payload: () => Record<string, any> } {
  let seen: Record<string, any> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      seen = JSON.parse(init.body) as Record<string, any>;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ messages: [{ id: 'wamid.1' }] }),
      };
    }),
  );
  return { payload: () => seen };
}

describe('briefing template body parameters (ADR 0091)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const FIVE = ['weather', 'this week', 'heads up', 'tasks', 'email'];

  it('sends all five slots, in order', async () => {
    const cap = captureSend();
    await connector().send({
      externalChannelId: 'whatsapp:+13475550100',
      body: 'fallback prompt',
      contentSid: 'morning_nudge',
      templateParams: FIVE,
      cards: [],
    });
    const body = cap.payload();
    expect(body.type).toBe('template');
    const params = body.template.components.find((c: any) => c.type === 'body').parameters;
    expect(params.map((p: any) => p.text)).toEqual(FIVE);
  });

  it('falls back to the single generic slot when no facts were built', async () => {
    const cap = captureSend();
    await connector().send({
      externalChannelId: 'whatsapp:+13475550100',
      body: 'Good morning! Want your daily briefing?',
      contentSid: 'morning_nudge',
      cards: [],
    });
    const params = cap
      .payload()
      .template.components.find((c: any) => c.type === 'body').parameters;
    expect(params).toHaveLength(1);
    expect(params[0].text).toContain('daily briefing');
  });

  it('carries the button payloads alongside the body slots', async () => {
    const cap = captureSend();
    await connector().send({
      externalChannelId: 'whatsapp:+13475550100',
      body: 'prompt',
      contentSid: 'morning_nudge',
      templateParams: FIVE,
      cards: [
        {
          kind: 'action',
          title: 'prompt',
          buttons: [
            { label: 'Full briefing', callback: { verb: 'n+', id: 'briefing' } },
            { label: 'Stop these', callback: { verb: 'n-', id: 'briefing' } },
          ],
        },
      ],
    });
    const buttons = cap
      .payload()
      .template.components.filter((c: any) => c.type === 'button');
    expect(buttons.map((b: any) => b.parameters[0].payload)).toEqual([
      'n+:briefing',
      'n-:briefing',
    ]);
  });

  it('an ordinary in-window message is still plain text, not a template', async () => {
    const cap = captureSend();
    await connector().send({
      externalChannelId: 'whatsapp:+13475550100',
      body: 'hello',
      cards: [],
    });
    expect(cap.payload().type).toBe('text');
  });
});

/**
 * ADR 0140 — media, in both directions, and the honest failure.
 *
 * The wire shapes are Meta's and a wrong field name is a runtime 400, so these
 * pin the payloads. The failure cases matter more than the happy ones: the
 * behaviour being replaced sent a bare filename that read as a delivered file.
 */
describe('media (ADR 0140)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Capture every Graph call, so an upload + a send can both be inspected. */
  function captureAll(uploadId = 'media-1'): { calls: () => { url: string; body: any }[] } {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: unknown }) => {
        const isUpload = String(url).endsWith('/media');
        calls.push({
          url: String(url),
          body: isUpload ? init.body : JSON.parse(String(init.body)),
        });
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              isUpload ? { id: uploadId } : { messages: [{ id: 'wamid.media' }] },
            ),
        };
      }),
    );
    return { calls: () => calls };
  }

  async function withTempFile<T>(
    name: string,
    bytes: Buffer,
    fn: (path: string) => Promise<T>,
  ): Promise<T> {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chord-wa-'));
    const p = path.join(dir, name);
    await fs.writeFile(p, bytes);
    try {
      return await fn(p);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('uploads the bytes then sends a document by media id', async () => {
    const cap = captureAll();
    await withTempFile('calendar.pdf', Buffer.from('%PDF-1.4 hello'), (p) =>
      connector().send({
        externalChannelId: 'whatsapp:+13475550100',
        body: 'Here is the school calendar',
        cards: [],
        attachment: { path: p, filename: 'calendar.pdf', mimeType: 'application/pdf' },
      }),
    );
    const [upload, send] = cap.calls();
    expect(upload.url).toContain('/media');
    expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get('messaging_product')).toBe('whatsapp');
    expect(send.body.type).toBe('document');
    expect(send.body.document).toEqual({
      id: 'media-1',
      caption: 'Here is the school calendar',
      filename: 'calendar.pdf',
    });
  });

  it('an image rides as image, and carries no filename field', async () => {
    const cap = captureAll();
    await withTempFile('slip.jpg', Buffer.from('jpegbytes'), (p) =>
      connector().send({
        externalChannelId: 'whatsapp:+13475550100',
        body: 'photo',
        cards: [],
        attachment: { path: p, filename: 'slip.jpg', mimeType: 'image/jpeg' },
      }),
    );
    const send = cap.calls()[1];
    expect(send.body.type).toBe('image');
    expect(send.body.image.filename).toBeUndefined();
  });

  it('drops a caption that is only the filename echoed back', async () => {
    const cap = captureAll();
    // `send_file` posts the filename as the body when the bot gave no note.
    await withTempFile('calendar.pdf', Buffer.from('x'), (p) =>
      connector().send({
        externalChannelId: 'whatsapp:+13475550100',
        body: 'calendar.pdf',
        cards: [],
        attachment: { path: p, filename: 'calendar.pdf', mimeType: 'application/pdf' },
      }),
    );
    expect(cap.calls()[1].body.document.caption).toBeUndefined();
  });

  it('an oversize file sends a pointer, never a bare filename', async () => {
    const cap = captureAll();
    const big = Buffer.alloc(6 * 1024 * 1024, 1); // over Meta's 5MB image cap
    await withTempFile('huge.jpg', big, (p) =>
      connector().send({
        externalChannelId: 'whatsapp:+13475550100',
        body: 'huge.jpg',
        cards: [],
        attachment: { path: p, filename: 'huge.jpg', mimeType: 'image/jpeg' },
        moreUrl: 'https://chordapp.ai/g/abc',
      }),
    );
    const only = cap.calls()[0];
    expect(only.body.type).toBe('text');
    expect(only.body.text.body).toContain("couldn't attach");
    expect(only.body.text.body).toContain('huge.jpg');
    expect(only.body.text.body).toContain('https://chordapp.ai/g/abc');
    // Never uploaded — the cap is checked before spending the round trip.
    expect(cap.calls().some((c) => c.url.endsWith('/media'))).toBe(false);
  });

  it('downloads inbound media into an attachment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/media-77')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://lookaside.fb/x', mime_type: 'image/jpeg' }),
          };
        }
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('JPEGDATA') };
      }),
    );
    const msg = await connector().parseInbound(
      signed(mediaNotification('image', { id: 'media-77', caption: 'permission slip' })),
    );
    expect(msg?.text).toBe('permission slip');
    expect(msg?.attachment?.mimeType).toBe('image/jpeg');
    expect(msg?.attachment?.bytes.toString()).toBe('JPEGDATA');
    // WhatsApp gives a photo no filename; one is derived from the mime type.
    expect(msg?.attachment?.filename).toMatch(/\.jpe?g$/);
  });

  it('a failed media download keeps the caption instead of claiming a file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const msg = await connector().parseInbound(
      signed(mediaNotification('image', { id: 'media-77', caption: 'look at this' })),
    );
    expect(msg?.text).toBe('look at this');
    expect(msg?.attachment).toBeUndefined();
  });

  it('a caption-less photo is still a message, not a drop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/media-77')
          ? { ok: true, status: 200, json: async () => ({ url: 'https://x/y', mime_type: 'image/png' }) }
          : { ok: true, status: 200, arrayBuffer: async () => Buffer.from('PNG') },
      ),
    );
    const msg = await connector().parseInbound(
      signed(mediaNotification('image', { id: 'media-77' })),
    );
    expect(msg).not.toBeNull();
    expect(msg?.attachment?.bytes.toString()).toBe('PNG');
  });
});

/**
 * ADR 0139 — the CTA URL button.
 *
 * These pin the wire shape rather than the renderer's decision (that is
 * covered in `renderers/__tests__/whatsapp.renderer.test.ts`), because the
 * field names are Meta's and a typo in one of them is a runtime 400 that no
 * type checks.
 */
describe('cta_url button (ADR 0139)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const linkCard = {
    kind: 'action' as const,
    title: 'Track UA 512',
    url: 'https://www.flightaware.com/live/flight/UAL512',
  };

  it('sends interactive/cta_url with Meta\'s exact parameter names', async () => {
    const cap = captureSend();
    await connector().send({
      externalChannelId: 'whatsapp:+13475550100',
      body: 'Your flight UA 512 departs Fri 6:40am.',
      cards: [linkCard],
    });
    const body = cap.payload();
    expect(body.type).toBe('interactive');
    expect(body.interactive.type).toBe('cta_url');
    expect(body.interactive.action.name).toBe('cta_url');
    expect(body.interactive.action.parameters).toEqual({
      display_text: 'Track UA 512',
      url: 'https://www.flightaware.com/live/flight/UAL512',
    });
    expect(body.interactive.body.text).toBe('Your flight UA 512 departs Fri 6:40am.');
  });

  it('a second link falls back to text carrying both URLs', async () => {
    const cap = captureSend();
    await connector().send({
      externalChannelId: 'whatsapp:+13475550100',
      body: 'Two:',
      cards: [linkCard, { kind: 'action', title: 'Maps', url: 'https://maps.google.com/?q=SFO' }],
    });
    const body = cap.payload();
    expect(body.type).toBe('text');
    expect(body.text.body).toContain('UAL512');
    expect(body.text.body).toContain('maps.google.com');
  });

  it('the out-of-window template path is unaffected by a link card', async () => {
    const cap = captureSend();
    await connector().send({
      externalChannelId: 'whatsapp:+13475550100',
      body: 'nudge',
      contentSid: 'morning_nudge',
      cards: [linkCard],
    });
    expect(cap.payload().type).toBe('template');
  });
});
