/**
 * WhatsApp via Meta's Cloud API (ADR 0090) — first-party, no BSP.
 *
 * A sibling of the Twilio connector, selected by `WHATSAPP_PROVIDER=cloud`.
 * Everything above this file (the ADR 0089 session-window gate, the `n+`/`n-`
 * verbs, the renderers, the length caps) is provider-agnostic and shared.
 *
 * Two things differ from Twilio in ways worth knowing:
 *
 *  - Channel ids are normalised to Twilio's `whatsapp:+E164` shape. Meta calls
 *    the user `13475550100`; that string is already persisted in
 *    `group_external_channels` and `external_identities` in Twilio's format, so
 *    normalising here keeps a user's binding, personal group and briefing
 *    intact across a provider switch (ADR 0090).
 *  - Quick-reply buttons need NO pre-approved template inside the 24h window.
 *    Only the out-of-window nudge does, and it is referenced by NAME.
 */
import type { Request } from 'express';
import mime from 'mime-types';

import { logger } from '../../../config/logging';
import { mapConcurrent } from '../../../utils/concurrency';
import { secretsEqual } from '../../../utils/secret-compare.js';
import { renderFor } from '../renderers';
import type {
  Connector,
  ConnectorPlatform,
  InboundMessage,
  OutboundMessage,
  SendResult,
  VerificationChallenge,
} from '../types';
import {
  CLOUD_MEDIA_LIMITS,
  type CloudButton,
  type CloudCreds,
  fetchMedia,
  pickCloudMediaKind,
  sendButtons,
  sendCtaUrl,
  sendMedia,
  sendTemplate,
  sendText,
  uploadMedia,
  verifyMetaSignature,
} from './cloud.api';
import { undeliverableFileText } from './file-fallback';
import { WHATSAPP_CLOUD_LIMIT } from '../renderers/truncate';
import { readBlob } from '../../../db/crypto/index.js';

/** Meta's cap on reply buttons in one interactive message. */
const MAX_BUTTONS = 3;
/** Meta's cap on a reply-button title. */
const BUTTON_TITLE_MAX = 20;

/**
 * Inbound message types that carry a file.
 *
 * A voice note is NOT its own type — it arrives as `audio` with `voice: true`
 * — so listing one here would match nothing.
 */
const MEDIA_TYPES = new Set(['image', 'document', 'audio', 'video', 'sticker']);

/**
 * A name for a file WhatsApp did not name.
 *
 * Only `document` carries a filename; a photo arrives with none at all, and
 * the extension has to come from the mime type or the stored file is opaque
 * to every reader downstream.
 */
function defaultMediaFilename(type: string, mimeType: string, mediaId: string): string {
  const ext = mime.extension(mimeType) || 'bin';
  return `whatsapp-${type}-${mediaId.slice(-8)}.${ext}`;
}

export interface CloudConnectorOptions {
  token: string;
  phoneNumberId: string;
  appSecret: string;
  /** Shared secret echoed back during the GET subscription handshake. */
  verifyToken: string;
  graphVersion: string;
  /** Approved template for the ADR 0089 out-of-window nudge. Empty = none. */
  nudgeTemplateName: string;
  nudgeTemplateLanguage: string;
}

/** `13475550100` → `whatsapp:+13475550100` (the persisted, Twilio-era shape). */
export function toChannelId(waId: string): string {
  const digits = waId.replace(/[^\d]/g, '');
  return `whatsapp:+${digits}`;
}

/** `whatsapp:+13475550100` → `13475550100` (what Graph wants as `to`). */
export function toWaId(channelId: string): string {
  return channelId.replace(/[^\d]/g, '');
}

interface CloudValue {
  messages?: Array<Record<string, unknown>>;
  statuses?: unknown[];
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
}

export class WhatsAppCloudConnector implements Connector {
  readonly platform: ConnectorPlatform = 'whatsapp';

  private readonly opts: CloudConnectorOptions;

  constructor(opts: CloudConnectorOptions) {
    this.opts = opts;
  }

  private get creds(): CloudCreds {
    return {
      token: this.opts.token,
      phoneNumberId: this.opts.phoneNumberId,
      graphVersion: this.opts.graphVersion,
    };
  }

  async initialize(): Promise<void> {
    logger.info('whatsapp cloud connector ready', {
      phoneNumberId: this.opts.phoneNumberId,
      graphVersion: this.opts.graphVersion,
      nudgeTemplate: this.opts.nudgeTemplateName || '(unset)',
    });
  }

  async shutdown(): Promise<void> {}

