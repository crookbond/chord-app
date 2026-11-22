/**
 * Discord gateway WebSocket state machine.
 *
 * Lifted in spirit from `webapp-start/.../discord-gateway.service.ts`
 * and reshaped for native `WebSocket` (Node 24+, no `ws` dep) and
 * for testability via a `wsFactory` constructor option.
 *
 * Lifecycle:
 *   start()  → open WS → HELLO (op 10) → IDENTIFY (op 2) → READY (op 0/READY)
 *   while connected: MESSAGE_CREATE dispatches → onMessage handler
 *   on unexpected close → reconnect with exponential backoff (1s → 30s, infinite)
 *   stop() → close WS, no reconnect
 *
 * Only one `MESSAGE_CREATE` payload subset is exposed to the handler;
 * everything else (presence, typing, voice, guild lifecycle) is dropped
 * silently.
 */
import { logger } from '../../../config/logging';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

const INTENT = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const;

const REQUIRED_INTENTS =
  INTENT.GUILDS |
  INTENT.GUILD_MESSAGES |
  INTENT.DIRECT_MESSAGES |
  INTENT.MESSAGE_CONTENT;

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_LOUD_WARN_AFTER_MS = 5 * 60 * 1_000;

export interface DiscordMessageCreate {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator?: string;
    bot?: boolean;
  };
  content: string;
  mentions: Array<{ id: string }>;
  timestamp: string;
}

interface GatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/**
 * Minimal subset of the WebSocket API we rely on. Native `WebSocket`
 * (Node 24+) satisfies this; tests inject a fake.
 */
export interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((this: MinimalWebSocket, ev: unknown) => void) | null;
  onmessage:
    | ((this: MinimalWebSocket, ev: { data: string }) => void)
    | null;
  onclose:
    | ((this: MinimalWebSocket, ev: { code: number; reason: string }) => void)
    | null;
  onerror: ((this: MinimalWebSocket, ev: unknown) => void) | null;
}

export type WsFactory = (url: string) => MinimalWebSocket;

export interface DiscordGatewayOptions {
  token: string;
  wsFactory?: WsFactory;
  /** Inject for deterministic tests; defaults to `setTimeout` etc. */
  scheduler?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
}

const DEFAULT_SCHEDULER: NonNullable<DiscordGatewayOptions['scheduler']> = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

export class DiscordGateway {
  private readonly token: string;
  private readonly wsFactory: WsFactory;
  private readonly scheduler: NonNullable<DiscordGatewayOptions['scheduler']>;

  private ws: MinimalWebSocket | null = null;
  private sequence: number | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_INITIAL_MS;
  private firstFailureAt: number | null = null;
  private loudWarnIssued = false;
  private shuttingDown = false;
  private botUserId: string | null = null;
  private lastReadyAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastErrorMessage: string | null = null;

