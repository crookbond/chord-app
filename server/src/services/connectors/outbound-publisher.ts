/**
 * Forwards messages from Chord groups out to bound external IM channels
 * (ADR 0010).
 *
 * Mirroring rules (post-app-first):
 *   - Any text, bot reply, or file message in a Chord group that has at
 *     least one external binding mirrors out to those bindings. Both
 *     personal and shared groups are fully bi-directional: Alice typing
 *     in the Chord app on a paired shared group lands in Telegram, and
 *     vice versa.
 *   - File messages (`kind='file'`) load the attachment row and pass
 *     bytes through to the connector via `OutboundMessage.attachment`.
 *
 * Loop prevention:
 *   - Messages whose `source` is a connector (`telegram` / `slack` /
 *     `discord`) are never re-emitted (would loop right back).
 *   - `auto_mirror=0` on a Chord message short-circuits emission (the
 *     relay tool uses this when it explicitly targeted Chord).
 *   - Bot replies in shared groups whose trigger was a bot-only
 *     mention (mentions_bot=1, mentions_others=0) stay internal — the
 *     user was talking privately to the bot, no need to broadcast.
 */
import type { Kysely } from 'kysely';

import { SSE } from '@chord/kernel';
import type { BotCard, Message } from '@chord/kernel';

import { env } from '../../config/env';
import { logger } from '../../config/logging';
import { isScheduledBriefing } from '../../db/schema';
import type { DB } from '../../db/schema';
import { runInBackground } from '../../utils/background';
import { mapConcurrent } from '../../utils/concurrency';
import { isLeader } from '../cluster/leadership';
import { sseHub } from '../sse.hub';
import { listBindingsForGroup } from './channel-resolver';
import type { ConnectorRegistryView } from './registry-view';
import type { Connector } from './types';
import { gateProactiveSend, markPrompted } from './whatsapp/session-window';
import { tasterFooter, tasterState, withFooter } from './whatsapp/taster';
import { buildSignupLink } from './welcome-dm.service';
import { mintSignupIntent } from './signup-intents.service';
import { buildBriefingFacts } from '../briefing/facts';
import { templateParams } from '../briefing/render';

const CONNECTOR_SOURCES = new Set(['telegram', 'slack', 'discord', 'whatsapp']);

/**
 * Where "Read more" points when a platform's length cap forces a clip.
 *
 * The web origin, not the `chord://` scheme: a bridged surface renders this as
 * bare text, and WhatsApp/Telegram only linkify http(s). On iOS the app claims
 * it as a Universal Link (`/groups/*` is registered in the AASA file); on
 * Android it opens the browser until `assetlinks.json` carries a real release
 * fingerprint (ADR 0081), and on the web it is just the app.
 */
export function appDeepLink(path: string): string {
  const origin = (env.WEB_ORIGIN || env.SIGNUP_URL).trim().replace(/\/$/, '');
  if (!origin) return '';
  try {
    return `${new URL(origin).origin}${path.startsWith('/') ? path : `/${path}`}`;
  } catch {
    return '';
  }
}

function groupDeepLink(groupId: string): string {
  return appDeepLink(`/groups/${groupId}`);
}

/**
 * The out-of-window nudge template for the ACTIVE provider (ADR 0089 + 0090).
 *
 * Twilio addresses a template by Content SID, Meta by name, so reading only
 * one of them makes the gate lie: under `WHATSAPP_PROVIDER=cloud` a perfectly
 * configured `META_NUDGE_TEMPLATE_NAME` would look absent and every
 * out-of-window briefing would be skipped as `no_template`.
 *
 * Empty means genuinely unconfigured — the gate then stays quiet rather than
 * attempting a send Meta will reject.
 */
export function nudgeTemplateRef(): string {
  return env.WHATSAPP_PROVIDER === 'cloud'
    ? env.META_NUDGE_TEMPLATE_NAME
    : env.TWILIO_NUDGE_TEMPLATE_SID;
}

/** Twilio's single `{{1}}` slot. Its Content API interleaves body and button
 *  variables in one numbering scheme, so it cannot carry the five-slot body
 *  Meta gets (ADR 0091) — it keeps the generic ask. */
const NUDGE_PROMPT = 'Good morning! Want your daily briefing?';

