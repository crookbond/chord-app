/**
 * WhatsApp connector via Twilio (ADR 0053).
 *
 * Inbound: Twilio POSTs `application/x-www-form-urlencoded` to
 * `/api/v1/webhooks/whatsapp`. We validate `X-Twilio-Signature` against
 * the public URL + form params, then normalise to an `InboundMessage`.
 * WhatsApp is strictly 1×1, so every inbound is a private DM that
 * addresses the bot; the thread binds to the user's personal group only
 * (ADR 0053 §7 — no cross-group targeting).
 *
 * Outbound: Twilio Messages REST API. Free-form text only for now; the
 * 24h-window/template gating and interactive buttons are fast-follows
 * (ADR 0053 §4-5).
 *
 * Media (inbound `MediaUrlN`, outbound public-URL) is a documented
 * follow-up; this first cut is text-only.
 */
import type { Request } from 'express';

import { logger } from '../../../config/logging';
import type {
  Connector,
  ConnectorPlatform,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types';
import { renderFor } from '../renderers';
import { undeliverableFileText } from './file-fallback';
import { sendContent, sendMessage, validateTwilioSignature } from './whatsapp.api';

export interface WhatsAppConnectorOptions {
  accountSid: string;
  authToken: string;
  /** `whatsapp:+1555…` — the Chord sender (sandbox or production). */
  from: string;
  /**
   * Public base URL Twilio calls, e.g. `https://abc.ngrok.io`. The
   * signature is computed over the exact URL, so this must match what
   * Twilio is configured with (no trailing slash).
   */
  publicBaseUrl: string;
  /** Dev escape hatch: skip signature validation (tunnels rewrite the
   *  URL, breaking the HMAC). Never disable in production. */
  validateSignature?: boolean;
  /**
   * Content API `twilio/quick-reply` template SIDs keyed by button count
   * (ADR 0053 §7). When a reply has ≤3 callback action buttons and a SID
   * exists for that count, it sends as quick-reply; otherwise it degrades
   * to plain text. Empty → always plain text.
   */
  quickReplySids?: Record<number, string>;
}

export class WhatsAppConnector implements Connector {
  readonly platform: ConnectorPlatform = 'whatsapp';

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string;
  private readonly publicBaseUrl: string;
  private readonly shouldValidate: boolean;
  private readonly quickReplySids: Record<number, string>;

  constructor(opts: WhatsAppConnectorOptions) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.from = opts.from;
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, '');
    this.shouldValidate = opts.validateSignature ?? true;
    this.quickReplySids = opts.quickReplySids ?? {};
  }

  async initialize(): Promise<void> {
    logger.info('whatsapp connector ready', {
      from: this.from,
      validateSignature: this.shouldValidate,
    });
  }

  async shutdown(): Promise<void> {}

  verifySignature(req: Request): boolean {
    if (!this.shouldValidate) {
      logger.warn('whatsapp: signature validation disabled (dev only)');
      return true;
    }
    const signature = req.header('x-twilio-signature');
    if (!signature) {
      logger.warn('whatsapp: missing X-Twilio-Signature header');
      return false;
    }
    // Twilio signs the exact URL it called. originalUrl includes the
    // mount path + any query string.
    const url = `${this.publicBaseUrl}${req.originalUrl}`;
    const params = toStringParams(req.body);
    return validateTwilioSignature({
      authToken: this.authToken,
      signature,
      url,
      params,
    });
  }

  async parseInbound(req: Request): Promise<InboundMessage | null> {
    const body = toStringParams(req.body);
    const from = body.From;
    const messageId = body.MessageSid ?? body.SmsMessageSid;
    if (!from || !messageId) return null;

    // Quick-reply button tap (ADR 0053 §7): Twilio echoes the button's id as
    // `ButtonPayload` (our `verb:id`) and its label as `ButtonText`. Route it
    // to the callback handler, not the LLM.
    const buttonPayload = body.ButtonPayload?.trim() || undefined;
    const text = buttonPayload ? (body.ButtonText ?? '') : (body.Body ?? '');
    const numMedia = Number.parseInt(body.NumMedia ?? '0', 10);
    if (!buttonPayload && !text && numMedia > 0) {
      // Inbound media support is a documented follow-up (ADR 0053). Drop
      // a caption-less media message rather than posting an empty one.
      logger.info('whatsapp: inbound media not yet supported — dropping', {
        numMedia,
      });
      return null;
    }
    if (!buttonPayload && !text) return null;

    return {
      platform: 'whatsapp',
      // 1×1: the conversation channel IS the user's DM. Personal-binding
      // (ADR 0053 §7) keys on this stable per-user id.
      externalChannelId: from,
      externalChannelDisplay: body.ProfileName ?? null,
      externalUserId: from,
      externalUserDisplay: body.ProfileName ?? null,
      externalMessageId: messageId,
      text,
      buttonPayload,
      ts: new Date(),
      mentionsBot: true,
      mentionsOthers: false,
      isPrivate: true,
      raw: body,
    };
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const rendered = renderFor('whatsapp', {
      body: msg.body,
      cards: msg.cards,
      senderName: msg.senderName,
      moreUrl: msg.moreUrl,
    });
    const creds = { accountSid: this.accountSid, authToken: this.authToken };

    // ADR 0140 — Twilio pulls media from a public URL, so sending a family
    // document would mean hosting it unauthenticated. That stays deferred; what
    // does not is telling the recipient. Sending `body` here meant sending the
    // bare filename, which reads as a delivered file.
    if (msg.attachment && !msg.contentSid) {
      logger.warn('whatsapp: outbound attachment not supported on twilio — sending a pointer', {
        filename: msg.attachment.filename,
      });
      const result = await sendMessage(creds, {
        to: msg.externalChannelId,
        from: this.from,
        body: undeliverableFileText(msg.attachment.filename, msg.moreUrl),
      });
      return { externalMessageId: result.sid };
    }

    // Quick-reply buttons (ADR 0053 §7) when the renderer produced them AND a
    // Content template SID is configured for that button count; otherwise the
    // buttons gracefully degrade to the plain-text fallback.
    const qr = rendered.whatsapp?.quickReply;
    // ADR 0089 — an explicit SID wins: the out-of-window nudge must ride its
    // approved template, not the in-session quick-reply one for that count.
    const sid = msg.contentSid ?? (qr ? this.quickReplySids[qr.buttons.length] : undefined);
    if (qr && sid) {
      const vars: Record<string, string> = { '1': qr.body };
      qr.buttons.forEach((b, i) => {
        vars[String(2 + i * 2)] = b.id; // button payload (verb:id)
        vars[String(3 + i * 2)] = b.title; // button label
      });
      const result = await sendContent(creds, {
        to: msg.externalChannelId,
        from: this.from,
        contentSid: sid,
        contentVariables: vars,
      });
      return { externalMessageId: result.sid };
    }

    const result = await sendMessage(creds, {
      to: msg.externalChannelId,
      from: this.from,
      body: rendered.text,
    });
    return { externalMessageId: result.sid };
  }
}

/** Coerce a parsed urlencoded body into a flat string map for hashing
 *  and field access. Twilio form fields are always scalar strings. */
function toStringParams(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
