/**
 * Discord connector (ADR 0010, gateway-only v1).
 *
 * Inbound: gateway WS receives `MESSAGE_CREATE`; the connector
 * synthesizes `InboundMessage` and pushes it through `handleInbound`.
 * Webhook surface is a no-op — `verifySignature` returns false,
 * `parseInbound` returns null. Slash commands and the interactions
 * webhook are deferred (see ADR 0010 *Consequences*).
 *
 * Outbound: `POST /channels/{id}/messages`.
 *
 * Mention detection: scan `mentions[]` for the bot's own user id
 * (resolved at startup via `GET /users/@me`). DMs (no `guild_id`)
 * treated as auto-mention. `author.bot === true` filters self +
 * other bots.
 */
import type { Request } from 'express';
import type { Kysely } from 'kysely';

import { logger } from '../../../config/logging';
import type { DB } from '../../../db/schema';
import { isLeader } from '../../cluster/leadership';
import { handleInbound } from '../inbound-pipeline';
import type {
  Connector,
  ConnectorPlatform,
  ConnectorRuntimeStatus,
  InboundMessage,
  OutboundMessage,
  SendResult,
  VerificationChallenge,
} from '../types';
import { renderFor } from '../renderers';
import { decideRuntimeState } from '../types';
import { getMe, postChannelMessage } from './discord.api';
import {
  DiscordGateway,
  type DiscordMessageCreate,
  type WsFactory,
} from './discord-gateway';

const DEDUPE_CACHE_MAX = 1_000;

export interface DiscordConnectorOptions {
  token: string;
  db: Kysely<DB>;
  /** Pre-seed bot user id for tests so we can skip the REST call. */
  botUserId?: string;
  /** Inject a fake WebSocket factory for tests. */
  wsFactory?: WsFactory;
  /** Skip opening the gateway during initialize() — tests that drive
   * `handleMessageCreate` directly use this. */
  skipGateway?: boolean;
}

export class DiscordConnector implements Connector {
  readonly platform: ConnectorPlatform = 'discord';

  private readonly token: string;
  private readonly db: Kysely<DB>;
  private readonly skipGateway: boolean;
  private readonly gateway: DiscordGateway | null;
  private botUserId: string | null;
  private readonly seenMessageIds = new Set<string>();
  // Send-side health (REST). Gateway-side health is owned by
  // `DiscordGateway`; runtime status fuses both via decideRuntimeState.
  private lastSendSuccessAt: string | null = null;
  private lastSendErrorAt: string | null = null;
  private lastSendErrorMessage: string | null = null;

  constructor(opts: DiscordConnectorOptions) {
    this.token = opts.token;
    this.db = opts.db;
    this.botUserId = opts.botUserId ?? null;
    this.skipGateway = opts.skipGateway ?? false;
    this.gateway = this.skipGateway
      ? null
      : new DiscordGateway({ token: opts.token, wsFactory: opts.wsFactory });
  }

  async initialize(): Promise<void> {
    if (!this.botUserId) {
      const me = await getMe(this.token);
      this.botUserId = me.id;
    }
    logger.info('discord connector ready', { botUserId: this.botUserId });

    if (this.gateway) {
      // ADR 0280 — every web copy keeps a gateway session (any copy may need
      // to send), and Discord delivers each message to all of them; only the
      // copy holding `im` handles it.
      this.gateway.setMessageHandler((m) => {
        if (isLeader('im')) this.onMessageCreate(m);
      });
      this.gateway.start();
      // Wait for first READY so initialize errors propagate clearly.
      await this.gateway.awaitReady();
    }
  }

  async shutdown(): Promise<void> {
    if (this.gateway) await this.gateway.stop();
    this.seenMessageIds.clear();
  }