  /**
   * Meta verifies a webhook subscription with a GET carrying `hub.challenge`,
   * and expects the challenge echoed back as PLAIN TEXT. Returning JSON would
   * wrap it in quotes and fail verification, hence `text` rather than `body`.
   */
  handleVerificationChallenge(req: Request): VerificationChallenge | null {
    if (req.method !== 'GET') return null;
    const q = req.query as Record<string, unknown>;
    const mode = typeof q['hub.mode'] === 'string' ? q['hub.mode'] : '';
    const token = typeof q['hub.verify_token'] === 'string' ? q['hub.verify_token'] : '';
    const challenge = typeof q['hub.challenge'] === 'string' ? q['hub.challenge'] : '';
    if (mode !== 'subscribe') return null;
    if (!secretsEqual(token, this.opts.verifyToken)) {
      logger.warn('whatsapp cloud: webhook verify token mismatch');
      return { status: 403, text: 'forbidden' };
    }
    return { status: 200, text: challenge };
  }

  verifySignature(req: Request): boolean {
    // The GET handshake is authenticated by the verify token, not an HMAC,
    // and carries no body to sign.
    if (req.method === 'GET') return true;
    const header = req.header('x-hub-signature-256');
    return verifyMetaSignature({
      appSecret: this.opts.appSecret,
      signatureHeader: header,
      rawBody: (req as { rawBody?: string }).rawBody ?? '',
    });
  }