  private messageHandler: ((m: DiscordMessageCreate) => void) | null = null;
  private readyResolvers: Array<{
    resolve: (botUserId: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DiscordGatewayOptions) {
    this.token = opts.token;
    this.wsFactory =
      opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as MinimalWebSocket);
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  setMessageHandler(handler: (m: DiscordMessageCreate) => void): void {
    this.messageHandler = handler;
  }

  start(): void {
    this.shuttingDown = false;
    this.connect();
  }

  /**
   * Resolves with the bot's own user id once the first `READY` arrives.
   * Subsequent reconnects do not re-trigger this — only the initial
   * handshake. Rejects on `timeoutMs` if `READY` hasn't arrived.
   */
  awaitReady(timeoutMs = 30_000): Promise<string> {
    if (this.botUserId) return Promise.resolve(this.botUserId);
    return new Promise<string>((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
      if (!this.readyTimeout) {
        this.readyTimeout = this.scheduler.setTimeout(() => {
          const pending = this.readyResolvers;
          this.readyResolvers = [];
          this.readyTimeout = null;
          for (const r of pending) {
            r.reject(new Error('discord gateway: READY timeout'));
          }
        }, timeoutMs);
      }
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimeout) {
      this.scheduler.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.heartbeatInterval) {
      this.scheduler.clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.readyTimeout) {
      this.scheduler.clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    const pending = this.readyResolvers;
    this.readyResolvers = [];
    for (const r of pending) {
      r.reject(new Error('discord gateway: stopped before READY'));
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private connect(): void {
    let ws: MinimalWebSocket;
    try {
      ws = this.wsFactory(GATEWAY_URL);
    } catch (err) {
      this.scheduleReconnect(err);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      logger.debug('discord gateway: ws open');
    };
    ws.onmessage = (ev) => {
      this.handleFrame(ev.data);
    };
    ws.onclose = (ev) => {
      logger.warn('discord gateway: ws closed', { code: ev.code, reason: ev.reason });
      this.lastErrorAt = new Date().toISOString();
      this.lastErrorMessage = `ws closed (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`.slice(0, 200);
      this.cleanupConnection();
      if (!this.shuttingDown) this.scheduleReconnect();
    };
    ws.onerror = (err) => {
      const msg = (err as { message?: string })?.message ?? 'ws error';
      this.lastErrorAt = new Date().toISOString();
      this.lastErrorMessage = msg.slice(0, 200);
      logger.warn('discord gateway: ws error', { err: msg });
    };
  }

  private cleanupConnection(): void {
    if (this.heartbeatInterval) {
      this.scheduler.clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.ws = null;
  }

  private scheduleReconnect(err?: unknown): void {
    if (this.shuttingDown) return;
    const now = Date.now();
    if (this.firstFailureAt === null) this.firstFailureAt = now;
    const elapsed = now - (this.firstFailureAt ?? now);
    if (
      !this.loudWarnIssued &&
      elapsed >= RECONNECT_LOUD_WARN_AFTER_MS
    ) {
      logger.warn('discord gateway: reconnects failing >5min', { elapsed });
      this.loudWarnIssued = true;
    }
    const delay = this.reconnectDelayMs;
    logger.info('discord gateway: scheduling reconnect', {
      delayMs: delay,
      err: err instanceof Error ? err.message : undefined,
    });
    this.reconnectTimeout = this.scheduler.setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
  }

  private handleFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch (err) {
      logger.warn('discord gateway: malformed frame', { err });
      return;
    }
    switch (frame.op) {
      case OP.HELLO:
        this.onHello(frame.d as { heartbeat_interval: number });
        break;
      case OP.DISPATCH:
        this.sequence = frame.s ?? this.sequence;
        if (frame.t === 'READY') this.onReady(frame.d as { user: { id: string } });
        else if (frame.t === 'MESSAGE_CREATE')
          this.onMessageCreate(frame.d as DiscordMessageCreate);
        break;
      case OP.HEARTBEAT:
        this.sendHeartbeat();
        break;
      case OP.HEARTBEAT_ACK:
        // nothing for v1; could detect zombied connections if we tracked it
        break;
      case OP.RECONNECT:
      case OP.INVALID_SESSION:
        logger.info('discord gateway: server asked to reconnect', { op: frame.op });
        this.ws?.close(4000, 'server asked');
        break;
      default:
        // Ignore other ops (presence, voice, guild lifecycle, etc.).
        break;
    }
  }

  private onHello(d: { heartbeat_interval: number }): void {
    this.startHeartbeat(d.heartbeat_interval);
    this.sendIdentify();
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) {
      this.scheduler.clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = this.scheduler.setInterval(() => {
      this.sendHeartbeat();
    }, intervalMs);
  }

  private sendHeartbeat(): void {
    this.sendFrame({ op: OP.HEARTBEAT, d: this.sequence });
  }

  private sendIdentify(): void {
    this.sendFrame({
      op: OP.IDENTIFY,
      d: {
        token: this.token,
        intents: REQUIRED_INTENTS,
        properties: {
          os: process.platform,
          browser: 'chord',
          device: 'chord',
        },
      },
    });
  }

  private onReady(d: { user: { id: string } }): void {
    this.botUserId = d.user.id;
    this.reconnectDelayMs = RECONNECT_INITIAL_MS;
    this.firstFailureAt = null;
    this.loudWarnIssued = false;
    this.lastReadyAt = new Date().toISOString();
    logger.info('discord gateway: READY', { botUserId: this.botUserId });

    if (this.readyTimeout) {
      this.scheduler.clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    const pending = this.readyResolvers;
    this.readyResolvers = [];
    for (const r of pending) r.resolve(this.botUserId);
  }

  private onMessageCreate(m: DiscordMessageCreate): void {
    if (this.messageHandler) this.messageHandler(m);
  }

  private sendFrame(frame: { op: number; d?: unknown }): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      logger.warn('discord gateway: send failed', { err });
    }
  }

  /**
   * Public read-only health snapshot used by the connector wrapper to
   * answer `getRuntimeStatus`. `lastReadyAt` is set on the most recent
   * successful gateway READY; `lastError*` capture the latest WS-level
   * failure since the last READY.
   */
  getHealth(): {
    lastReadyAt: string | null;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
  } {
    return {
      lastReadyAt: this.lastReadyAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  // Test introspection helpers — narrow read-only surface.
  /** Visible-for-testing: latest seen sequence number (or null). */
  _getSequence(): number | null {
    return this.sequence;
  }
  /** Visible-for-testing: bot user id once READY has fired. */
  _getBotUserId(): string | null {
    return this.botUserId;
  }
  /** Visible-for-testing: whether shutdown has been called. */
  _isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}
