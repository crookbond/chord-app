/**
 * Connector layer (ADR 0010 / docs/subsystems/connectors.md).
 *
 * One implementation per platform: receive a webhook (or, for Telegram,
 * drive a long-poll loop), normalise the platform's payload into an
 * `InboundMessage`, and post it through the shared inbound pipeline.
 * Outbound is the bot's reply text forwarded to bound channels.
 */
import type { Request } from 'express';

import type { BotCard } from '@chord/kernel';

export type ConnectorPlatform = 'slack' | 'discord' | 'telegram' | 'whatsapp';

export interface InboundMessage {
  platform: ConnectorPlatform;
  externalChannelId: string;
  /** Human-readable channel/chat label when the platform exposes one. */
  externalChannelDisplay?: string | null;
  externalUserId: string;
  externalUserDisplay: string | null;
  externalMessageId: string;
  text: string;
  ts: Date;
  /** Platform-native @mention of the bot, already resolved by the connector. */
  mentionsBot: boolean;
  /**
   * True when the message @-mentions any user besides the bot. Used to
   * decide whether the bot's reply should be auto-mirrored across other
   * bridges — bot-only conversations stay private to the originating
   * surface; broadcasts addressed to people propagate.
   */
  mentionsOthers: boolean;
  /**
   * ADR 0025 — the bot user id that received this message. Set by BYO
   * connectors so the inbound pipeline can disambiguate `/chord pair`
   * codes minted for a specific bot. Null for the deploy-wide bot.
   */
  receivedByBotUserId?: string | null;
  /**
   * True when the message arrived via a 1-on-1 DM with the bot, false
   * for group/channel context. Used by the welcome-DM path to greet
   * strangers who discover the bot directly — group messages from
   * unbound channels stay silent.
   */
  isPrivate?: boolean;
  /**
   * ADR 0053 §7 — set when this inbound is a quick-reply **button tap**
   * rather than typed text. Carries the button's payload (`verb:id`, the
   * same encoding Telegram puts in `callback_data`). The pipeline routes it
   * to the shared callback handler (proposal confirm/reject) instead of the
   * LLM. `text` holds the button's visible label for logging.
   */
  buttonPayload?: string;
  /**
   * Optional file payload. Set when the inbound message is a photo,
   * document, voice clip, or video. The shared inbound pipeline turns
   * this into a Chord attachment + a `kind: 'file'` message; `text`
   * is the user's caption (or empty).
   */
  attachment?: InboundAttachment;
  /** Original payload, kept for audit/debugging only. */
  raw: unknown;
}

