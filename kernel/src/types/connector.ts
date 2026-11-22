import { z } from 'zod';

/**
 * Shared types for the IM connector self-service UI (ADR 0010 / 0011).
 * Server returns these from `/api/v1/groups/:id/connectors/*`; the
 * mobile group-settings screen consumes them.
 */

export type ConnectorPlatform = 'slack' | 'discord' | 'telegram' | 'whatsapp';

export interface ConnectorBinding {
  platform: ConnectorPlatform;
  externalChannelId: string;
  /** Human-readable label captured at pair time (Telegram chat title etc.). */
  externalDisplay: string | null;
  /**
   * Per-Chord-group short alias used when the bot's relay tool targets a
   * specific bridge ("telegram", "family"). Unique within the Chord group.
   * Defaults to the platform name and can be renamed.
   */
  alias: string;
  createdAt: string;
  /** ADR 0025 — true when this binding uses a BYO bot token. */
  byo: boolean;
  /** Bot's @handle (BYO or deploy-wide) when known. Null otherwise. */
  botUsername: string | null;
  /** Live runtime status of the underlying connector. Null when no
   *  connector is registered for this binding (e.g. token revoked
   *  since boot, server restarting). */
  runtime: ConnectorRuntimeStatus | null;
}

/** Mirror of `server/src/services/connectors/types.ts` for the wire.
 *  'warn' fires on either: a recent error followed by recovery
 *  (within ~10 min), or a stale failure with no activity since (often
 *  a send error on an idle bot). 'error' = actively failing, no
 *  recent success. */
export interface ConnectorRuntimeStatus {
  state: 'ok' | 'warn' | 'starting' | 'error';
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

export interface PendingPairing {
  code: string;
  platform: ConnectorPlatform;
  expiresAt: string;
  /** Bot's @handle for the pairing instructions; null when unknown yet. */
  botUsername: string | null;
}

export interface ConnectorStatus {
  /** Whether the deploy-wide bot is configured at all. */
  enabled: boolean;
  /** Bot's @handle once initialized; only meaningful when `enabled`. */
  botUsername: string | null;
  /**
   * ADR 0025 — true when the platform supports BYO bot tokens via
   * polling / WS. Telegram + Discord today; Slack lands once Socket
   * Mode ships.
   */
  byoSupported: boolean;
}

export interface GroupConnectorsResponse {
  bindings: ConnectorBinding[];
  pending: PendingPairing[];
  /** Per-platform availability info, keyed by platform name. */
  platforms: Record<ConnectorPlatform, ConnectorStatus>;
}

/** Aggregated view for the user's unified Settings tab — bindings across
 *  every group the user is a member of. */
export interface MeConnectorsResponse {
  groups: Array<{
    groupId: string;
    groupName: string;
    groupKind: 'group' | 'personal';
    bindings: ConnectorBinding[];
    pending: PendingPairing[];
  }>;
  /** Platform availability is global (env-driven), not per-group. */
  platforms: Record<ConnectorPlatform, ConnectorStatus>;
}

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

export const StartPairingRequest = z.object({
  platform: z.enum(['slack', 'discord', 'telegram']),
  /**
   * Optional per-group alias. Lowercase letters/digits/dashes, 1-24 chars,
   * must start with letter or digit. Defaults to the platform name.
   */
  alias: z
    .string()
    .regex(ALIAS_PATTERN, 'alias must be 1-24 chars: a-z, 0-9, dashes')
    .optional(),
  /**
   * ADR 0025 — bring-your-own bot token. When present, server validates
   * via the platform's identity endpoint, encrypts at rest, and runs a
   * dedicated connector instance for this binding's bot. Omit to use the
   * deploy-wide bot (when configured).
   */
  botToken: z.string().min(1).optional(),
});
export type StartPairingRequest = z.infer<typeof StartPairingRequest>;

export interface StartPairingResponse {
  code: string;
  expiresAt: string;
  platform: ConnectorPlatform;
  botUsername: string | null;
  /** The alias the binding will be created with once the code is consumed. */
  alias: string;
  /**
   * ADR 0025 — true when the user supplied their own bot token at pair
   * start. The pairing instructions and the eventual binding both reflect
   * "your bot" (BYO username) instead of Chord's deploy-wide bot.
   */
  byo: boolean;
}

export type PairingPollStatus = 'pending' | 'bound' | 'expired' | 'unknown';

export interface PairingStatusResponse {
  status: PairingPollStatus;
  /** Present when status === 'bound'. */
  binding?: ConnectorBinding;
}

export const RenameBindingRequest = z.object({
  alias: z
    .string()
    .regex(ALIAS_PATTERN, 'alias must be 1-24 chars: a-z, 0-9, dashes'),
});
export type RenameBindingRequest = z.infer<typeof RenameBindingRequest>;
