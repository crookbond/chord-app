/**
 * Connector inbound pipeline. Converts a normalized `InboundMessage` into a
 * Chord message + bot turn. Mirrors what `routes/messages.ts` does for
 * native posts, minus the membership 403 (binding is the auth) and the
 * URL save-offer SSE (which only mobile clients consume).
 *
 * On first sighting from an external user, ensures a shadow user exists
 * AND adds them to the bound group as a `guest`-tier member, so context
 * assembly + retrieval treat them like any other group member.
 */
import type { Kysely } from 'kysely';

import {
  SSE,
  buildPairCommandRegex,
  buildSlashCommandRegex,
  buildUnpairCommandRegex,
} from '@chord/kernel';

import { env } from '../../config/env';
import { logger } from '../../config/logging';
import type { DB } from '../../db/schema';
import { saveFile } from '../attachments.service';
import {
  decideReaction,
  passivelyExtractFromMessage,
  reactToMessage,
} from '../bot/bot.service';
import {
  consumeFollowupTurn,
  isWithinFollowupWindow,
  openFollowupWindow,
} from '../bot/followup-window';
import { getDefaultPersona } from '../bot-personas.service';
import { ensurePersonalGroup } from '../groups.service';
import { postMessage } from '../messages.service';
import { sseHub } from '../sse.hub';
import { bindChannel, lookupGroupForChannel, unbindChannel } from './channel-resolver';
import {
  autoProvisionDemoUser,
  lookupIdentity,
  resolveIdentity,
  resolveIdentityWithMeta,
} from './identity-resolver';
import { consumePairingCode } from './pairing.service';
import { answerProposalsByReply } from './reply-answer';
import { handleCallback } from './telegram/callback-handler';
import { appDeepLink } from './outbound-publisher';
import { connectorRegistry } from './registry';
import type { InboundMessage } from './types';
import { recordInbound } from './whatsapp/session-window';
import { tasterState } from './whatsapp/taster';
import {
  maybeAnnounceShadowSignupInGroup,
  maybeWelcomeStranger,
} from './welcome-dm.service';