export interface InboundAttachment {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface OutboundMessage {
  externalChannelId: string;
  /**
   * Assistant prose, pre-card. The connector decides how to flatten or
   * augment this for its platform via `renderFor(platform, { body, cards })`.
   * Plain-text callers (relay tool today) pass an empty `cards` array.
   */
  body: string;
  /**
   * Structured cards produced by tools during the turn. May be empty.
   * Each connector's `send` is responsible for rendering these in the
   * way its platform supports — plain text, HTML, Block Kit, etc.
   */
  cards: BotCard[];
  /**
   * Optional file to upload alongside the message. When set, connectors
   * dispatch to their platform's file-upload API (Telegram sendDocument
   * /sendPhoto/etc.) and use `body` as the caption.
   */
  attachment?: OutboundAttachment;
  /**
   * Display name of the human who sent this message. When present, the
   * connector prefixes the rendered body with the name so users on the
   * external surface can tell who actually spoke — bot APIs (TG, Slack,
   * Discord) can only post as the bot account, so without this prefix
   * every bridged user message looks like it came from the bot.
   * Undefined for bot/system messages (no attribution needed).
   */
  senderName?: string;
  /**
   * ADR 0089 — force a specific Twilio Content template SID instead of letting
   * the connector pick one by button count. Set only for the out-of-window
   * WhatsApp nudge, which must go out on a Meta-APPROVED business-initiated
   * template; the ordinary quick-reply SIDs are in-session and would be
   * rejected outside the 24h window. Ignored by every other platform.
   */
  contentSid?: string;
  /**
   * ADR 0091 — body values for `{{1}}`..`{{n}}` of an approved template, in
   * order. Set alongside `contentSid` for the out-of-window briefing so Meta
   * receives the day's facts rather than a generic prompt. Each value must be
   * a single non-empty line (Meta rejects newlines and empty parameters).
   *
   * Meta only. Twilio's Content API interleaves body and button variables in
   * one numbering scheme, so extra body slots would collide with its button
   * slots — that connector keeps using `body` as its single `{{1}}`.
   */
  templateParams?: string[];
  /**
   * Deep link to this message's group in Chord. Platforms with a hard length
   * cap (WhatsApp 1600, Telegram 4096) clip long bodies and point here for the
   * rest — the daily briefing routinely exceeds both.
   */
  moreUrl?: string;
}

export interface OutboundAttachment {
  /** Absolute file path on the server disk. */
  path: string;
  filename: string;
  mimeType: string;
}

export interface SendResult {
  /** Platform-native id of the sent message, when the platform
   *  surfaces one. Null when the connector doesn't yet track it. */
  externalMessageId: string | null;
}

export interface VerificationChallenge {
  status: number;
  body?: unknown;
  /**
   * Plain-text response body. Meta echoes `hub.challenge` during the webhook
   * subscription handshake and expects it as text/plain - returning it as JSON
   * wraps it in quotes and fails verification (ADR 0090). Takes precedence
   * over `body` when set.
   */
  text?: string;
}

/**
 * Per-platform metadata used by the self-service pairing UI. Platforms
 * that support the `/chord pair <code>` flow (currently only Telegram —
 * Slack and Discord land bindings via OAuth, not in-channel) implement
 * `getPairingMetadata` and return their bot's @handle so mobile can
 * render the instruction string.
 */
export interface ConnectorPairingMetadata {
  /** Bot's @handle for instruction text, e.g. `mychord_bot`. */
  botUsername: string | null;
}

/**
 * Live runtime status for a connector instance, surfaced to the mobile
 * UI so users can tell whether their BYO bot is healthy without
 * tailing server logs.
 */
export interface ConnectorRuntimeStatus {
  /** 'ok' = recent success and no recent failure; 'warn' = currently
   *  working, but a recent attempt failed (within ~10 minutes);
   *  'starting' = no traffic yet; 'error' = last attempt failed. */
  state: 'ok' | 'warn' | 'starting' | 'error';
  /** ISO timestamp of the last successful inbound poll / event. Null
   *  until the first one happens. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the last error. Null when nothing has failed yet
   *  or the connector recovered after a successful poll. */
  lastErrorAt: string | null;
  /** Short human-readable description of the last error, when any. */
  lastErrorMessage: string | null;
}

/**
 * Window in which a recent error downgrades 'ok' to 'warn'. Picked at
 * 10 minutes — long enough that transient blips are visible after
 * recovery, short enough that a single bad request doesn't leave a
 * permanent yellow pill on a healthy bot.
 */
export const RECENT_ERROR_WINDOW_MS = 10 * 60 * 1_000;

/**
 * Shared decision: collapse `(lastSuccessAt, lastErrorAt)` into the
 * four-state UI label. Centralized so Telegram + Discord agree on the
 * definition.
 *
 * State table (with W = RECENT_ERROR_WINDOW_MS):
 *
 *   no events ever                                        → starting
 *   error within W,  success within W                     → warn
 *     (recent failure but currently recovered)
 *   error within W,  no success within W                  → error
 *     (actively failing right now)
 *   no events within W, last call was error               → warn
 *     (idle bot whose most recent call failed — common
 *      after a send error with no follow-up traffic)
 *   no events within W, last call was success             → ok
 *   only successes ever                                    → ok
 */
export function decideRuntimeState(
  lastSuccessAt: string | null,
  lastErrorAt: string | null,
  now = Date.now(),
): ConnectorRuntimeStatus['state'] {
  if (!lastSuccessAt && !lastErrorAt) return 'starting';

  const errMs = lastErrorAt ? new Date(lastErrorAt).getTime() : null;
  const okMs = lastSuccessAt ? new Date(lastSuccessAt).getTime() : null;
  const errRecent = errMs !== null && now - errMs < RECENT_ERROR_WINDOW_MS;
  const okRecent = okMs !== null && now - okMs < RECENT_ERROR_WINDOW_MS;

  if (errRecent) {
    return okRecent ? 'warn' : 'error';
  }
  // No recent error. If there's also no recent success, fall back on
  // which one happened most recently overall: a stale error with no
  // activity since is suspect (warn); a stale success is ok.
  if (!okRecent) {
    if (errMs !== null && (okMs === null || errMs > okMs)) return 'warn';
  }
  return 'ok';
}

/**
 * The minimal contract every IM connector implements. Platforms with no
 * webhook (Telegram in long-poll mode) implement `verifySignature` as a
 * trivially-true stub and `parseInbound` as `null` — the connector pushes
 * inbound messages through the pipeline directly from its poll loop.
 */
export interface Connector {
  readonly platform: ConnectorPlatform;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  verifySignature(req: Request): boolean;
  parseInbound(req: Request): Promise<InboundMessage | null>;

  /**
   * ADR 0090 - platforms that batch several messages into one webhook
   * notification (Meta) implement this so none are dropped. Callers prefer it
   * and fall back to `parseInbound` when it is absent.
   */
  parseInboundBatch?(req: Request): Promise<InboundMessage[]>;

  /**
   * Returns a response when the platform issues a verification challenge
   * (e.g. Slack's `url_verification`). When non-null, callers send it
   * straight back without running signature verification or parsing.
   */
  handleVerificationChallenge?(req: Request): VerificationChallenge | null;

  /**
   * Sends a message to the bound external channel. Returns the
   * platform's `external_message_id` for the sent message when the
   * platform exposes one (TG: numeric `message_id`); null when the
   * platform doesn't expose it yet (Slack, Discord — wire up when
   * needed). The outbound publisher records non-null ids in
   * `outbound_connector_messages` so downstream code (ADR 0029
   * proposal-resolution notifier) can later edit the message.
   */
  send(msg: OutboundMessage): Promise<SendResult>;

  /**
   * Optional: pairing-flow metadata (currently Telegram only). Returns
   * null when the connector hasn't initialized yet.
   */
  getPairingMetadata?(): ConnectorPairingMetadata | null;

  /** Optional: runtime health for the mobile status UI. Connectors
   *  without a dedicated health story (Slack webhook today) can leave
   *  this unimplemented — callers fall back to a generic 'unknown'. */
  getRuntimeStatus?(): ConnectorRuntimeStatus;

  /**
   * ADR 0029 — edit the action-button rendering of a previously-sent
   * message in place. Today Telegram implements this; Slack / Discord
   * leave it unimplemented (callers fall back to a no-op, log-only).
   * `cards` is the new full set of action cards for the message — pass
   * an empty array to remove the keyboard entirely.
   */
  editActionButtons?(input: EditActionButtonsInput): Promise<void>;
}

export interface EditActionButtonsInput {
  externalChannelId: string;
  externalMessageId: string;
  cards: BotCard[];
}