/**
 * Send the out-of-window briefing on the approved template and park the full
 * one until the user asks for it.
 *
 * ADR 0089 sent a bare "want your briefing?" here. ADR 0091 fills the template
 * with the day's actual facts instead: the same single billed conversation now
 * carries real content plus links, and the `Full briefing` button still reopens
 * the window to deliver the complete text for free. The buttons carry ADR 0029
 * `verb:id` payloads so a tap routes through the shared callback handler rather
 * than the LLM.
 */
async function sendBriefingTemplate(
  db: Kysely<DB>,
  conn: Connector,
  opts: {
    externalChannelId: string;
    groupId: string;
    messageId: string;
    userId: string | null;
  },
): Promise<void> {
  let params: string[] | undefined;
  if (opts.userId) {
    try {
      params = templateParams(await buildBriefingFacts(db, opts.userId));
    } catch (err) {
      // A facts failure must not cost the user their one ask — fall back to
      // the generic prompt, which every provider can still render.
      logger.warn('whatsapp: briefing facts failed, sending generic prompt', { err });
    }
  }
  try {
    await conn.send({
      externalChannelId: opts.externalChannelId,
      body: NUDGE_PROMPT,
      contentSid: nudgeTemplateRef(),
      templateParams: params,
      cards: [
        {
          kind: 'action',
          title: NUDGE_PROMPT,
          buttons: [
            { label: 'Full briefing', callback: { verb: 'n+', id: 'briefing' } },
            { label: 'Stop these', callback: { verb: 'n-', id: 'briefing' } },
          ],
        },
      ],
    });
  } catch (err) {
    // ADR 0099 — a mis-configured template is a config bug, and it used to
    // surface as a generic warn from the caller's catch, indistinguishable
    // from a transport hiccup. Name what has to change.
    //
    // Deliberately does NOT markPrompted: `nudge_prompt_sent_at` means "asked
    // and unanswered", which ADR 0089 §6 reads as permission to stay quiet
    // until the ask expires. We never asked, so tomorrow must retry.
    logger.error('whatsapp: briefing template rejected — briefing NOT delivered', {
      template: nudgeTemplateRef(),
      language:
        env.WHATSAPP_PROVIDER === 'cloud' ? env.META_NUDGE_TEMPLATE_LANG : undefined,
      provider: env.WHATSAPP_PROVIDER,
      channel: opts.externalChannelId,
      err: (err as Error).message,
      hint: 'name AND language must both match an approved template; Meta 132001 means the name resolved but that language did not',
    });
    return;
  }
  // Only after the send succeeds: a throw here must not consume the one ask
  // the user gets, nor strand the briefing as delivered-but-unsent.
  await markPrompted(db, opts);
}

/**
 * ADR 0029 — remember that a Chord message reached an external chat. Also
 * what a typed YES / NO there is checked against (`reply-answer.ts`): only
 * cards recorded here were ever shown on that chat.
 */
