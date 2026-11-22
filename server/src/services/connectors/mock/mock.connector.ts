/**
 * In-memory connector used by tests and as a fixture for local dev. Records
 * every outbound `send` and exposes `injectInbound` so tests can drive the
 * inbound pipeline without a real webhook.
 *
 * Treats itself as the `slack` platform by default so it exercises the
 * same identity / channel binding code paths real platforms will. Pass
 * a different platform to the constructor for cross-platform tests.
 */
import type { Request } from 'express';
import type { Kysely } from 'kysely';

import type { BotCard } from '@chord/kernel';
import { mentionsBot } from '@chord/kernel';

import type { DB } from '../../../db/schema';
import { handleInbound } from '../inbound-pipeline';
import { renderFor } from '../renderers';
import type {
  Connector,
  ConnectorPlatform,
  InboundMessage,
  OutboundMessage,
  SendResult,
  VerificationChallenge,
} from '../types';

export interface MockSendRecord {
  externalChannelId: string;
  text: string;
  /** Raw cards passed to `send` so tests can assert on button payloads
   *  (ADR 0029 callback / URL buttons). The plain `text` slot is
   *  rendered via the plain renderer for backwards compatibility with
   *  existing assertions; cards are exposed here separately. */
  cards: BotCard[];
  /** Synthesized id this MockConnector returned from `send` — same
   *  value the SendResult.externalMessageId surfaced. Stable, sequential
   *  per connector instance. */
  externalMessageId: string;
  at: Date;
}

export class MockConnector implements Connector {
  readonly platform: ConnectorPlatform;
  readonly sent: MockSendRecord[] = [];
  initialized = false;
  shutdownCalled = false;
  /** Tests can set this to N to make the next N send() calls throw. */
  failNextSends = 0;
  /** Counter of sends that were forced to fail via failNextSends. */
  failedSendAttempts = 0;
  /** Monotonic counter for synthesized external_message_ids. */
  private sentCounter = 0;

  constructor(
    private readonly db: Kysely<DB>,
    platform: ConnectorPlatform = 'slack',
  ) {
    this.platform = platform;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }

  verifySignature(_req: Request): boolean {
    return true;
  }

  async parseInbound(_req: Request): Promise<InboundMessage | null> {
    return null;
  }

  handleVerificationChallenge(_req: Request): VerificationChallenge | null {
    return null;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (this.failNextSends > 0) {
      this.failNextSends -= 1;
      this.failedSendAttempts += 1;
      throw new Error("Forbidden: bot can't initiate conversation with a user");
    }
    const rendered = renderFor('plain', {
      body: msg.body,
      cards: msg.cards,
      senderName: msg.senderName,
    });
    const externalMessageId = `mock-${this.sentCounter++}`;
    this.sent.push({
      externalChannelId: msg.externalChannelId,
      text: rendered.text,
      cards: msg.cards,
      externalMessageId,
      at: new Date(),
    });
    return { externalMessageId };
  }

  /**
   * Test helper: synthesize an inbound message and run it through the
   * shared pipeline. Defaults fill in plausible values for the bits a
   * test usually doesn't care about.
   */
  async injectInbound(
    partial: Partial<InboundMessage> & {
      externalChannelId: string;
      externalUserId: string;
      text: string;
    },
  ): Promise<void> {
    const m: InboundMessage = {
      platform: this.platform,
      externalChannelId: partial.externalChannelId,
      externalChannelDisplay: partial.externalChannelDisplay ?? null,
      externalUserId: partial.externalUserId,
      externalUserDisplay:
        partial.externalUserDisplay ?? `${this.platform} user`,
      externalMessageId:
        partial.externalMessageId ?? `${this.platform}_${Date.now()}`,
      text: partial.text,
      ts: partial.ts ?? new Date(),
      mentionsBot: partial.mentionsBot ?? mentionsBot(partial.text),
      mentionsOthers: partial.mentionsOthers ?? false,
      receivedByBotUserId: partial.receivedByBotUserId ?? null,
      isPrivate: partial.isPrivate,
      attachment: partial.attachment,
      raw: partial.raw ?? null,
    };
    await handleInbound(this.db, m);
  }
}