  // Webhook surface — unused for gateway-only mode.
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
    const rendered = renderFor('discord', {
      body: msg.body,
      cards: msg.cards,
      senderName: msg.senderName,
    });
    try {
      await postChannelMessage(this.token, {
        channelId: msg.externalChannelId,
        content: rendered.text,
      });
      this.lastSendSuccessAt = new Date().toISOString();
      // postChannelMessage doesn't currently surface the discord
      // message id — wire it when the proposal-edit flow ships for
      // discord. Returning null is the documented "platform doesn't
      // surface an id yet" fallback (ADR 0029).
      return { externalMessageId: null };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.lastSendErrorAt = new Date().toISOString();
      this.lastSendErrorMessage = m.slice(0, 200);
      throw err;
    }
  }

  getRuntimeStatus(): ConnectorRuntimeStatus {
    const h = this.gateway?.getHealth() ?? {
      lastReadyAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
    };
    // Fuse inbound (gateway) + outbound (REST send) signals into one
    // status. Latest-of either timestamp wins, and the error message
    // travels with whichever side errored most recently.
    const lastSuccessAt = pickLater(h.lastReadyAt, this.lastSendSuccessAt);
    const lastErrorAt = pickLater(h.lastErrorAt, this.lastSendErrorAt);
    const lastErrorMessage =
      lastErrorAt === null
        ? null
        : lastErrorAt === h.lastErrorAt
          ? h.lastErrorMessage
          : this.lastSendErrorMessage;
    if (!this.gateway && !lastSuccessAt && !lastErrorAt) {
      return { state: 'starting', lastSuccessAt: null, lastErrorAt: null, lastErrorMessage: null };
    }
    return {
      state: decideRuntimeState(lastSuccessAt, lastErrorAt),
      lastSuccessAt,
      lastErrorAt,
      lastErrorMessage,
    };
  }

  /**
   * Visible-for-testing: drive a synthetic `MESSAGE_CREATE` through
   * the same code path the gateway would. Used by tests that don't
   * want to spin up the full gateway state machine.
   */
  async handleMessageCreate(m: DiscordMessageCreate): Promise<void> {
    await this.dispatchMessage(m);
  }

  private onMessageCreate(m: DiscordMessageCreate): void {
    void this.dispatchMessage(m).catch((err) =>
      logger.warn('discord: dispatch crashed', {
        err,
        messageId: m.id,
      }),
    );
  }

  private async dispatchMessage(m: DiscordMessageCreate): Promise<void> {
    const inbound = this.toInbound(m);
    if (!inbound) return;
    if (this.seenMessageIds.has(m.id)) return;
    this.rememberMessage(m.id);
    await handleInbound(this.db, inbound);
  }

  private toInbound(m: DiscordMessageCreate): InboundMessage | null {
    if (m.author.bot) return null; // skip self + other bots
    if (this.botUserId && m.author.id === this.botUserId) return null;
    if (!m.content || m.content.length === 0) return null;

    const isDm = !m.guild_id;
    const mentionsBot = isDm || this.containsBotMention(m.mentions);
    const mentionsOthers = m.mentions.some(
      (u) => u.id !== this.botUserId,
    );

    return {
      platform: 'discord',
      externalChannelId: m.channel_id,
      externalUserId: m.author.id,
      externalUserDisplay: this.displayName(m.author),
      externalMessageId: m.id,
      text: m.content,
      ts: new Date(m.timestamp),
      mentionsBot,
      mentionsOthers,
      receivedByBotUserId: this.botUserId,
      raw: m,
    };
  }

  private containsBotMention(
    mentions: DiscordMessageCreate['mentions'],
  ): boolean {
    if (!this.botUserId) return false;
    for (const u of mentions) {
      if (u.id === this.botUserId) return true;
    }
    return false;
  }

  private displayName(author: DiscordMessageCreate['author']): string | null {
    if (author.discriminator && author.discriminator !== '0') {
      return `${author.username}#${author.discriminator}`;
    }
    return author.username || null;
  }

  private rememberMessage(id: string): void {
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > DEDUPE_CACHE_MAX) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest) this.seenMessageIds.delete(oldest);
    }
  }
}

function pickLater(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