export async function handleInbound(
  db: Kysely<DB>,
  m: InboundMessage,
): Promise<void> {
  // ADR 0089 — any inbound (a message OR a button tap) reopens WhatsApp's 24h
  // session window, so stamp it first and unconditionally. Doing it here rather
  // than deeper in the pipeline means a message that is later dropped as a pair
  // command, a taster refusal, or an unbound channel still counts: to Meta the
  // user wrote to us, and that is what the window turns on.
  if (m.platform === 'whatsapp') {
    await recordInbound(db, m.externalChannelId).catch((err) =>
      logger.warn('whatsapp: recording session window failed', {
        err: (err as Error).message,
      }),
    );
  }

  // ADR 0053 §7 — a quick-reply button tap (WhatsApp) routes to the shared
  // proposal callback handler, then we post the outcome as a follow-up
  // message. WhatsApp has no message-edit, so there's no "disable the
  // buttons in place" step — the follow-up IS the resolution feedback.
  if (m.buttonPayload) {
    await handleButtonTap(db, m).catch((err) =>
      logger.warn('connector button tap failed', {
        platform: m.platform,
        err: (err as Error).message,
      }),
    );
    return;
  }

  // Pair commands are processed BEFORE the channel-binding lookup —
  // by definition the channel isn't bound yet when the user pairs. The
  // regex is rebuilt from the persona's aliases so a deployment that
  // configures `BOT_MENTION_ALIASES=chord-beta` recognises
  // `/chord-beta pair <code>` instead of `/chord pair`.
  const aliases = getDefaultPersona().mentionAliases;
  const pairMatch = m.text.match(buildPairCommandRegex(aliases));
  if (pairMatch) {
    const force = !!pairMatch[2];
    await handlePairCommand(db, m, pairMatch[1], force);
    return;
  }
  if (buildUnpairCommandRegex(aliases).test(m.text)) {
    await handleUnpairCommand(db, m);
    return;
  }
  // DM bare-code shortcut: in a private chat with the bot, a 4-8 char
  // code (alphanumeric, our pair alphabet) is treated as a pair attempt —
  // no `pair` keyword needed (the explicit `<alias> pair <code>` form is
  // handled above). An optional `replace`/`force` suffix swaps an existing
  // binding without the `/<alias> unpair` dance first.
  //
  // Skip WhatsApp: it has no pair-code flow at all (it onboards via the
  // Google referrer link — ADR 0053), and lots of normal words are 4-8
  // chars, so the shortcut would mis-eat plain messages like "status" as
  // a (failing) pair attempt. Strictly DM-only either way.
  if (m.isPrivate && m.platform !== 'whatsapp') {
    const bareCode = m.text
      .trim()
      .match(/^([A-Z0-9]{4,8})(?:\s+(replace|force))?$/i);
    if (bareCode) {
      const force = !!bareCode[2];
      await handlePairCommand(db, m, bareCode[1].toUpperCase(), force);
      return;
    }
  }

  // Telegram's `@`-autocomplete only matches registered bot usernames,
  // not Chord's text aliases. `/<alias> <text>` is the supported
  // workaround: the Telegram client surfaces a `/` menu and the
  // resulting message arrives as e.g. `/chord add bread to costco list`.
  // We rewrite that to the equivalent @-mention so the rest of the
  // pipeline treats it identically.
  const slashMatch = m.text.match(buildSlashCommandRegex(aliases));
  if (slashMatch) {
    const remainder = (slashMatch[1] ?? '').trim();
    const alias = aliases[0] ?? 'chord';
    m = {
      ...m,
      text: remainder ? `@${alias} ${remainder}` : `@${alias}`,
      mentionsBot: true,
    };
  }

  let groupId = await lookupGroupForChannel(
    db,
    m.platform,
    m.externalChannelId,
  );
  if (!groupId) {
    // Pair-once model: a paired sender on an unbound channel triggers
    // an automatic bind. DM → their personal group; shared → reuse a
    // same-name owned group or create a new one.
    const autoBoundId = await maybeAutoBindForPairedSender(db, m).catch((err) => {
      logger.warn('auto-bind failed', {
        platform: m.platform,
        channel: m.externalChannelId,
        err: (err as Error).message,
      });
      return null;
    });
    // WhatsApp "taster" (ADR 0053): before the app-first gate, let an
    // unsigned WhatsApp stranger use the bot under a shadow account. Returns
    // the (now-bound) personal group to serve into, or null for other
    // platforms / when disabled. The per-turn allowance is enforced at the
    // reaction gate below.
    const tasterGroupId = autoBoundId
      ? null
      : await maybeTasterServe(db, m).catch((err) => {
          logger.warn('whatsapp taster failed', {
            platform: m.platform,
            err: (err as Error).message,
          });
          return null;
        });

    if (autoBoundId) {
      groupId = autoBoundId;
    } else if (tasterGroupId) {
      groupId = tasterGroupId;
    } else {
      // Still unbound: welcome-dm nudges DM strangers; everything else
      // (unpaired sender, shared chat with no paired sender) is dropped.
      const greeted = await maybeWelcomeStranger(db, m).catch((err) => {
        logger.warn('welcome-dm: unexpected error', {
          platform: m.platform,
          err: (err as Error).message,
        });
        return false;
      });
      if (!greeted) {
        logger.info('inbound dropped: unbound channel', {
          platform: m.platform,
          channel: m.externalChannelId,
          isPrivate: m.isPrivate ?? false,
          text: m.text.slice(0, 60),
        });
      }
      return;
    }
  }

  const group = await db
    .selectFrom('groups')
    .select(['id', 'kind', 'mirror_inbound'])
    .where('id', '=', groupId)
    .executeTakeFirst();
  if (!group) {
    logger.warn('inbound dropped: bound group missing', { groupId });
    return;
  }

  // Drop policy:
  //   Shared groups — mirror_inbound=0 (default) and no bot @-mention →
  //   drop entirely. The Chord group stays clean of every bridge chatter;
  //   only bot @-mentions round-trip.
  //   Personal groups — never drop. The user IS the only human, talking
  //   to themselves across two surfaces, and decideReaction will treat
  //   every message as bot-eligible.
  const mirrorInbound = group.mirror_inbound === 1;
  if (group.kind !== 'personal' && !mirrorInbound && !m.mentionsBot) {
    logger.debug('inbound dropped: mirror_inbound=0 + no bot mention', {
      platform: m.platform,
      channel: m.externalChannelId,
    });
    return;
  }

  // Visibility policy:
  //   - personal group: always chord_visible=1. The user is the only
  //     human in the loop, so their Telegram DM and their Chord chat
  //     are two surfaces on one conversation — both should see the
  //     message.
  //   - shared group + non-bot or bot+others: chord_visible=1 (mirrored
  //     normally, gated by mirror_inbound at the drop step above).
  //   - shared group + bot @-mention with no other people mentioned
  //     ("bot-only"): follow the group's mirror_inbound preference, same
  //     as every other message. A bot-only message was still sent in the
  //     shared connector channel, so every member there already saw the
  //     exchange — hiding it only on the Chord surface reads as lost
  //     messages. Mirroring groups (mirror_inbound=1) see the bot thread
  //     too; clean-mirror groups (mirror_inbound=0) still hide the chatter.
  const isBotOnly = m.mentionsBot && !m.mentionsOthers;
  const chordVisible =
    group.kind === 'personal' || !isBotOnly || mirrorInbound ? 1 : 0;

  const sender = await resolveIdentityWithMeta(
    db,
    m.platform,
    m.externalUserId,
    m.externalUserDisplay,
  );
  const userId = sender.userId;
  await ensureMember(db, groupId, userId);

  // Shadow user in a bound shared group who just invoked the bot:
  // post a one-time in-group signup notice ahead of the actual bot
  // reply. Awaited so the notice lands first; the bot's answer to
  // their query lands as a separate follow-up message. (We can't DM
  // them — Telegram bots can't initiate conversations with users who
  // haven't messaged the bot first.) The shadow user's TG profile
  // (display name) was already captured in `resolveIdentity` above.
  if (group.kind !== 'personal') {
    try {
      await maybeAnnounceShadowSignupInGroup(db, m);
    } catch (err) {
      logger.warn('shadow signup notice failed', {
        platform: m.platform,
        externalUserId: m.externalUserId,
        err: (err as Error).message,
      });
    }
  }

  // Persist any inbound attachment (photo/document/voice/video) into
  // Chord's attachment store first, then attach its id to the message
  // so retrieval + bot context see it like a native file upload.
  let attachmentId: string | undefined;
  if (m.attachment) {
    try {
      const att = await saveFile(db, {
        scope: { kind: 'group', groupId },
        uploadedBy: userId,
        filename: m.attachment.filename,
        mimeType: m.attachment.mimeType,
        buffer: m.attachment.bytes,
      });
      attachmentId = att.id;
    } catch (err) {
      logger.warn('inbound: failed to persist attachment', {
        platform: m.platform,
        filename: m.attachment.filename,
        err: (err as Error).message,
      });
    }
  }

  const msg = await postMessage(db, {
    groupId,
    senderId: userId,
    kind: attachmentId ? 'file' : 'text',
    body: m.text,
    attachmentId,
    mentionsBot: m.mentionsBot,
    mentionsOthers: m.mentionsOthers,
    chordVisible,
    source: m.platform,
    externalMessageId: m.externalMessageId,
  });
  if (chordVisible === 1) {
    sseHub.broadcast(groupId, SSE.message, msg);
  }

  // A typed YES / NO to cards just shown here is an answer, not a new request:
  // resolve them like a button press and skip the bot turn.
  if (!attachmentId) {
    const reply = await answerProposalsByReply(db, {
      platform: m.platform,
      externalUserId: m.externalUserId,
      externalChannelId: m.externalChannelId,
      groupId,
      userId,
      messageId: msg.id,
      text: m.text,
    }).catch((err) => {
      logger.warn('connector yes/no answer failed', {
        platform: m.platform,
        err: (err as Error).message,
      });
      return null;
    });
    if (reply) {
      await connectorRegistry
        .getForBinding(m.platform, m.receivedByBotUserId ?? null)
        ?.send({ externalChannelId: m.externalChannelId, body: reply, cards: [] })
        .catch((err) =>
          logger.warn('yes/no answer follow-up send failed', {
            platform: m.platform,
            err: (err as Error).message,
          }),
        );
      return;
    }
  }

  const decision = decideReaction({
    kind: msg.kind,
    senderId: msg.senderId,
    groupKind: group.kind,
    body: msg.body,
    mentionsBot: msg.mentionsBot,
    listeningMode: sender.listeningMode,
    inFollowupWindow: await isWithinFollowupWindow(db, group.id),
  });
  // WhatsApp taster (ADR 0053): once a shadow user has spent their billed
  // allowance, stop running (paid) bot turns and nudge them to sign up
  // instead. The gate lives here — not the binding lookup — so it still
  // fires after the taster bound the channel for outbound delivery.
  if (
    decision.react &&
    m.platform === 'whatsapp' &&
    group.kind === 'personal' &&
    (await tasterState(db, group.id, msg.senderId)).spent
  ) {
    logger.info('whatsapp taster: allowance spent → nudging signup', {
      externalUserId: m.externalUserId,
      limit: env.WHATSAPP_TASTER_TURNS,
    });
    // Re-send the signup nudge on every message past the limit (not just
    // once per cooldown) until the user signs up — ADR 0053.
    await maybeWelcomeStranger(db, m, { alwaysSend: true }).catch((err) => {
      logger.warn('whatsapp taster: gate nudge failed', {
        err: (err as Error).message,
      });
      return false;
    });
    return;
  }
  // ADR 0051 — keep the group's follow-up window in sync with the decision.
  if (decision.followup === 'open') await openFollowupWindow(db, group.id);
  else if (decision.followup === 'consume') await consumeFollowupTurn(db, group.id);
  if (decision.react) {
    reactToMessage(
      db,
      msg,
      group,
      sender.lastTz ?? undefined,
      {
        platform: m.platform,
        externalChannelId: m.externalChannelId,
        botUserId: m.receivedByBotUserId ?? null,
      },
      chordVisible,
    );
  } else if (decision.passiveExtract) {
    passivelyExtractFromMessage(db, msg, group);
  }
}