  /**
   * One notification can carry several messages. Returning only the first
   * would silently drop the rest, so the batch form is the real implementation
   * and `parseInbound` delegates to it (ADR 0090).
   */
  async parseInboundBatch(req: Request): Promise<InboundMessage[]> {
    const body = req.body as {
      object?: string;
      entry?: Array<{ changes?: Array<{ value?: CloudValue; field?: string }> }>;
    };
    if (body?.object !== 'whatsapp_business_account') return [];

    const out: InboundMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        // Delivery receipts ride the same webhook. Parsed as messages they
        // would post delivery noise into the user's chat.
        if (!value.messages?.length) continue;

        const profileName = value.contacts?.[0]?.profile?.name ?? null;
        // Each toInbound() may do a media-download HTTP fetch; the webhook
        // caller (routes/webhooks.ts) already acks before processing the
        // returned messages one by one in whatever order, so fetching
        // concurrently here only shortens time-to-ack on a multi-media batch.
        const parsed = await mapConcurrent(value.messages, 5, (raw) =>
          this.toInbound(raw, profileName),
        );
        for (const msg of parsed) {
          if (msg) out.push(msg);
        }
      }
    }
    return out;
  }

  async parseInbound(req: Request): Promise<InboundMessage | null> {
    const batch = await this.parseInboundBatch(req);
    return batch[0] ?? null;
  }

  private async toInbound(
    raw: Record<string, unknown>,
    profileName: string | null,
  ): Promise<InboundMessage | null> {
    const from = typeof raw.from === 'string' ? raw.from : '';
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!from || !id) return null;

    const type = typeof raw.type === 'string' ? raw.type : '';
    let text = '';
    let buttonPayload: string | undefined;
    let attachment: InboundMessage['attachment'];

    if (type === 'text') {
      text = (raw.text as { body?: string } | undefined)?.body ?? '';
    } else if (type === 'interactive') {
      // In-session reply buttons (proposal confirm/reject).
      const inter = raw.interactive as
        | { type?: string; button_reply?: { id?: string; title?: string } }
        | undefined;
      if (inter?.type === 'button_reply') {
        buttonPayload = inter.button_reply?.id?.trim() || undefined;
        text = inter.button_reply?.title ?? '';
      }
    } else if (type === 'button') {
      // A tap on an APPROVED TEMPLATE's quick-reply button — a different
      // shape from `interactive`, and the one ADR 0089's nudge comes back on.
      const btn = raw.button as { payload?: string; text?: string } | undefined;
      buttonPayload = btn?.payload?.trim() || undefined;
      text = btn?.text ?? '';
    } else if (MEDIA_TYPES.has(type)) {
      // ADR 0140 — a photographed permission slip is exactly the mail the
      // in-app pipeline exists for; dropping it here was silent data loss.
      const media = raw[type] as
        | { id?: string; caption?: string; filename?: string; mime_type?: string }
        | undefined;
      text = media?.caption ?? '';
      if (media?.id) {
        try {
          const dl = await fetchMedia(this.creds, media.id);
          const mimeType = media.mime_type || dl.mimeType;
          attachment = {
            filename: media.filename || defaultMediaFilename(type, mimeType, media.id),
            mimeType,
            bytes: dl.bytes,
          };
        } catch (err) {
          // A caption on its own is still worth posting; what we must not do
          // is claim a file arrived when the download failed.
          logger.warn('whatsapp cloud: inbound media download failed', { err, type });
        }
      }
    } else {
      logger.info('whatsapp cloud: unsupported inbound type — dropping', { type });
      return null;
    }

    if (!buttonPayload && !text && !attachment) return null;

    const channelId = toChannelId(from);
    const tsSeconds = Number.parseInt(String(raw.timestamp ?? ''), 10);
    return {
      platform: 'whatsapp',
      // 1×1: the conversation channel IS the user's DM (ADR 0053 §7).
      externalChannelId: channelId,
      externalChannelDisplay: profileName,
      externalUserId: channelId,
      externalUserDisplay: profileName,
      externalMessageId: id,
      text,
      buttonPayload,
      ts: Number.isFinite(tsSeconds) ? new Date(tsSeconds * 1000) : new Date(),
      mentionsBot: true,
      mentionsOthers: false,
      isPrivate: true,
      attachment,
      raw: raw as Record<string, unknown>,
    };
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const rendered = renderFor('whatsapp', {
      body: msg.body,
      cards: msg.cards,
      senderName: msg.senderName,
      moreUrl: msg.moreUrl,
      // ADR 0140 — Meta allows 4096; only Twilio is capped at 1600.
      textLimit: WHATSAPP_CLOUD_LIMIT,
    });
    const to = toWaId(msg.externalChannelId);

    // ADR 0140 — a file is really sent. Meta takes the bytes, so unlike Twilio
    // this needs no publicly-hosted copy of a family document. The template
    // path is excluded: an out-of-window send has to be the approved template.
    if (msg.attachment && !msg.contentSid) {
      try {
        return await this.sendAttachment(to, msg, rendered.text);
      } catch (err) {
        // The file did not go. Saying so is the point: the old behaviour sent
        // the bare filename as text, which reads as a delivered file (the
        // ADR 0107 failure) and left the recipient with no way to get it.
        logger.error('whatsapp cloud: attachment send failed', {
          err,
          filename: msg.attachment.filename,
        });
        const result = await sendText(this.creds, {
          to,
          body: undeliverableFileText(msg.attachment.filename, msg.moreUrl),
        });
        return { externalMessageId: result.id };
      }
    }
    const qr = rendered.whatsapp?.quickReply;
    const buttons: CloudButton[] =
      qr?.buttons.slice(0, MAX_BUTTONS).map((b) => ({
        id: b.id,
        title: b.title.slice(0, BUTTON_TITLE_MAX),
      })) ?? [];

    // ADR 0089 — `contentSid` marks the out-of-window nudge. On Meta a template
    // is named, not SID'd, so the flag selects the template send path.
    if (msg.contentSid) {
      if (!this.opts.nudgeTemplateName) {
        throw new Error('whatsapp cloud: nudge template name not configured');
      }
      const result = await sendTemplate(this.creds, {
        to,
        name: this.opts.nudgeTemplateName,
        languageCode: this.opts.nudgeTemplateLanguage,
        // ADR 0091 — the briefing template fills five slots; everything else
        // still rides a single one.
        bodyParams: msg.templateParams ?? [qr?.body ?? msg.body],
        buttons,
      });
      return { externalMessageId: result.id };
    }

    if (qr && buttons.length > 0) {
      const result = await sendButtons(this.creds, {
        to,
        body: qr.body,
        buttons,
      });
      return { externalMessageId: result.id };
    }

    // ADR 0139 — one link, no callbacks: a real button instead of a bare URL.
    const cta = rendered.whatsapp?.ctaUrl;
    if (cta) {
      const result = await sendCtaUrl(this.creds, {
        to,
        body: cta.body,
        displayText: cta.displayText,
        url: cta.url,
      });
      return { externalMessageId: result.id };
    }

    const result = await sendText(this.creds, { to, body: rendered.text });
    return { externalMessageId: result.id };
  }

  /**
   * Upload the file, then send it by media id.
   *
   * Throws rather than degrading, so the one caller owns the "we could not
   * send this" message and there is exactly one place that decides what the
   * recipient is told.
   */
  private async sendAttachment(
    to: string,
    msg: OutboundMessage,
    caption: string,
  ): Promise<SendResult> {
    const att = msg.attachment!;
    const kind = pickCloudMediaKind(att.mimeType);
    const bytes = await readBlob(att.path);

    // Refused, never truncated — ADR 0111's rule for outgoing mail, and a
    // half-sent file is worse there than here only in degree.
    const limit = CLOUD_MEDIA_LIMITS[kind];
    if (bytes.byteLength > limit) {
      throw new Error(
        `"${att.filename}" is ${bytes.byteLength} bytes, over Meta's ${kind} cap of ${limit}`,
      );
    }

    const mediaId = await uploadMedia(this.creds, {
      bytes,
      filename: att.filename,
      mimeType: att.mimeType,
    });
    // `send_file` posts the filename as the body when there is no note, and a
    // document already shows its filename — so that caption would be an echo.
    const trimmed = caption.trim();
    const result = await sendMedia(this.creds, {
      to,
      kind,
      mediaId,
      caption: trimmed && trimmed !== att.filename ? trimmed : undefined,
      filename: att.filename,
    });
    return { externalMessageId: result.id };
  }
}
