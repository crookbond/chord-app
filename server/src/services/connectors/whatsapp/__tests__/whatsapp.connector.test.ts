/**
 * WhatsAppConnector unit tests — Twilio signature validation and the
 * form-urlencoded → InboundMessage mapping (ADR 0053). No network: `send`
 * isn't exercised here (it's a thin fetch wrapper covered by the api).
 */
import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { WhatsAppConnector } from '@/services/connectors/whatsapp/whatsapp.connector.js';

const ACCOUNT_SID = 'AC_test';
const AUTH_TOKEN = 'tok_secret';
const FROM = 'whatsapp:+14155238886';
const BASE = 'https://example.test';
const PATH = '/api/v1/webhooks/whatsapp';

function twilioSignature(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
}

function makeReq(body: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    body,
    originalUrl: PATH,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as import('express').Request;
}

function makeConnector(opts: { validateSignature?: boolean } = {}): WhatsAppConnector {
  return new WhatsAppConnector({
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    from: FROM,
    publicBaseUrl: BASE,
    validateSignature: opts.validateSignature ?? true,
  });
}

const SAMPLE_BODY = {
  From: 'whatsapp:+15551234567',
  To: FROM,
  Body: 'add milk to the list',
  ProfileName: 'Alex',
  WaId: '15551234567',
  MessageSid: 'SM123',
  NumMedia: '0',
};

describe('WhatsAppConnector.verifySignature', () => {
  it('accepts a correctly-signed request', () => {
    const sig = twilioSignature(`${BASE}${PATH}`, SAMPLE_BODY);
    const req = makeReq(SAMPLE_BODY, { 'x-twilio-signature': sig });
    expect(makeConnector().verifySignature(req)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = twilioSignature(`${BASE}${PATH}`, SAMPLE_BODY);
    const req = makeReq({ ...SAMPLE_BODY, Body: 'tampered' }, { 'x-twilio-signature': sig });
    expect(makeConnector().verifySignature(req)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(makeConnector().verifySignature(makeReq(SAMPLE_BODY))).toBe(false);
  });

  it('skips validation when disabled (dev escape hatch)', () => {
    expect(makeConnector({ validateSignature: false }).verifySignature(makeReq(SAMPLE_BODY))).toBe(true);
  });
});

describe('WhatsAppConnector.parseInbound', () => {
  it('maps a text message to a private, bot-addressed InboundMessage', async () => {
    const msg = await makeConnector().parseInbound(makeReq(SAMPLE_BODY));
    expect(msg).toMatchObject({
      platform: 'whatsapp',
      externalChannelId: 'whatsapp:+15551234567',
      externalUserId: 'whatsapp:+15551234567',
      externalUserDisplay: 'Alex',
      externalMessageId: 'SM123',
      text: 'add milk to the list',
      mentionsBot: true,
      mentionsOthers: false,
      isPrivate: true,
    });
  });

  it('drops media-only messages (inbound media not yet supported)', async () => {
    const req = makeReq({ ...SAMPLE_BODY, Body: '', NumMedia: '1' });
    expect(await makeConnector().parseInbound(req)).toBeNull();
  });

  it('returns null when From or MessageSid is missing', async () => {
    expect(await makeConnector().parseInbound(makeReq({ Body: 'hi' }))).toBeNull();
  });

  it('maps a quick-reply button tap to buttonPayload (ADR 0053 §7)', async () => {
    const req = makeReq({
      ...SAMPLE_BODY,
      Body: '',
      ButtonText: 'Yes',
      ButtonPayload: 'p+:prop_42',
    });
    const msg = await makeConnector().parseInbound(req);
    expect(msg).toMatchObject({
      platform: 'whatsapp',
      buttonPayload: 'p+:prop_42',
      text: 'Yes', // the visible label, for logging
      mentionsBot: true,
    });
  });
});

/**
 * ADR 0140 — Twilio still cannot send media (it pulls from a public URL, which
 * would mean hosting a family document unauthenticated). What changed is that
 * the recipient is told, rather than being handed the bare filename.
 */
describe('WhatsAppConnector outbound attachment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureForm(): { body: () => URLSearchParams } {
    let seen = new URLSearchParams();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: URLSearchParams | string }) => {
        seen = typeof init.body === 'string' ? new URLSearchParams(init.body) : init.body;
        return { ok: true, status: 201, json: async () => ({ sid: 'SM999' }) };
      }),
    );
    return { body: () => seen };
  }

  it('sends a pointer, not the bare filename', async () => {
    const cap = captureForm();
    await makeConnector().send({
      externalChannelId: 'whatsapp:+15551234567',
      // What `send_file` posts when the bot supplied no note.
      body: 'calendar.pdf',
      cards: [],
      attachment: { path: '/nope/calendar.pdf', filename: 'calendar.pdf', mimeType: 'application/pdf' },
      moreUrl: 'https://chordapp.ai/g/abc',
    });
    const body = cap.body().get('Body') ?? '';
    expect(body).toContain("couldn't attach");
    expect(body).toContain('calendar.pdf');
    expect(body).toContain('https://chordapp.ai/g/abc');
    // The old behaviour was exactly the filename and nothing else.
    expect(body).not.toBe('calendar.pdf');
  });
});
