/**
 * Telegram connector (ADR 0010).
 *
 * Inbound: long-poll `getUpdates` from initialize() onward. No webhook.
 * `verifySignature` and `parseInbound` are no-ops since the connector
 * synthesizes `InboundMessage` directly inside its loop and pushes it
 * through `handleInbound`.
 *
 * Outbound: `sendMessage` with `chat_id`.
 *
 * Mention detection: scan `entities[]` for `mention` segments matching
 * `@${botUsername}`, with a substring fallback. Private chats are
 * auto-mention since the bot is the only addressee. Bot's own messages
 * (`from.is_bot`) are filtered to prevent loops.
 *
 * **BotFather: `/setprivacy → Disable` is mandatory** for groups —
 * otherwise the bot only sees `/commands`, not regular text.
 */
import type { Kysely } from 'kysely';

import type { Request } from 'express';

import { mentionsBot as textMentionsBot } from '@chord/kernel';

import { logger } from '../../../config/logging';
import type { DB } from '../../../db/schema';
import { getDefaultPersona } from '../../bot-personas.service';
import { isLeader } from '../../cluster/leadership';
import { handleInbound } from '../inbound-pipeline';
import type {
  Connector,
  ConnectorPairingMetadata,
  ConnectorPlatform,
  ConnectorRuntimeStatus,
  EditActionButtonsInput,
  InboundMessage,
  OutboundMessage,
  SendResult,
  VerificationChallenge,
} from '../types';
import { handleGroupAdd } from '../group-add.service';
import { renderFor } from '../renderers';
import { decideRuntimeState } from '../types';
import {
  TelegramApiError,
  type TgCallbackQuery,
  type TgChatMemberUpdated,
  type TgMessage,
  type TgPhotoSize,
  type TgUpdate,
  answerCallbackQuery,
  downloadFile,
  editMessageReplyMarkup,
  getMe,
  getUpdates,
  sendFile,
  sendMessage as tgSendMessage,
  setMyCommands,
} from './telegram.api';
import { handleCallback } from './callback-handler';
import { readBlob } from '../../../db/crypto/index.js';

export interface TelegramConnectorOptions {
  token: string;
  db: Kysely<DB>;
  /** Pre-seed the bot's @username so tests can skip `getMe`. */
  botUsername?: string;
  /** Pre-seed the bot's user id so tests can filter self-messages. */
  botUserId?: number;
  /** Long-poll timeout in seconds. Default 30. Tests pass 0 for fast tests. */
  longPollTimeoutSeconds?: number;
}

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** How often a copy that does not hold `im` checks whether it does now. */
const LEADER_WAIT_MS = 5_000;

export class TelegramConnector implements Connector {
  readonly platform: ConnectorPlatform = 'telegram';

  private readonly token: string;
  private readonly db: Kysely<DB>;
  private readonly longPollTimeout: number;

  private botUsername: string | null;
  private botUserId: number | null;
  private offset = 0;
  private running = false;
  private currentAbort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private lastSuccessAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastErrorMessage: string | null = null;

  constructor(opts: TelegramConnectorOptions) {
    this.token = opts.token;
    this.db = opts.db;
    this.botUsername = opts.botUsername ?? null;
    this.botUserId = opts.botUserId ?? null;
    this.longPollTimeout = opts.longPollTimeoutSeconds ?? 30;
  }

