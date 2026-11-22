import { z } from 'zod';
import type {
  AttachmentId,
  GroupId,
  IsoDateTime,
  MessageId,
  UserId,
} from './ids';
import type { BotCard } from '../sse';

export type MessageKind = 'text' | 'file' | 'system' | 'bot';

export interface Message {
  id: MessageId;
  groupId: GroupId;
  /** null = bot or system */
  senderId: UserId | null;
  kind: MessageKind;
  body: string;
  attachmentId?: AttachmentId;
  replyToId?: MessageId;
  /** Whether this message @mentions the bot — precomputed for fast filtering. */
  mentionsBot: boolean;
  createdAt: IsoDateTime;
  /** Persisted bot cards — present on bot messages that triggered tool calls. */
  cards?: BotCard[];
  /**
   * ADR 0022 quiet-mode receipt. Present on user messages that triggered a
   * silent directive bot turn. Lets clients reconstruct the receipt strip
   * + cards on history fetch, since the bot reply itself is persisted at
   * chord_visible=0 and the `bot.receipt` SSE event is not replayed.
   * `toolNames` is empty on replay (tool calls are SSE-only, not persisted) —
   * the cards carry the visible content.
   */
  receipt?: {
    botMessageId: MessageId;
    status: 'ok' | 'error';
    toolNames: string[];
    cards: BotCard[];
  };
}

export const PostMessageRequest = z.object({
  body: z.string().trim().min(1).max(8000),
  attachmentId: z.string().optional(),
  replyToId: z.string().optional(),
  tz: z.string().max(64).optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

/** Most ids one delete request may name. "Select all" sends `all` instead. */
export const DELETE_MESSAGES_MAX_IDS = 500;

/**
 * Delete chat messages for everyone in the chat. Either the selected `ids`, or
 * `all: true` for every message the caller may delete (including history the
 * client never loaded). In the personal chat that is everything; in a shared
 * chat it is the caller's own messages and Chord's replies.
 */
export const DeleteMessagesRequest = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(DELETE_MESSAGES_MAX_IDS).optional(),
    all: z.literal(true).optional(),
  })
  .refine((v) => (v.ids ? !v.all : v.all === true), {
    message: 'send either ids or all',
  });
export type DeleteMessagesRequest = z.infer<typeof DeleteMessagesRequest>;

export interface DeleteMessagesResponse {
  /** Visible messages removed. */
  deleted: number;
  /** Named ids that were not removed: someone else's message, or already gone. */
  skipped: number;
}

import {
  DEFAULT_BOT_MENTION_ALIASES,
  buildMentionRegex,
} from '../bot-persona';

/**
 * Test whether `body` contains an @-mention of any of the given aliases
 * (e.g. `'@chord'`, `'@chord-beta'`). Aliases default to
 * {@link DEFAULT_BOT_MENTION_ALIASES} so callers without persona
 * context (test helpers, ingest pipelines pre-bound to a single bot)
 * continue to match the historical literal.
 */
export function mentionsBot(
  body: string,
  aliases: readonly string[] = DEFAULT_BOT_MENTION_ALIASES,
): boolean {
  return buildMentionRegex(aliases).test(body);
}