/**
 * Auto-bind only fires for a paired sender's DM with the bot — the user
 * is the same Chord identity on both sides, so binding the DM to their
 * personal group is unambiguous and lossless. Shared chats require an
 * explicit `/<alias> pair <code>`; Telegram doesn't let bots enumerate
 * the chat's members, so any heuristic group match would be a guess.
 */
async function maybeAutoBindForPairedSender(
  db: Kysely<DB>,
  m: InboundMessage,
): Promise<string | null> {
  if (!m.isPrivate) return null;

  const id = await lookupIdentity(db, m.platform, m.externalUserId);
  let userId: string;
  if (!id || id.shadow) {
    // Demo-mode escape hatch: no Google OAuth means strangers can't
    // sign up to pair. Auto-provision a real Chord user keyed to
    // their TG identity so the DM bind below can proceed. Never under
    // AUTH_MODE=google — that'd bypass the app-first identity gate.
    if (env.AUTH_MODE !== 'demo') return null;
    userId = await autoProvisionDemoUser(
      db,
      m.platform,
      m.externalUserId,
      m.externalUserDisplay,
    );
    logger.info('auto-bind: provisioned demo user', {
      platform: m.platform,
      externalUserId: m.externalUserId,
      userId,
    });
  } else {
    userId = id.userId;
  }

  const personal = await db
    .selectFrom('groups')
    .select('id')
    .where('kind', '=', 'personal')
    .where('created_by', '=', userId)
    .executeTakeFirst();
  if (!personal) {
    logger.warn('auto-bind: paired user has no personal group', { userId });
    return null;
  }

  // A personal group has at most one current DM surface per platform.
  // If a stale binding already holds the canonical alias for this
  // platform (e.g. the user switched bots, replaced their TG account,
  // or a previous test left a row pointing at a different chat id),
  // wipe it before inserting the new one — otherwise the
  // (group_id, alias) unique index throws. The bind we're about to
  // make IS the user's current DM, so the old row is by definition
  // stale.
  await db
    .deleteFrom('group_external_channels')
    .where('group_id', '=', personal.id)
    .where('platform', '=', m.platform)
    .where('alias', '=', m.platform)
    .where('external_channel_id', '!=', m.externalChannelId)
    .execute();

  await bindChannel(
    db,
    m.platform,
    m.externalChannelId,
    personal.id,
    m.platform,
  );
  logger.info('auto-bind: DM linked to personal group', {
    platform: m.platform,
    userId,
    groupId: personal.id,
  });
  return personal.id;
}

