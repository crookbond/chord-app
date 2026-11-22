/**
 * Cross-surface rendering contract.
 *
 * The bot produces a single semantic payload — assistant prose + a list
 * of structured BotCards — and we render that into whatever shape each
 * surface (Chord app, Telegram, Slack, Discord, plain logs) understands
 * best. Each renderer owns its platform's "ETL": which fields it keeps,
 * how it flattens them, what fallback it picks when the surface can't
 * represent a feature.
 *
 * The plain text slot is REQUIRED on every RenderedMessage so that:
 *   - any platform that hasn't been ported yet still produces a sensible
 *     bridge message,
 *   - logs and tests have a stable baseline to assert against,
 *   - rich-platform fallbacks (e.g. a Telegram client that fails to
 *     render HTML) still get a readable string.
 *
 * Platform-specific slots are optional. Connectors call `renderFor(...)`
 * and read whichever slot they implement; absence means "use text".
 */
import type { BotCard } from '@chord/kernel';

export interface RenderInput {
  /** The assistant's natural-language reply, ahead of any cards. */
  body: string;
  /** Structured cards emitted by tools during the turn. May be empty. */
  cards: BotCard[];
  /**
   * When set, the renderer prefixes the body with this name so the
   * external surface attributes the message to the human author rather
   * than the bot account that the Telegram/Slack/Discord API forces.
   * Undefined = bot or system message; no prefix.
   */
  senderName?: string;
  /**
   * Where to read the untruncated message. Set by the outbound publisher for
   * bridged sends; renderers whose platform has a length cap append it to the
   * clipped text. Absent → the clip still happens, just without a pointer.
   */
  moreUrl?: string;
  /**
   * ADR 0140 — override the platform's default text cap.
   *
   * WhatsApp has two transports with different limits (Twilio 1600, Meta
   * 4096) behind one renderer, so the cap is the connector's to state. Absent
   * → the renderer's conservative default.
   */
  textLimit?: number;
}

/**
 * Forward declaration — the concrete `TelegramRender` type lives in
 * `telegram.renderer.ts` so the kernel-level `BotCard` ↔ Telegram-API
 * mapping stays colocated with the renderer that produces it.
 */
export interface TelegramRenderSlot {
  html: string;
  replyMarkup?: {
    inline_keyboard: { text: string; url?: string }[][];
  };
  disableWebPagePreview: boolean;
}

export interface RenderedMessage {
  /** Always present. Universal fallback. */
  text: string;
  /** Telegram HTML body + inline keyboard, populated by telegram.renderer. */
  telegram?: TelegramRenderSlot;
  /** WhatsApp quick-reply buttons, populated by whatsapp.renderer when the
   *  turn carries callback action cards (proposals). Absent → send `text`. */
  whatsapp?: WhatsAppRenderSlot;
  // Future platform slots:
  //   slack?: SlackRender;
  //   discord?: DiscordRender;
}

/**
 * WhatsApp can't render inline keyboards from a plain text body — buttons
 * come from the Content API (`twilio/quick-reply`). When the bot's reply has
 * callback action cards (≤3 buttons, in-session), the renderer emits this
 * slot; the connector sends it as a quick-reply Content message. WhatsApp has
 * no message-edit, so resolution is a follow-up, not an in-place edit
 * (ADR 0029 / 0053).
 *
 * **At most one of these is ever set.** Meta's `interactive.type` is a single
 * value — a message is `button` OR `cta_url`, never both — so the renderer
 * picks one and the connector reads whichever it finds. Both absent → `text`.
 */
export interface WhatsAppRenderSlot {
  quickReply?: {
    /** Message body shown above the buttons. Always non-empty (Twilio requires it). */
    body: string;
    /** ≤3 quick-reply buttons. `id` is the `verb:id` payload echoed back as
     *  `ButtonPayload` on tap; `title` is the visible label (≤20 chars). */
    buttons: { id: string; title: string }[];
  };
  /**
   * ADR 0139 — a single tappable link button (`interactive.type: 'cta_url'`).
   * Meta-only: Twilio would need a CTA Content template, so its connector
   * reads `quickReply` alone and falls through to `text`, which still carries
   * the URL inline.
   */
  ctaUrl?: {
    /** Body shown above the button. Non-empty; Meta rejects an empty body. */
    body: string;
    /** Visible button label. Meta caps this at 20 characters. */
    displayText: string;
    url: string;
  };
}

/**
 * Discriminator for the dispatcher. `plain` is the always-on fallback;
 * `chord` is our in-app surface; the rest are external bridges. Kept as
 * a closed union so adding a platform forces a renderer to exist.
 */
export type RenderPlatform =
  | 'plain'
  | 'chord'
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'whatsapp';