  async initialize(): Promise<void> {
    if (!this.botUsername || !this.botUserId) {
      const me = await getMe(this.token);
      this.botUsername = me.username ?? null;
      this.botUserId = me.id;
    }
    logger.info('telegram connector ready', {
      botUserId: this.botUserId,
      botUsername: this.botUsername,
    });
    await this.registerBotCommands().catch((err) =>
      logger.warn('telegram: setMyCommands failed', {
        err: (err as Error).message,
      }),
    );
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  /**
   * Tell Telegram the slash-menu commands we support so users see them
   * in the `/` autocomplete UI. Non-fatal on error — the bot still
   * functions; the menu just won't appear until the next successful
   * call.
   */
  private async registerBotCommands(): Promise<void> {
    await setMyCommands(this.token, [
      { command: 'start', description: 'Get a signup link or check status' },
      { command: 'pair', description: 'Connect this chat to a Chord group' },
      { command: 'unpair', description: 'Disconnect this chat' },
      { command: 'help', description: 'What can I do?' },
    ]);
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.currentAbort?.abort();
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        // Loop swallows its own errors; ignore.
      }
      this.loopPromise = null;
    }
  }

  // Webhook surface — unused for poll-mode.
  verifySignature(_req: Request): boolean {
    return false;
  }
  async parseInbound(_req: Request): Promise<InboundMessage | null> {
    return null;
  }
  handleVerificationChallenge(_req: Request): VerificationChallenge | null {
    return null;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    try {
      const sent = msg.attachment
        ? await this.sendAttachment(msg)
        : await this.sendText(msg);
      this.lastSuccessAt = new Date().toISOString();
      return {
        externalMessageId:
          sent?.message_id != null ? String(sent.message_id) : null,
      };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.lastErrorAt = new Date().toISOString();
      this.lastErrorMessage = m.slice(0, 200);
      throw err;
    }
  }

  private async sendText(msg: OutboundMessage) {
    const rendered = renderFor('telegram', {
      body: msg.body,
      cards: msg.cards,
      senderName: msg.senderName,
      moreUrl: msg.moreUrl,
    });
    const tg = rendered.telegram;
    if (tg && tg.html) {
      return await tgSendMessage(this.token, {
        chat_id: msg.externalChannelId,
        text: tg.html,
        parse_mode: 'HTML',
        disable_web_page_preview: tg.disableWebPagePreview,
        ...(tg.replyMarkup ? { reply_markup: tg.replyMarkup } : {}),
      });
    }
    return await tgSendMessage(this.token, {
      chat_id: msg.externalChannelId,
      text: rendered.text,
    });
  }

  private async sendAttachment(msg: OutboundMessage) {
    const att = msg.attachment!;
    const bytes = await readBlob(att.path);
    const field = pickTelegramField(att.mimeType, att.filename);
    // Caption max length is 1024 chars in the Telegram API. Truncate
    // gently so we don't 400 on a long body. Prefix sender name so the
    // file isn't attributed to the bot.
    const captionBody = msg.senderName
      ? msg.body && msg.body.length > 0
        ? `${msg.senderName}: ${msg.body}`
        : `${msg.senderName} sent a file`
      : msg.body;
    const caption = captionBody && captionBody.length > 0 ? captionBody.slice(0, 1024) : undefined;
    return await sendFile(this.token, {
      chatId: msg.externalChannelId,
      field,
      bytes,
      filename: att.filename,
      mimeType: att.mimeType,
      caption,
    });
  }

  async editActionButtons(input: EditActionButtonsInput): Promise<void> {
    // The TG renderer with body='' produces the same reply_markup it
    // would have on the original send — so we don't have to duplicate
    // the keyboard-building logic here. When cards is empty, the
    // rendered replyMarkup is undefined and TG removes the keyboard.
    const rendered = renderFor('telegram', { body: '', cards: input.cards });
    await editMessageReplyMarkup(this.token, {
      chat_id: input.externalChannelId,
      message_id: input.externalMessageId,
      reply_markup: rendered.telegram?.replyMarkup,
    });
  }

  getPairingMetadata(): ConnectorPairingMetadata | null {
    if (!this.botUsername) return null;
    return { botUsername: this.botUsername };
  }

  getRuntimeStatus(): ConnectorRuntimeStatus {
    return {
      state: decideRuntimeState(this.lastSuccessAt, this.lastErrorAt),
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  /**
   * One iteration of the long-poll loop. Public so tests can drive it
   * deterministically without spinning up the full `runLoop`.
   */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const updates = await getUpdates(
      this.token,
      {
        offset: this.offset || undefined,
        timeout: this.longPollTimeout,
        allowed_updates: ['message', 'my_chat_member', 'callback_query'],
      },
      signal,
    );
    for (const update of updates) {
      try {
        await this.handleUpdate(update);
      } catch (err) {
        logger.warn('telegram: handleUpdate failed', {
          err,
          updateId: update.update_id,
        });
      }
      if (update.update_id >= this.offset) {
        this.offset = update.update_id + 1;
      }
    }
    return updates.length;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      this.currentAbort = new AbortController();
      // ADR 0280 — Telegram answers a second concurrent getUpdates with 409, and
      // two pollers would split the updates between them. Every web copy keeps
      // the connector for sending; only the copy holding `im` polls.
      if (!isLeader('im')) {
        await this.sleep(LEADER_WAIT_MS);
        continue;
      }
      try {
        await this.pollOnce(this.currentAbort.signal);
        this.lastSuccessAt = new Date().toISOString();
        this.backoffMs = BACKOFF_INITIAL_MS;
      } catch (err) {
        if (!this.running) return;
        const wait = this.backoffOnError(err);
        const msg = err instanceof Error ? err.message : String(err);
        this.lastErrorAt = new Date().toISOString();
        this.lastErrorMessage = msg.slice(0, 200);
        logger.warn('telegram poll error, backing off', {
          err: msg,
          waitMs: wait,
        });
        await this.sleep(wait);
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  private backoffOnError(err: unknown): number {
    if (err instanceof TelegramApiError && err.retryAfter != null) {
      return err.retryAfter * 1_000;
    }
    return this.backoffMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      // If we're aborted mid-sleep, resolve early.
      this.currentAbort?.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    logger.info('telegram update received', {
      updateId: update.update_id,
      kind: update.my_chat_member
        ? 'my_chat_member'
        : update.callback_query
          ? 'callback_query'
          : update.message
            ? 'message'
            : 'other',
      chatId: update.message?.chat.id ?? update.my_chat_member?.chat.id ?? null,
      chatType: update.message?.chat.type ?? update.my_chat_member?.chat.type ?? null,
      from: update.message?.from?.id ?? null,
      text: update.message?.text?.slice(0, 120) ?? null,
    });
    if (update.my_chat_member) {
      await this.handleMyChatMember(update.my_chat_member);
      return;
    }
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message) return; // edited_message, channel_post, etc. — out of scope v1
    const inbound = await this.toInbound(message);
    if (!inbound) {
      logger.info('telegram update dropped by toInbound', {
        updateId: update.update_id,
        chatId: message.chat.id,
        fromIsBot: message.from?.is_bot ?? null,
      });
      return;
    }
    await handleInbound(this.db, inbound);
  }

  /**
   * ADR 0029 — a user tapped an inline-keyboard button whose payload was
   * set via `callback_data`. Dispatch via the shared callback handler,
   * then `answerCallbackQuery` (Telegram requires this within ~15s to
   * clear the client-side spinner on the button).
   */
  private async handleCallbackQuery(cq: TgCallbackQuery): Promise<void> {
    const data = cq.data;
    if (!data) {
      await this.acknowledgeCallback(cq.id, { toast: '' });
      return;
    }
    try {
      const result = await handleCallback(this.db, {
        externalUserId: String(cq.from.id),
        receivedByBotUserId:
          this.botUserId != null ? String(this.botUserId) : null,
        data,
      });
      await this.acknowledgeCallback(cq.id, result);
    } catch (err) {
      logger.warn('tg callback dispatch failed', {
        data,
        err: (err as Error).message,
      });
      await this.acknowledgeCallback(cq.id, {
        toast: 'Something went wrong — try the app.',
      });
    }
  }

  private async acknowledgeCallback(
    callbackQueryId: string,
    result: { toast: string; alert?: boolean },
  ): Promise<void> {
    try {
      await answerCallbackQuery(this.token, {
        callback_query_id: callbackQueryId,
        text: result.toast || undefined,
        show_alert: result.alert,
      });
    } catch (err) {
      // `answerCallbackQuery` failure usually means the query expired
      // (TG's ~15s window). Logged, swallowed — the action itself has
      // already run.
      logger.info('tg answerCallbackQuery failed (likely expired)', {
        err: (err as Error).message,
      });
    }
  }

  /**
   * Bot was added/removed from a chat. We only care about the
   * transition into `member` / `administrator` from a non-member
   * state — that's our cue to auto-pair the chat to a new Chord
   * group. The user who made the change is in `from`.
   */
  private async handleMyChatMember(ev: TgChatMemberUpdated): Promise<void> {
    if (this.botUserId != null && ev.new_chat_member.user.id !== this.botUserId) {
      // Some other user's membership changed — irrelevant; we only act
      // on our own bot status.
      return;
    }
    const prev = ev.old_chat_member.status;
    const next = ev.new_chat_member.status;
    const wasOut = prev === 'left' || prev === 'kicked' || prev === undefined;
    const isIn = next === 'member' || next === 'administrator';
    if (!(wasOut && isIn)) return;

    // Private chats aren't "added to" in the bot-add sense — they show
    // up via the first message; ignore them here.
    if (ev.chat.type === 'private') return;

    await handleGroupAdd(this.db, {
      platform: 'telegram',
      externalChannelId: String(ev.chat.id),
      chatTitle: ev.chat.title ?? null,
      addedByExternalUserId: String(ev.from.id),
      addedByExternalDisplay: this.displayName(ev.from),
      receivedByBotUserId:
        this.botUserId != null ? String(this.botUserId) : null,
    });
  }

  private async toInbound(m: TgMessage): Promise<InboundMessage | null> {
    if (!m.from) return null;
    if (m.from.is_bot) return null; // skip bot self + other bots
    if (this.botUserId != null && m.from.id === this.botUserId) return null;

    const fileRef = pickFileRef(m);
    // Caption used in lieu of text on attachment messages. An empty
    // text + no attachment is the only true skip case.
    const text = m.text ?? m.caption ?? '';
    if (!fileRef && text.length === 0) return null;

    const isPrivate = m.chat.type === 'private';
    const captionEntities = m.entities ?? m.caption_entities;
    const mentionsBot = isPrivate || this.containsBotMention(text, captionEntities);
    const mentionsOthers = this.containsNonBotMention(text, captionEntities);

    let attachment: InboundMessage['attachment'];
    if (fileRef) {
      try {
        const { bytes, filePath } = await downloadFile(this.token, fileRef.fileId);
        attachment = {
          filename: fileRef.filename ?? defaultFilenameFor(filePath, fileRef.kind),
          mimeType: fileRef.mimeType ?? guessMime(filePath),
          bytes,
        };
      } catch (err) {
        logger.warn('telegram: failed to download attachment', {
          fileId: fileRef.fileId,
          err: (err as Error).message,
        });
        // Without bytes we can't make a Chord attachment. Fall through
        // and treat it as a text-only message — caption (if any) still
        // surfaces, but with no file.
        if (text.length === 0) return null;
      }
    }

    return {
      platform: 'telegram',
      externalChannelId: String(m.chat.id),
      externalChannelDisplay: this.chatDisplay(m.chat),
      externalUserId: String(m.from.id),
      externalUserDisplay: this.displayName(m.from),
      externalMessageId: String(m.message_id),
      text,
      ts: new Date(m.date * 1000),
      mentionsBot,
      mentionsOthers,
      receivedByBotUserId: this.botUserId != null ? String(this.botUserId) : null,
      isPrivate,
      attachment,
      raw: m,
    };
  }

  private containsNonBotMention(
    text: string,
    entities: TgMessage['entities'],
  ): boolean {
    if (!entities) return false;
    const botHandle = this.botUsername
      ? `@${this.botUsername}`.toLowerCase()
      : null;
    for (const e of entities) {
      if (e.type === 'mention') {
        const slice = text.substring(e.offset, e.offset + e.length).toLowerCase();
        if (botHandle && slice === botHandle) continue;
        return true;
      }
      if (e.type === 'text_mention') {
        if (e.user?.id === this.botUserId) continue;
        return true;
      }
    }
    return false;
  }

  private containsBotMention(
    text: string,
    entities: TgMessage['entities'],
  ): boolean {
    // The bot's Telegram username (`@Ch0rd_bot`) is what Telegram tags
    // as a `mention` entity — but users commonly type the persona alias
    // (`@chord`) instead, which Telegram leaves as plain text. Accept
    // either: entity match against the bot username, OR text match
    // against any persona alias.
    if (textMentionsBot(text, getDefaultPersona().mentionAliases)) return true;

    if (!this.botUsername) return false;
    const handle = `@${this.botUsername}`;
    if (entities) {
      for (const e of entities) {
        if (e.type === 'mention') {
          const slice = text.substring(e.offset, e.offset + e.length);
          if (slice.toLowerCase() === handle.toLowerCase()) return true;
        }
        if (e.type === 'text_mention' && e.user?.id === this.botUserId) {
          return true;
        }
      }
      return false;
    }
    // Fallback when entities are absent.
    return text.toLowerCase().includes(handle.toLowerCase());
  }

  private displayName(u: NonNullable<TgMessage['from']>): string | null {
    const parts = [u.first_name, u.last_name].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
    if (u.username) return `@${u.username}`;
    return null;
  }

  private chatDisplay(chat: TgMessage['chat']): string | null {
    if (chat.title && chat.title.trim().length > 0) return chat.title.trim();
    if (chat.username) return `@${chat.username}`;
    return null;
  }
}

type FileKind = 'photo' | 'document' | 'voice' | 'audio' | 'video';

interface FileRef {
  fileId: string;
  filename?: string;
  mimeType?: string;
  kind: FileKind;
}

/**
 * Resolve the single best file_id to download from a Telegram message.
 * Photos arrive as an array of resized variants; we pick the largest.
 * Documents / voice / audio / video are direct one-shot refs. Exported
 * so unit tests can exercise the priority order without firing fetches.
 */
export function pickFileRef(m: TgMessage): FileRef | null {
  if (m.photo && m.photo.length > 0) {
    const largest = pickLargestPhoto(m.photo);
    return {
      fileId: largest.file_id,
      filename: `photo-${largest.file_unique_id}.jpg`,
      mimeType: 'image/jpeg',
      kind: 'photo',
    };
  }
  if (m.document) {
    return {
      fileId: m.document.file_id,
      filename: m.document.file_name,
      mimeType: m.document.mime_type,
      kind: 'document',
    };
  }
  if (m.voice) {
    return {
      fileId: m.voice.file_id,
      filename: `voice-${m.voice.file_unique_id}.ogg`,
      mimeType: m.voice.mime_type ?? 'audio/ogg',
      kind: 'voice',
    };
  }
  if (m.audio) {
    return {
      fileId: m.audio.file_id,
      filename: m.audio.file_name,
      mimeType: m.audio.mime_type,
      kind: 'audio',
    };
  }
  if (m.video) {
    return {
      fileId: m.video.file_id,
      filename: m.video.file_name,
      mimeType: m.video.mime_type ?? 'video/mp4',
      kind: 'video',
    };
  }
  return null;
}

function pickLargestPhoto(sizes: TgPhotoSize[]): TgPhotoSize {
  return sizes.reduce((best, cur) =>
    (cur.file_size ?? cur.width * cur.height) > (best.file_size ?? best.width * best.height)
      ? cur
      : best,
  );
}

function defaultFilenameFor(filePath: string, kind: FileKind): string {
  const base = filePath.split('/').pop() ?? `${kind}.bin`;
  return base;
}

function guessMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Map a mime type / filename to the Telegram API method we should
 * upload through. Photos/videos give the richer inline preview;
 * everything else falls back to sendDocument.
 */
function pickTelegramField(
  mime: string,
  filename: string,
): 'document' | 'photo' | 'video' | 'audio' | 'voice' {
  const m = mime.toLowerCase();
  // Voice notes are Telegram-specific (ogg/opus); treat ordinary audio
  // (mp3, m4a) as 'audio' so listeners get the player UI.
  if (m === 'audio/ogg' || m === 'audio/opus') return 'voice';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/') && m !== 'image/gif') return 'photo';
  // Telegram treats animated GIFs as documents in this code path
  // (sendAnimation needs a different signature; defer until needed).
  if (filename.toLowerCase().endsWith('.gif')) return 'document';
  return 'document';
}