/**
 * WhatsApp "taster" (ADR 0053): let an unsigned WhatsApp stranger use the
 * bot under a shadow account for up to `WHATSAPP_TASTER_TURNS` billed turns
 * before the app-first gate takes over. WhatsApp is paid per conversation +
 * LLM, so the cap bounds the cost/abuse the hard gate protected against; the
 * welcome nudge (with a signup ref) then handles them, and the shadow's data
 * merges into the real account on Google sign-in (`consumeSignupIntent` →
 * `mergeOrLinkExternalIdentity`).
 *
 * Binds the channel to the shadow's personal group so the bot's reply
 * actually reaches WhatsApp — the outbound publisher routes by binding. The
 * per-turn allowance is NOT enforced here; it's checked at the reaction gate
 * (`tasterState().spent`), which runs for bound channels too, so binding
 * doesn't bypass the limit. On Google sign-in the shadow (and this binding,
 * which points at a group the merge re-attributes) fold into the real account.
 *
 * Returns the shadow's personal group, or null to fall through to the gate
 * (non-WhatsApp, not a DM, disabled, or already a real/paired identity).
 */
async function maybeTasterServe(
  db: Kysely<DB>,
  m: InboundMessage,
): Promise<string | null> {
  if (m.platform !== 'whatsapp') return null;
  if (!m.isPrivate) return null;
  if (env.WHATSAPP_TASTER_TURNS <= 0) return null; // disabled → hard app-first gate

  const id = await lookupIdentity(db, m.platform, m.externalUserId);
  if (id && !id.shadow) return null; // real (paired) user → handled by auto-bind

  const userId =
    id?.userId ??
    (await resolveIdentity(
      db,
      m.platform,
      m.externalUserId,
      m.externalUserDisplay,
    ));
  const personal = await ensurePersonalGroup(db, userId);
  await bindChannel(db, m.platform, m.externalChannelId, personal.id, m.platform);
  return personal.id;
}