export async function recordConnectorSend(
  db: Kysely<DB>,
  s: {
    chordMessageId: string;
    platform: string;
    externalChannelId: string;
    externalMessageId: string;
    botUserId: string | null;
  },
): Promise<void> {
  await db
    .insertInto('outbound_connector_messages')
    .values({
      chord_message_id: s.chordMessageId,
      platform: s.platform,
      external_channel_id: s.externalChannelId,
      external_message_id: s.externalMessageId,
      bot_user_id: s.botUserId,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc
        .columns(['chord_message_id', 'platform', 'external_channel_id'])
        .doUpdateSet({
          external_message_id: s.externalMessageId,
          bot_user_id: s.botUserId,
        }),
    )
    .execute();
}

/**
 * Look up persisted BotCards for a bot reply so connectors can render
 * them in their platform-native form. Returns an empty array for
 * non-bot messages or when the cards row is missing/malformed.
 */
async function loadCards(db: Kysely<DB>, msg: Message): Promise<BotCard[]> {
  if (msg.kind !== 'bot') return [];
  const row = await db
    .selectFrom('message_cards')
    .select('cards_json')
    .where('message_id', '=', msg.id)
    .executeTakeFirst();
  if (!row?.cards_json) return [];
  try {
    return JSON.parse(row.cards_json) as BotCard[];
  } catch {
    return [];
  }
}

export function startOutboundPublisher(
  db: Kysely<DB>,
  registry: ConnectorRegistryView,
): () => void {
  return sseHub.onBroadcast((channel, event, data) => {
    if (event !== SSE.message) return;
    // ADR 0280 — every web copy hears every broadcast; one of them forwards.
    if (!isLeader('im')) return;
    const msg = data as Message;
    // System messages never mirror; everything else (text, bot, file)
    // is eligible. The forward() helper applies loop prevention and
    // the bot-only-mention private rule.
    if (msg.kind !== 'bot' && msg.kind !== 'text' && msg.kind !== 'file') {
      return;
    }

    runInBackground(
      forward(db, registry, channel, msg).catch((err) =>
        logger.warn('outbound publisher: forward crashed', { err }),
      ),
    );
  });
}

async function forward(
  db: Kysely<DB>,
  registry: ConnectorRegistryView,
  groupId: string,
  msg: Message,
): Promise<void> {
  // Gate on the cheapest indexed lookup FIRST: forward() fires for every
  // broadcast app-wide, but the overwhelming common case is a group with no
  // connector binding. Everything below (loop-prevention, bot-only rule,
  // cards, sender, attachment) is unreachable when there's nothing to send,
  // so don't pay those queries just to discover bindings is empty.
  const bindings = await listBindingsForGroup(db, groupId);
  if (bindings.length === 0) return;

  // Loop prevention: a message that came in from a connector must not
  // be re-emitted. Also picks up the per-message `auto_mirror=0`
  // override the relay tool uses.
  const self = await db
    .selectFrom('messages')
    .select(['auto_mirror', 'source', 'is_proactive', 'proactive_kind'])
    .where('id', '=', msg.id)
    .executeTakeFirst();
  if (self?.auto_mirror === 0) return;
  if (self?.source && CONNECTOR_SOURCES.has(self.source)) return;
  const isProactive = Number(self?.is_proactive ?? 0) === 1;
  // ADR 0137 — WHICH proactive message this is. `is_proactive` alone cannot
  // answer whether the out-of-window briefing template may be spent on it.
  const isBriefing = isProactive && isScheduledBriefing(self?.proactive_kind);

  // Shared-group bot-only mention rule: when the bot replies to a
  // mention that only addressed itself (no other humans tagged), keep
  // the exchange private to the Chord side. Personal groups bypass
  // this — the user IS the only human in the loop.
  if (msg.kind === 'bot') {
    const group = await db
      .selectFrom('groups')
      .select(['kind'])
      .where('id', '=', groupId)
      .executeTakeFirst();
    const isPersonal = group?.kind === 'personal';
    if (!isPersonal && msg.replyToId) {
      const trigger = await db
        .selectFrom('messages')
        .select(['mentions_bot', 'mentions_others'])
        .where('id', '=', msg.replyToId)
        .executeTakeFirst();
      if (
        trigger &&
        trigger.mentions_bot === 1 &&
        trigger.mentions_others === 0
      ) {
        return;
      }
    }
  }

  const cards = await loadCards(db, msg);

  // Look up the human sender's display name for text/file messages so
  // the rendered body on the external surface is attributed to them.
  // Bot APIs only let us post as the bot account, so without this every
  // bridged user message would look like it came from the bot.
  let senderName: string | undefined;
  if ((msg.kind === 'text' || msg.kind === 'file') && msg.senderId) {
    const sender = await db
      .selectFrom('users')
      .select(['display_name', 'username'])
      .where('id', '=', msg.senderId)
      .executeTakeFirst();
    senderName = sender?.display_name ?? sender?.username ?? undefined;
  }

  // Resolve attachment metadata once (used for kind='file' messages).
  let attachment: { path: string; filename: string; mimeType: string } | undefined;
  if (msg.kind === 'file' && msg.attachmentId) {
    const row = await db
      .selectFrom('attachments')
      .select(['path', 'filename', 'mime_type'])
      .where('id', '=', msg.attachmentId)
      .executeTakeFirst();
    if (row) {
      attachment = {
        path: row.path,
        filename: row.filename,
        mimeType: row.mime_type,
      };
    } else {
      logger.warn('outbound: attachment row missing for file message', {
        messageId: msg.id,
      });
    }
  }

  // ADR 0053 — a taster's answers carry the connect prompt, so the ask
  // arrives while the bot is being useful rather than only at the wall.
  // Resolved per binding: the referrer token is scoped to the WhatsApp
  // channel, which for a 1:1 IS the user.
  const taster =
    msg.kind === 'bot' && !isProactive && bindings.some((b) => b.platform === 'whatsapp')
      ? await tasterState(db, groupId, await personalGroupOwner(db, groupId))
      : null;

  // Each binding sends to a different external channel independently — no
  // early exit or shared counter depends on one binding's outcome, so fan
  // these out instead of paying N sequential round trips per broadcast (the
  // hottest fan-out path in the connector layer).
  await mapConcurrent(bindings, 5, async (b) => {
    const conn = registry.getForBinding(b.platform, b.botUserId);
    if (!conn) return;
    try {
      let body = msg.body;
      if (taster?.applies && b.platform === 'whatsapp') {
        // `used` already counts the reply going out, so it IS the turn number.
        const footer = await tasterFooterFor(db, b.externalChannelId, taster.used, taster.limit);
        body = withFooter(body, footer);
      }
      // ADR 0089 — WhatsApp only delivers free-form text inside the 24h window
      // the user opens. The briefing routinely falls outside it, so send the
      // approved template instead and park it. Any OTHER proactive kind is
      // simply skipped out of window (ADR 0137) rather than borrowing the
      // briefing's ask. Replies are never gated: the user just wrote.
      if (isProactive && b.platform === 'whatsapp') {
        const gate = await gateProactiveSend(db, {
          externalChannelId: b.externalChannelId,
          groupId,
          hasTemplate: !!nudgeTemplateRef(),
          isBriefing,
        });
        if (gate.action === 'skip') {
          logger.info('whatsapp: proactive send skipped', {
            reason: gate.reason,
            kind: self?.proactive_kind ?? null,
            channel: b.externalChannelId,
          });
          return;
        }
        if (gate.action === 'prompt') {
          await sendBriefingTemplate(db, conn, {
            externalChannelId: b.externalChannelId,
            groupId,
            messageId: msg.id,
            userId: await personalGroupOwner(db, groupId),
          });
          return;
        }
      }
      const result = await conn.send({
        externalChannelId: b.externalChannelId,
        body,
        cards,
        attachment,
        senderName,
        moreUrl: groupDeepLink(groupId) || undefined,
      });
      // ADR 0029 — remember the external_message_id so downstream code
      // (proposal-resolution notifier) can later edit the message. We
      // only record when the connector actually surfaced an id; null
      // means "platform doesn't return one yet" — log-only.
      if (result?.externalMessageId) {
        await recordConnectorSend(db, {
          chordMessageId: msg.id,
          platform: b.platform,
          externalChannelId: b.externalChannelId,
          externalMessageId: result.externalMessageId,
          botUserId: b.botUserId,
        });
      }
    } catch (err) {
      const cause = (err as { cause?: unknown })?.cause;
      logger.warn('connector send failed', {
        message: (err as Error).message,
        cause:
          cause instanceof Error
            ? { name: cause.name, message: cause.message, code: (cause as { code?: string }).code }
            : cause,
        bodyLen: msg.body.length,
        cardCount: cards.length,
        hasAttachment: !!attachment,
        platform: b.platform,
        channel: b.externalChannelId,
        botUserId: b.botUserId,
        err,
      });
    }
  });
}

/** The owner a personal group's taster allowance is charged to. */
async function personalGroupOwner(
  db: Kysely<DB>,
  groupId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('groups')
    .select(['created_by', 'kind'])
    .where('id', '=', groupId)
    .executeTakeFirst();
  return row?.kind === 'personal' ? row.created_by : null;
}

/**
 * Footer for this turn, with a referrer token minted against the WhatsApp
 * channel so the link soft-links the identity on sign-in (ADR 0031 / 0053).
 * Minting is idempotent — an open intent is reused, not forked.
 */
async function tasterFooterFor(
  db: Kysely<DB>,
  externalChannelId: string,
  turn: number,
  limit: number,
): Promise<string | null> {
  try {
    const ref = await mintSignupIntent(db, 'whatsapp', externalChannelId);
    return tasterFooter(turn, limit, buildSignupLink(ref));
  } catch (err) {
    // A footer is never worth failing a reply over.
    logger.warn('whatsapp taster: footer mint failed', {
      err: (err as Error).message,
    });
    return null;
  }
}
