import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';

import type { SseEventMap, SseEventName, StreamEndReason } from '@chord/kernel';
import { SSE } from '@chord/kernel';
import { env } from '../config/env.js';
import { logger } from '../config/logging';
import { queueErrorLogger } from './queue/redis.js';

interface Subscriber {
  id: number;
  res: Response;
  /** Who is listening. Lets an event that belongs to one person go only to them. */
  userId?: string;
}

/**
 * ADR 0040: a group event fans out into one copy per member, each tagged with
 * its `ownerUserId`, and every copy used to be broadcast to the WHOLE group
 * channel. The client already acts only on the copy it owns (device-calendar
 * sync) and just refreshes its list for the rest, so the other members' copies
 * were pure waste: N members meant N broadcasts written to N sockets, 10,000
 * writes for one event in a 100-member group. A copy now goes only to its
 * owner's own streams; an event with no owner (a legacy single copy) still goes
 * to everyone.
 */
const OWNER_SCOPED_EVENTS: ReadonlySet<string> = new Set([
  SSE.eventCreated,
  SSE.eventUpdated,
  SSE.eventDeleted,
]);

/**
 * Listener invoked once per `broadcast()` call after subscribers are written.
 * Used by the IM connector outbound publisher (ADR 0010) to forward bot
 * replies to bound external channels without faking an Express Response.
 * Listener errors are caught and logged; they never abort the broadcast.
 */
type BroadcastListener = <K extends SseEventName>(
  channel: string,
  event: K,
  data: SseEventMap[K],
) => void;

// ADR (pending, see docs/notes) — SSE fanout over Redis pub/sub. A single
// fixed channel carries every broadcast tagged with its originating node's
// id, so a node ignores its own echo instead of double-delivering to local
// subscribers or double-firing onBroadcast listeners.
const FANOUT_CHANNEL = 'sse:fanout';
/** ADR 0280 — process-to-process hand-offs that are not client broadcasts. */
const PEER_CHANNEL = 'cluster:peer';

interface FanoutMessage {
  origin: string;
  channel: string;
  event: SseEventName;
  data: unknown;
}

interface PeerMessage {
  origin: string;
  topic: string;
  data: unknown;
}

type PeerHandler = (data: unknown) => void;

export class SseHub {
  private subs = new Map<string, Set<Subscriber>>();
  private listeners = new Set<BroadcastListener>();
  private peerHandlers = new Map<string, PeerHandler>();
  private nextId = 1;
  private readonly pingInterval: NodeJS.Timeout;
  private readonly nodeId = randomUUID();
  private redisPub: Redis | null = null;
  private redisSub: Redis | null = null;

  constructor(redisUrl?: string) {
    this.pingInterval = setInterval(() => this.pingAll(), 25_000);
    this.pingInterval.unref?.();

    // Empty/unset REDIS_URL keeps this hub exactly as in-process as it was
    // before this existed — dev, CI, and `npm run sim` need no Redis. Two
    // dedicated connections: ioredis can't issue other commands on one that's
    // in SUBSCRIBE mode, and neither is ever shared with BullMQ's own Redis
    // connections (kept fully separate — see services/queue/redis.ts).
    if (redisUrl) {
      this.redisPub = new Redis(redisUrl);
      this.redisSub = new Redis(redisUrl);
      // ioredis emits `error` on every reconnect attempt while Redis is away.
      this.redisPub.on(
        'error',
        queueErrorLogger('SSE redis pub connection error', (m, meta) => logger.warn(m, meta)),
      );
      this.redisSub.on(
        'error',
        queueErrorLogger('SSE redis sub connection error', (m, meta) => logger.warn(m, meta)),
      );
      void this.redisSub
        .subscribe(FANOUT_CHANNEL, PEER_CHANNEL)
        .catch((err) => logger.error('SSE redis subscribe failed', { err: err.message }));
      this.redisSub.on('message', (redisChannel: string, raw: string) => {
        if (redisChannel === PEER_CHANNEL) {
          this.receivePeer(raw);
          return;
        }
        let msg: FanoutMessage;
        try {
          msg = JSON.parse(raw) as FanoutMessage;
        } catch (err) {
          logger.warn('SSE fanout message unparseable', { err });
          return;
        }
        if (msg.origin === this.nodeId) return; // already delivered locally
        this.deliverLocal(msg.channel, msg.event, msg.data as SseEventMap[SseEventName]);
      });
    }
  }

  subscribe(channel: string, res: Response, userId?: string): () => void {
    const sub: Subscriber = { id: this.nextId++, res, userId };
    let set = this.subs.get(channel);
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(sub);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`: subscribed to ${channel}\n\n`);

    logger.debug(`SSE subscribed ${channel} #${sub.id} (total=${set.size})`);

