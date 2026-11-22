/**
 * Connector lifecycle registry (ADR 0010 + 0025).
 *
 * Keyed by `(platform, botUserId)` so multiple BYO bindings that point at
 * the same bot share one connector instance + one poll loop. The
 * deploy-wide bot registers under `(platform, "default")`.
 *
 * Owned by `server.ts`: at boot we register deploy-wide connectors when
 * env vars are set, then `loadByoConnectors(db)` instantiates one
 * connector per distinct BYO bot found in `group_external_channels` /
 * `pending_connector_pairings`. Outbound publisher subscribes to SSE
 * once the registry is non-empty.
 *
 * Per ADR 0010: missing creds disable that connector with a one-line
 * warn — they never crash the server.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging';
import type { DB } from '../../db/schema';
import { startOutboundPublisher } from './outbound-publisher';
import { startProposalResolutionNotifier } from './proposal-resolution-notifier';
import type { Connector, ConnectorPlatform } from './types';

export const DEPLOY_WIDE_KEY = 'default';

export function connectorKey(
  platform: ConnectorPlatform,
  botUserId: string | null,
): string {
  return `${platform}:${botUserId ?? DEPLOY_WIDE_KEY}`;
}

class ConnectorRegistry {
  private connectors = new Map<string, Connector>();
  private outboundUnsubscribe: (() => void) | null = null;
  private resolutionUnsubscribe: (() => void) | null = null;
  private db: Kysely<DB> | null = null;

  /**
   * Register a connector under `(platform, botUserId)`. `botUserId === null`
   * registers the deploy-wide entry (one per platform).
   */
  register(connector: Connector, botUserId: string | null = null): void {
    this.connectors.set(connectorKey(connector.platform, botUserId), connector);
  }

  /** Look up by binding identity. Falls back to deploy-wide if BYO not registered. */
  getForBinding(
    platform: ConnectorPlatform,
    botUserId: string | null,
  ): Connector | undefined {
    if (botUserId !== null) {
      const byo = this.connectors.get(connectorKey(platform, botUserId));
      if (byo) return byo;
    }
    return this.connectors.get(connectorKey(platform, null));
  }

  /** Strict variant for the outbound publisher: no fallback. */
  getExact(
    platform: ConnectorPlatform,
    botUserId: string | null,
  ): Connector | undefined {
    return this.connectors.get(connectorKey(platform, botUserId));
  }

  /** Used by the inbound pipeline when only the platform is known (deploy-wide bot). */
  getDeployWide(platform: ConnectorPlatform): Connector | undefined {
    return this.connectors.get(connectorKey(platform, null));
  }

  list(): Connector[] {
    return Array.from(this.connectors.values());
  }

  has(platform: ConnectorPlatform, botUserId: string | null): boolean {
    return this.connectors.has(connectorKey(platform, botUserId));
  }

  /** Initialize every registered connector and start the outbound publisher. */
  async initializeAll(db: Kysely<DB>): Promise<void> {
    this.db = db;
    if (this.connectors.size === 0) {
      logger.info('connectors: none enabled');
    }
    for (const [key, c] of this.connectors) {
      try {
        await c.initialize();
        logger.info(`connectors: ${key} initialized`);
      } catch (err) {
        logger.warn(`connectors: ${key} init failed — disabling`, { err });
        this.connectors.delete(key);
      }
    }
    this.startBackgroundListeners(db);
  }

  /**
   * Add and initialize a single connector at runtime — used when a user
   * starts a BYO pairing and we need to spin up their bot's poll loop on
   * the fly. Idempotent: a no-op when the same `(platform, botUserId)` is
   * already registered.
   */
  async addAndInitialize(
    connector: Connector,
    botUserId: string,
  ): Promise<void> {
    const key = connectorKey(connector.platform, botUserId);
    if (this.connectors.has(key)) return;
    this.connectors.set(key, connector);
    try {
      await connector.initialize();
      logger.info(`connectors: ${key} initialized (runtime add)`);
    } catch (err) {
      logger.warn(`connectors: ${key} init failed — disabling`, { err });
      this.connectors.delete(key);
      throw err;
    }
    if (this.db) this.startBackgroundListeners(this.db);
  }

  private startBackgroundListeners(db: Kysely<DB>): void {
    if (this.connectors.size === 0) return;
    if (!this.outboundUnsubscribe) {
      this.outboundUnsubscribe = startOutboundPublisher(db, this);
    }
    if (!this.resolutionUnsubscribe) {
      this.resolutionUnsubscribe = startProposalResolutionNotifier(db, this);
    }
  }

  /**
   * Tear down a single BYO connector. Caller has already verified there
   * are no remaining bindings or pending pairings referencing it.
   */
  async remove(
    platform: ConnectorPlatform,
    botUserId: string,
  ): Promise<void> {
    const key = connectorKey(platform, botUserId);
    const conn = this.connectors.get(key);
    if (!conn) return;
    this.connectors.delete(key);
    try {
      await conn.shutdown();
      logger.info(`connectors: ${key} shut down (refcount = 0)`);
    } catch (err) {
      logger.warn(`connectors: ${key} shutdown failed`, { err });
    }
  }

  async shutdownAll(): Promise<void> {
    this.outboundUnsubscribe?.();
    this.outboundUnsubscribe = null;
    this.resolutionUnsubscribe?.();
    this.resolutionUnsubscribe = null;
    for (const [key, c] of this.connectors) {
      try {
        await c.shutdown();
      } catch (err) {
        logger.warn(`connectors: ${key} shutdown failed`, { err });
      }
    }
    this.connectors.clear();
    this.db = null;
  }
}

export const connectorRegistry = new ConnectorRegistry();