/**
 * ADR 0053 §7 — handle a quick-reply button tap. Routes the `verb:id`
 * payload through the shared callback handler (proposal confirm/reject,
 * membership-checked) and posts the outcome back as a follow-up message.
 * WhatsApp can't edit the original to grey out the buttons, so the follow-up
 * IS the resolution feedback; a stale tap on an already-resolved proposal
 * gets an idempotent "Already resolved." from the handler.
 */
async function handleButtonTap(
  db: Kysely<DB>,
  m: InboundMessage,
): Promise<void> {
  const result = await handleCallback(db, {
    platform: m.platform,
    externalUserId: m.externalUserId,
    receivedByBotUserId: m.receivedByBotUserId ?? null,
    data: m.buttonPayload ?? '',
  });
  const conn = connectorRegistry.getForBinding(
    m.platform,
    m.receivedByBotUserId ?? null,
  );
  if (!conn) return;
  await conn
    .send({
      externalChannelId: m.externalChannelId,
      body: result.toast,
      cards: [],
      // ADR 0091 — a delivered briefing overflows WhatsApp's 1600-char cap;
      // give the clip somewhere to point.
      moreUrl: result.groupId ? appDeepLink(`/groups/${result.groupId}`) || undefined : undefined,
    })
    .catch((err) =>
      logger.warn('button tap follow-up send failed', {
        platform: m.platform,
        err: (err as Error).message,
      }),
    );
}

async function ensureMember(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<void> {
  const existing = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role: 'member',
      tier: 'guest',
      joined_at: new Date().toISOString(),
    })
    .execute();
}