    return () => {
      const s = this.subs.get(channel);
      if (s) {
        s.delete(sub);
        if (s.size === 0) this.subs.delete(channel);
      }
      logger.debug(`SSE unsubscribed ${channel} #${sub.id}`);
    };
  }

  broadcast<K extends SseEventName>(
    channel: string,
    event: K,
    data: SseEventMap[K],
  ): void {
    this.deliverLocal(channel, event, data);
    if (this.redisPub) {
      const msg: FanoutMessage = { origin: this.nodeId, channel, event, data };
      this.redisPub
        .publish(FANOUT_CHANNEL, JSON.stringify(msg))
        .catch((err) => logger.warn('SSE redis publish failed', { err: err.message, event }));
    }
  }

  /**
   * Write to this node's own local subscribers and fire onBroadcast
   * listeners. Called directly by `broadcast()` for locally-originated
   * events, and by the Redis subscribe handler for events that originated
   * on another node (never both, per the origin-tag check above).
   */
  private deliverLocal<K extends SseEventName>(
    channel: string,
    event: K,
    data: SseEventMap[K],
  ): void {
    const set = this.subs.get(channel);
    if (set && set.size > 0) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const ownerOnly = OWNER_SCOPED_EVENTS.has(event)
        ? (data as { ownerUserId?: string } | null)?.ownerUserId
        : undefined;
      for (const sub of set) {
        if (ownerOnly && sub.userId !== ownerOnly) continue;
        try {
          sub.res.write(payload);
        } catch (err) {
          logger.warn('SSE write failed, dropping sub', { err });
          set.delete(sub);
        }
      }
    }
    if (this.listeners.size > 0) {
      for (const listener of this.listeners) {
        try {
          listener(channel, event, data);
        } catch (err) {
          logger.warn('SSE listener threw', { err, event });
        }
      }
    }
  }

  /**
   * Broadcast an event on the caller's personal user channel (`user:${userId}`).
   * Used for email.* events that must not ride a group stream.
   */
  broadcastToUser<K extends SseEventName>(
    userId: string,
    event: K,
    data: SseEventMap[K],
  ): void {
    this.broadcast(`user:${userId}`, event, data);
  }

  /**
   * Register a non-Express observer of every successful broadcast. Returns
   * an `unsubscribe` thunk. Used by the IM connector outbound publisher.
   */
  onBroadcast(listener: BroadcastListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * ADR 0280 — hand `data` to the other processes' handler for `topic` (never
   * this one's). Returns false when there are no other processes to reach
   * (no Redis), so the caller can tell "sent" from "nobody to send to".
   */
  sendToPeers(topic: string, data: unknown): boolean {
    if (!this.redisPub) return false;
    const msg: PeerMessage = { origin: this.nodeId, topic, data };
    this.redisPub
      .publish(PEER_CHANNEL, JSON.stringify(msg))
      .catch((err) => logger.warn('peer message publish failed', { err: err.message, topic }));
    return true;
  }

  /** Receive what another process sent with `sendToPeers(topic, …)`. One handler per topic. */
  onPeerMessage(topic: string, handler: PeerHandler): void {
    this.peerHandlers.set(topic, handler);
  }

  private receivePeer(raw: string): void {
    let msg: PeerMessage;
    try {
      msg = JSON.parse(raw) as PeerMessage;
    } catch (err) {
      logger.warn('peer message unparseable', { err });
      return;
    }
    if (msg.origin === this.nodeId) return;
    try {
      this.peerHandlers.get(msg.topic)?.(msg.data);
    } catch (err) {
      logger.warn('peer message handler threw', { err, topic: msg.topic });
    }
  }

  /**
   * Send `stream.end` to every subscriber on `channel` and close their
   * responses. Removes them from the subscriber map so the per-request
   * cleanup becomes a no-op. Used for intentional mid-stream termination
   * (membership loss, group deletion) so the client can distinguish this
   * from a broken connection.
   */
  closeChannel(channel: string, reason: StreamEndReason): void {
    const set = this.subs.get(channel);
    if (!set) return;
    const payload = `event: ${SSE.streamEnd}\ndata: ${JSON.stringify({ reason })}\n\n`;
    for (const sub of set) {
      try {
        sub.res.write(payload);
        sub.res.end();
      } catch {
        // already closed
      }
    }
    this.subs.delete(channel);
  }

  /**
   * Send `stream.end` to every subscriber across all channels. Called on
   * graceful shutdown so clients receive an explicit EOS before the socket
   * closes, rather than an opaque connection error that would trigger the
   * browser's EventSource auto-reconnect loop.
   */
  closeAll(reason: StreamEndReason): void {
    const payload = `event: ${SSE.streamEnd}\ndata: ${JSON.stringify({ reason })}\n\n`;
    for (const set of this.subs.values()) {
      for (const sub of set) {
        try {
          sub.res.write(payload);
          sub.res.end();
        } catch {
          // already closed
        }
      }
    }
    this.subs.clear();
    clearInterval(this.pingInterval);
    this.redisPub?.disconnect();
    this.redisSub?.disconnect();
  }

  private pingAll(): void {
    const now = Date.now();
    for (const [channel, set] of this.subs) {
      const payload = `event: ping\ndata: {"t":${now}}\n\n`;
      for (const sub of set) {
        try {
          sub.res.write(payload);
        } catch {
          set.delete(sub);
        }
      }
      if (set.size === 0) this.subs.delete(channel);
    }
  }
}

export const sseHub = new SseHub(env.REDIS_URL || undefined);
