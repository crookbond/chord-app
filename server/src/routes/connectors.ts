/**
 * Self-service IM connector management routes (ADR 0010 + 0025).
 *
 *  GET    /api/v1/groups/:id/connectors             — list bindings + pending
 *  POST   /api/v1/groups/:id/connectors/pair        — mint a pairing code
 *  GET    /api/v1/groups/:id/connectors/pair/:code  — poll pairing status
 *  DELETE /api/v1/groups/:id/connectors/:platform/:externalChannelId
 *                                                   — unbind a connector
 *
 * All four require session + group membership. Personal groups are
 * pair-able too — bot replies still cross the boundary per ADR 0011's
 * no-mirror semantics, but the bridge gives the user two-way reach
 * into their private chat.
 *
 * Telegram + Discord support both deploy-wide (operator sets
 * `*_BOT_TOKEN` in `.env`) and BYO (user supplies their own token in the
 * pair request). Slack BYO needs Socket Mode (future ADR), so Slack is
 * deploy-wide-only for now.
 */
import { Router } from 'express';

import {
  API,
  RenameBindingRequest,
  SSE,
  StartPairingRequest,
  type ConnectorBinding,
  type ConnectorPlatform,
  type ConnectorStatus,
  type GroupConnectorsResponse,
  type MeConnectorsResponse,
  type PairingStatusResponse,
  type StartPairingResponse,
} from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth';
import { logger } from '../config/logging';
import {
  listBindingsForGroup,
  renameBindingAlias,
  unbindChannel,
} from '../services/connectors/channel-resolver';
import {
  PairingError,
  cancelPendingPairing,
  generatePairingCode,
  getPairingStatus,
  maybeShutdownByoConnector,
  sweepExpiredPairings,
} from '../services/connectors/pairing.service';
import { connectorRegistry } from '../services/connectors/registry';
import { isMember } from '../services/groups.service';
import { sseHub } from '../services/sse.hub';

const PAIRABLE_PLATFORMS: ConnectorPlatform[] = ['telegram', 'discord'];

export const connectorsRouter = Router();

connectorsRouter.use(loadSession);