async function handlePairCommand(
  db: Kysely<DB>,
  m: InboundMessage,
  code: string,
  force = false,
): Promise<void> {
  const receivedByBotUserId = m.receivedByBotUserId ?? null;
  const connector =
    connectorRegistry.getForBinding(m.platform, receivedByBotUserId) ??
    connectorRegistry.getDeployWide(m.platform);
  const result = await consumePairingCode(db, {
    code,
    platform: m.platform,
    externalChannelId: m.externalChannelId,
    externalDisplay: m.externalChannelDisplay ?? m.externalUserDisplay,
    receivedByBotUserId,
    externalUserId: m.externalUserId,
    externalUserDisplay: m.externalUserDisplay,
    force,
  });

  if (!result.ok) {
    logger.info('pair command rejected', {
      platform: m.platform,
      code,
      channel: m.externalChannelId,
      reason: result.reason,
    });
    // Stay silent for reasons that mean "this pair command is not for
    // me": either the code is absent from this bot's DB (`unknown_code`)
    // or it was minted for a different bot (`wrong_bot`). When multiple
    // bots share a chat — two app instances, or a deploy-wide bot
    // alongside a BYO bot — only the addressed bot should reply.
    if (result.reason === 'unknown_code' || result.reason === 'wrong_bot') {
      return;
    }
    const persona = getDefaultPersona();
    const slash = `/${persona.mentionAliases[0]} pair`;
    let message: string;
    if (result.reason === 'channel_already_bound') {
      const existing = await db
        .selectFrom('groups')
        .select(['name'])
        .where('id', '=', result.existingGroupId)
        .executeTakeFirst();
      const existingName = existing?.name ?? `another ${persona.displayName} group`;
      message =
        `This chat is already paired to ${persona.displayName} group "${existingName}". ` +
        `To switch, run \`${slash} ${code} replace\` — that discards the old binding and ` +
        `pairs this chat to the new group. (Or \`/${persona.mentionAliases[0]} unpair\` ` +
        `first if you'd rather disconnect cleanly.)`;
    } else if (result.reason === 'alias_taken') {
      message = `That bridge alias is already in use in the ${persona.displayName} group. Pick a different alias from the ${persona.displayName} app and try again.`;
    } else {
      message = `That pairing code has expired. Get a fresh one from the ${persona.displayName} app.`;
    }
    if (connector) {
      await connector
        .send({ externalChannelId: m.externalChannelId, body: message, cards: [] })
        .catch((err) =>
          logger.warn('pair command: failed reply send', { err }),
        );
    }
    return;
  }

  // Success — fetch the group name for a friendly confirmation, then
  // broadcast `connector.bound` so the mobile group-settings UI flips
  // to the connected state without polling.
  const group = await db
    .selectFrom('groups')
    .select(['name'])
    .where('id', '=', result.groupId)
    .executeTakeFirst();
  const groupName = group?.name ?? `${getDefaultPersona().displayName} group`;

  sseHub.broadcast(result.groupId, SSE.connectorBound, {
    platform: m.platform,
    externalChannelId: m.externalChannelId,
    externalDisplay: m.externalChannelDisplay ?? m.externalUserDisplay ?? null,
  });

  if (connector) {
    const meta = connector.getPairingMetadata?.();
    const handle = meta?.botUsername ? `@${meta.botUsername}` : 'me';
    await connector
      .send({
        externalChannelId: m.externalChannelId,
        body:
          `Connected to ${getDefaultPersona().displayName} group "${groupName}". Mention ${handle} ` +
          `when you want me to chime in.`,
        cards: [],
      })
      .catch((err) =>
        logger.warn('pair command: failed confirmation send', { err }),
      );
  }
  logger.info('connector binding established via pair flow', {
    platform: m.platform,
    groupId: result.groupId,
    channel: m.externalChannelId,
  });
}

/**
 * `/chord unpair` — recover from a stale or wrong-bot binding without
 * the app. Removes the binding for this channel (if any) and posts a
 * one-line ack. The Chord group itself stays — only the bridge is cut.
 * Any in-channel participant can run this; the bridge is mutual by
 * definition (anyone who can read can also disconnect).
 */
async function handleUnpairCommand(
  db: Kysely<DB>,
  m: InboundMessage,
): Promise<void> {
  const receivedByBotUserId = m.receivedByBotUserId ?? null;
  const connector =
    connectorRegistry.getForBinding(m.platform, receivedByBotUserId) ??
    connectorRegistry.getDeployWide(m.platform);
  const groupId = await lookupGroupForChannel(
    db,
    m.platform,
    m.externalChannelId,
  );
  if (!groupId) {
    if (connector) {
      await connector
        .send({
          externalChannelId: m.externalChannelId,
          body: `This chat isn't paired to a ${getDefaultPersona().displayName} group.`,
          cards: [],
        })
        .catch((err) => logger.warn('unpair: ack send failed', { err }));
    }
    return;
  }
  await unbindChannel(db, m.platform, m.externalChannelId);
  sseHub.broadcast(groupId, SSE.connectorUnbound, {
    platform: m.platform,
    externalChannelId: m.externalChannelId,
  });
  if (connector) {
    await connector
      .send({
        externalChannelId: m.externalChannelId,
        body: `Disconnected from the ${getDefaultPersona().displayName} group. Run /${getDefaultPersona().mentionAliases[0]} pair <code> to reconnect.`,
        cards: [],
      })
      .catch((err) => logger.warn('unpair: ack send failed', { err }));
  }
  logger.info('connector binding removed via /unpair', {
    platform: m.platform,
    groupId,
    channel: m.externalChannelId,
  });
}

export const __testing = { maybeTasterServe };