connectorsRouter.get(
  API.groupConnectors(':id'),
  requireSession,
  async (req, res, next) => {
    try {
      const groupId = req.params.id;
      if (!(await isMember(req.db, groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const group = await req.db
        .selectFrom('groups')
        .select(['kind'])
        .where('id', '=', groupId)
        .executeTakeFirst();
      if (!group) {
        res.status(404).json({ error: 'group not found' });
        return;
      }

      await sweepExpiredPairings(req.db).catch((err) =>
        logger.warn('pairing sweep failed', { err }),
      );

      const bindingRows = await listBindingsForGroup(req.db, groupId);
      const platforms: GroupConnectorsResponse['platforms'] = {
        slack: connectorAvailability('slack'),
        discord: connectorAvailability('discord'),
        telegram: connectorAvailability('telegram'),
        whatsapp: connectorAvailability('whatsapp'),
      };
      const bindings: ConnectorBinding[] = bindingRows.map((b) => ({
        platform: b.platform,
        externalChannelId: b.externalChannelId,
        externalDisplay: parseDisplay(b.configJson),
        alias: b.alias,
        createdAt: '',
        byo: b.botUserId !== null,
        botUsername: bindingBotUsername(b.platform, b.botUserId, platforms),
        runtime: bindingRuntime(b.platform, b.botUserId),
      }));

      const pendingRows = await req.db
        .selectFrom('pending_connector_pairings')
        .selectAll()
        .where('group_id', '=', groupId)
        .execute();

      const response: GroupConnectorsResponse = {
        bindings,
        pending: pendingRows.map((p) => ({
          code: p.code,
          platform: p.platform,
          expiresAt: p.expires_at,
          botUsername:
            p.bot_username ?? platforms[p.platform].botUsername,
        })),
        platforms,
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

connectorsRouter.get(
  API.meConnectors,
  requireSession,
  async (req, res, next) => {
    try {
      const userId = req.userId!;
      await sweepExpiredPairings(req.db).catch((err) =>
        logger.warn('pairing sweep failed', { err }),
      );

      const groups = await req.db
        .selectFrom('groups')
        .innerJoin('group_members', 'group_members.group_id', 'groups.id')
        .where('group_members.user_id', '=', userId)
        .select(['groups.id as id', 'groups.name as name', 'groups.kind as kind'])
        .execute();

      const platforms: MeConnectorsResponse['platforms'] = {
        slack: connectorAvailability('slack'),
        discord: connectorAvailability('discord'),
        whatsapp: connectorAvailability('whatsapp'),
        telegram: connectorAvailability('telegram'),
      };

      // One batched query per table across every group the user belongs to,
      // instead of 2 sequential round trips per group.
      const groupIds = groups.map((g) => g.id);
      const [bindingRows, pendingRows] =
        groupIds.length === 0
          ? [[], []]
          : await Promise.all([
              req.db
                .selectFrom('group_external_channels')
                .select([
                  'group_id as groupId',
                  'platform',
                  'external_channel_id as externalChannelId',
                  'config_json as configJson',
                  'alias',
                  'bot_user_id as botUserId',
                ])
                .where('group_id', 'in', groupIds)
                .execute(),
              req.db
                .selectFrom('pending_connector_pairings')
                .selectAll()
                .where('group_id', 'in', groupIds)
                .execute(),
            ]);

      const bindingsByGroup = new Map<string, typeof bindingRows>();
      for (const b of bindingRows) {
        const list = bindingsByGroup.get(b.groupId);
        if (list) list.push(b);
        else bindingsByGroup.set(b.groupId, [b]);
      }
      const pendingByGroup = new Map<string, typeof pendingRows>();
      for (const p of pendingRows) {
        const list = pendingByGroup.get(p.group_id);
        if (list) list.push(p);
        else pendingByGroup.set(p.group_id, [p]);
      }

      const groupsOut: MeConnectorsResponse['groups'] = groups.map((g) => ({
        groupId: g.id,
        groupName: g.name,
        groupKind: g.kind,
        bindings: (bindingsByGroup.get(g.id) ?? []).map((b) => ({
          platform: b.platform,
          externalChannelId: b.externalChannelId,
          externalDisplay: parseDisplay(b.configJson),
          alias: b.alias,
          createdAt: '',
          byo: b.botUserId !== null,
          botUsername: bindingBotUsername(b.platform, b.botUserId, platforms),
          runtime: bindingRuntime(b.platform, b.botUserId),
        })),
        pending: (pendingByGroup.get(g.id) ?? []).map((p) => ({
          code: p.code,
          platform: p.platform,
          expiresAt: p.expires_at,
          botUsername:
            p.bot_username ?? platforms[p.platform].botUsername,
        })),
      }));

      groupsOut.sort((a, b) => a.groupName.localeCompare(b.groupName, undefined, { sensitivity: 'base' }));

      const response: MeConnectorsResponse = { groups: groupsOut, platforms };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

connectorsRouter.post(
  API.groupConnectorPair(':id'),
  requireSession,
  async (req, res, next) => {
    try {
      const groupId = req.params.id;
      if (!(await isMember(req.db, groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const parsed = StartPairingRequest.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const platform = parsed.data.platform;
      if (!PAIRABLE_PLATFORMS.includes(platform)) {
        res.status(400).json({
          error: `${platform} is not yet pairable through this flow`,
        });
        return;
      }

      const status = connectorAvailability(platform);
      const usingByo = !!parsed.data.botToken;
      if (usingByo && !status.byoSupported) {
        res.status(400).json({
          error: `${platform} doesn't support BYO yet on this server`,
        });
        return;
      }
      if (!usingByo && !status.enabled) {
        res.status(400).json({
          error: `${platform} has no deploy-wide bot configured. Supply your own bot token in the request, or ask the operator to set ${platform.toUpperCase()}_BOT_TOKEN.`,
        });
        return;
      }

      try {
        const result = await generatePairingCode(req.db, {
          platform,
          groupId,
          userId: req.userId!,
          alias: parsed.data.alias,
          botToken: parsed.data.botToken,
        });
        const response: StartPairingResponse = {
          code: result.code,
          expiresAt: result.expiresAt,
          platform,
          botUsername: result.botUsername ?? status.botUsername,
          alias: result.alias,
          byo: result.byo,
        };
        res.status(201).json(response);
      } catch (err) {
        if (err instanceof PairingError) {
          const code = err.reason === 'group_not_found' ? 404 : 400;
          res.status(code).json({ error: err.reason });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

connectorsRouter.get(
  API.groupConnectorPairStatus(':id', ':code'),
  requireSession,
  async (req, res, next) => {
    try {
      const groupId = req.params.id;
      if (!(await isMember(req.db, groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const code = req.params.code;
      const status = await getPairingStatus(req.db, code, 'telegram', { groupId });

      // Once multi-bridge Telegram is allowed, "unknown" is ambiguous:
      // the consumed code is gone, but this group may already have other
      // Telegram bindings. The client matches the alias it just paired
      // against a fresh bindings list instead of guessing here.
      const response: PairingStatusResponse = { status: status.status };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

connectorsRouter.delete(
  API.groupConnectorPairStatus(':id', ':code'),
  requireSession,
  async (req, res, next) => {
    try {
      const groupId = req.params.id;
      if (!(await isMember(req.db, groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const result = await cancelPendingPairing(req.db, {
        groupId,
        code: req.params.code,
      });
      if (!result.canceled) {
        res.status(404).json({ error: 'unknown_code' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

connectorsRouter.patch(
  API.groupConnectorBinding(':id', ':platform', ':externalChannelId'),
  requireSession,
  async (req, res, next) => {
    try {
      const groupId = req.params.id;
      if (!(await isMember(req.db, groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const platform = req.params.platform as ConnectorPlatform;
      const externalChannelId = req.params.externalChannelId;
      if (!['slack', 'discord', 'telegram', 'whatsapp'].includes(platform)) {
        res.status(400).json({ error: 'unknown platform' });
        return;
      }
      const parsed = RenameBindingRequest.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message ?? 'invalid alias' });
        return;
      }
      const result = await renameBindingAlias(
        req.db,
        groupId,
        platform,
        externalChannelId,
        parsed.data.alias,
      );
      if (result === 'not_found') {
        res.status(404).json({ error: 'binding not found' });
        return;
      }
      if (result === 'conflict') {
        res.status(409).json({ error: 'alias_already_in_use' });
        return;
      }
      sseHub.broadcast(groupId, SSE.connectorRenamed, {
        platform,
        externalChannelId,
        alias: parsed.data.alias,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

connectorsRouter.delete(
  API.groupConnectorBinding(':id', ':platform', ':externalChannelId'),
  requireSession,
  async (req, res, next) => {
    try {
      const groupId = req.params.id;
      if (!(await isMember(req.db, groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const platform = req.params.platform as ConnectorPlatform;
      const externalChannelId = req.params.externalChannelId;
      if (!['slack', 'discord', 'telegram', 'whatsapp'].includes(platform)) {
        res.status(400).json({ error: 'unknown platform' });
        return;
      }

      // Confirm the binding belongs to *this* group before allowing
      // delete. Otherwise a member of group A could unbind a Slack
      // channel attached to group B.
      const owning = await req.db
        .selectFrom('group_external_channels')
        .select(['group_id', 'bot_user_id'])
        .where('platform', '=', platform)
        .where('external_channel_id', '=', externalChannelId)
        .executeTakeFirst();
      if (!owning) {
        res.status(404).json({ error: 'binding not found' });
        return;
      }
      if (owning.group_id !== groupId) {
        res.status(403).json({ error: 'binding belongs to another group' });
        return;
      }

      await unbindChannel(req.db, platform, externalChannelId);
      sseHub.broadcast(groupId, SSE.connectorUnbound, {
        platform,
        externalChannelId,
      });

      // ADR 0025 — if this was the last binding using a BYO bot, tear
      // down its connector instance so we don't keep an idle long-poll
      // / gateway loop alive.
      if (owning.bot_user_id) {
        await maybeShutdownByoConnector(req.db, platform, owning.bot_user_id).catch(
          (err) =>
            logger.warn('byo connector teardown failed', {
              platform,
              botUserId: owning.bot_user_id,
              err: err instanceof Error ? err.message : String(err),
            }),
        );
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

function connectorAvailability(platform: ConnectorPlatform): ConnectorStatus {
  // "Availability" here means: is a deploy-wide bot configured? BYO is
  // always available so long as the platform supports BYO, which is a
  // separate signal returned per-platform by `byoSupported`.
  const conn = connectorRegistry.getDeployWide(platform);
  if (!conn) {
    return { enabled: false, botUsername: null, byoSupported: byoSupported(platform) };
  }
  const meta = conn.getPairingMetadata?.();
  return {
    enabled: true,
    botUsername: meta?.botUsername ?? null,
    byoSupported: byoSupported(platform),
  };
}

/**
 * Best-effort bot @handle for a binding. For BYO we ask the registered
 * connector instance (it knows its own getMe result); for deploy-wide
 * we fall back to the platform-wide handle. Null when no connector is
 * available — UI just hides the handle in that case.
 */
function bindingBotUsername(
  platform: ConnectorPlatform,
  botUserId: string | null,
  platforms: Record<ConnectorPlatform, ConnectorStatus>,
): string | null {
  if (botUserId) {
    const conn = connectorRegistry.getExact(platform, botUserId);
    return conn?.getPairingMetadata?.()?.botUsername ?? null;
  }
  return platforms[platform].botUsername;
}

function bindingRuntime(
  platform: ConnectorPlatform,
  botUserId: string | null,
): ConnectorBinding['runtime'] {
  const conn = botUserId
    ? connectorRegistry.getExact(platform, botUserId)
    : connectorRegistry.getDeployWide(platform);
  return conn?.getRuntimeStatus?.() ?? null;
}

function byoSupported(platform: ConnectorPlatform): boolean {
  // Telegram: long-poll. Discord: gateway WS. Both connect outbound from
  // server, so BYO works without an inbound webhook. Slack BYO needs
  // Socket Mode (future ADR), so until then BYO Slack is unsupported.
  return platform === 'telegram' || platform === 'discord';
}

function parseDisplay(configJson: string | null): string | null {
  if (!configJson) return null;
  try {
    const parsed = JSON.parse(configJson) as { display?: string };
    return parsed.display ?? null;
  } catch {
    return null;
  }
}
