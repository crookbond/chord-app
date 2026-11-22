/**
 * Welcome-DM gate for strangers who DM the bot before pairing.
 *
 * Chord is app-first: a Telegram user must (1) sign up at SIGNUP_URL
 * via Google OAuth, then (2) paste the pair code from
 * Settings → Connectors → Telegram into a DM with the bot. Until that
 * happens the bot does nothing else in DM — no LLM turn, no memory
 * writes, no message persistence.
 *
 * Decision rules:
 *   - Only fires for 1-on-1 DMs (`m.isPrivate === true`). Group/channel
 *     messages from unbound chats stay silent — replying there would be
 *     noisy for unrelated participants.
 *   - Paired (`external_identities` → real user) → return false; caller
 *     handles auto-bind + normal pipeline.
 *   - Unknown → one-shot signup nudge, gated by the existing
 *     `connector_dm_greeted` cooldown. `/start` always re-greets so
 *     re-discovery works.
 *   - Returns `true` when handled (so the inbound pipeline knows to stop;
 *     no shadow user, no message row).
 *   - Send is best-effort: a connector send failure is logged but does
 *     not throw; we never block the inbound pipeline for a greet.
 */
import type { Kysely } from 'kysely';

import type { BotCard } from '@chord/kernel';

import { env } from '../../config/env';
import { logger } from '../../config/logging';
import type { DB } from '../../db/schema';
import { lookupIdentity } from './identity-resolver';
import { connectorRegistry } from './registry';
import { mintSignupIntent, supportsReferrerFlow } from './signup-intents.service';
import type { ConnectorPlatform, InboundMessage } from './types';

const START_CMD_RE = /^\/start(?:@\w+)?(?:\s|$)/i;

export async function maybeWelcomeStranger(
  db: Kysely<DB>,
  m: InboundMessage,
  opts: { alwaysSend?: boolean } = {},
): Promise<boolean> {
  if (!env.WELCOME_DM_ENABLED) return false;
  if (!m.isPrivate) return false;

  // Already paired (real user): let the caller's auto-bind + normal
  // pipeline handle it. Under AUTH_MODE=demo the caller's auto-bind
  // step provisions an account first, so we never reach this responder
  // for an unknown DM in demo mode.
  const id = await lookupIdentity(db, m.platform, m.externalUserId);
  if (id && !id.shadow) return false;

  // `alwaysSend` (WhatsApp taster-spent gate, ADR 0053): re-send the
  // signup nudge on every incoming message until the user signs up,
  // bypassing the once-per-cooldown gate below. The taster has already
  // had its free turns; the only useful reply now is "go sign up".
  const isStart = START_CMD_RE.test(m.text);
  if (!isStart && !opts.alwaysSend) {
    const cooldownMs = env.WELCOME_DM_REGREET_DAYS * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - cooldownMs).toISOString();
    const recent = await db
      .selectFrom('connector_dm_greeted')
      .select('greeted_at')
      .where('platform', '=', m.platform)
      .where('external_user_id', '=', m.externalUserId)
      .where('greeted_at', '>=', since)
      .executeTakeFirst();
    if (recent) {
      // Still gated as "handled" so the inbound pipeline drops the
      // message rather than falling through to persistence.
      return true;
    }
  }

  const conn = connectorRegistry.getForBinding(
    m.platform,
    m.receivedByBotUserId ?? null,
  );
  if (!conn) {
    logger.debug('welcome-dm: no connector registered, skipping', {
      platform: m.platform,
      botUserId: m.receivedByBotUserId,
    });
    return true;
  }

  // Mint (or reuse) a referrer token so the user can sign up without
  // copy/pasting a pair code. Failure is non-fatal — we fall back to the
  // bare signup URL (Telegram users can still pair via /chord pair
  // afterwards). ADR 0031 (Telegram) / ADR 0053 (WhatsApp).
  let signupRef: string | null = null;
  if (supportsReferrerFlow(m.platform)) {
    try {
      signupRef = await mintSignupIntent(db, m.platform, m.externalUserId);
    } catch (err) {
      logger.warn('welcome-dm: signup-intent mint failed', {
        platform: m.platform,
        externalUserId: m.externalUserId,
        err: (err as Error).message,
      });
    }
  }

  try {
    await conn.send({
      externalChannelId: m.externalChannelId,
      body: renderWelcome(signupRef, m.platform),
      cards: signupActionCards(signupRef),
    });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn('welcome-dm: send failed', {
      platform: m.platform,
      externalUserId: m.externalUserId,
      err: msg,
      hint: msg.includes("can't initiate conversation")
        ? 'user has not started a chat with this bot — they must tap Start in Telegram first'
        : undefined,
    });
    // Still treat as handled so we don't spam other code paths.
    return true;
  }

  const now = new Date().toISOString();
  await db
    .insertInto('connector_dm_greeted')
    .values({
      platform: m.platform,
      external_user_id: m.externalUserId,
      greeted_at: now,
    })
    .onConflict((oc) =>
      oc
        .columns(['platform', 'external_user_id'])
        .doUpdateSet({ greeted_at: now }),
    )
    .execute();

  logger.info('welcome-dm: nudged stranger', {
    platform: m.platform,
    externalUserId: m.externalUserId,
    triggeredByStart: isStart,
  });
  return true;
}

function renderWelcome(
  signupRef: string | null,
  platform: ConnectorPlatform = 'telegram',
): string {
  const link = buildSignupLink(signupRef);
  // WhatsApp (ADR 0053): the only time a stranger sees this nudge is once
  // their taster allowance is spent — so the copy is the "quota used →
  // sign up" message, re-sent on every subsequent message until they do.
  if (platform === 'whatsapp') {
    // Not "you've used your quota" — that reads as a paywall, and this is an
    // account gate. It also has to speak to someone who ALREADY has Chord:
    // the common case is a signed-up user writing from a number we can't yet
    // tie to them, for whom "sign up" is the wrong instruction (ADR 0053).
    return link
      ? `I can't answer here until this chat is connected to a Chord account. ` +
        `Already have one? This link connects it. If not, it'll set one up: ${link}`
      : `I can't answer here until this chat is connected to a Chord account ` +
        `(setup URL coming soon).`;
  }
  const head = `Hi — I'm Chord. I work alongside your Chord account.`;
  // "Sign up" is the wrong instruction for the many strangers who already
  // have Chord and are simply writing from an account we can't tie to them.
  const signupLine = link
    ? `1. Open Chord at ${link} — sign in, or create an account`
    : `1. Open the Chord app (URL coming soon) — sign in, or create an account`;
  // With a referrer token, Google sign-in auto-links your Chord account
  // to this chat — no pair-code paste needed. The fallback (no token)
  // differs by platform: Telegram has the `/chord pair` paste path;
  // WhatsApp has no pair code, so it just points back to sign-in.
  const pairLine = signupRef
    ? `2. Sign in with Google and you're done — this chat will start mirroring to your Chord automatically.`
    : platform === 'telegram'
      ? `2. In the app, open Settings → Connectors → Telegram and paste me the pair code here.`
      : `2. In the app, sign in with Google to finish linking this chat.`;
  return [head, '', signupLine, pairLine].join('\n');
}

function renderShadowGroupSignupNudge(): string {
  // In-group nudge can't carry a referrer token: the linker is the TG
  // user but they're not DM'ing the bot, so we have no DM channel
  // to capture the link click against. They get the pair-code path.
  const link = env.SIGNUP_URL.trim();
  const head = `Hi — happy to help here. You can keep using me in this group as-is. To get your own Chord (saves, lists, reminders, calendar across your groups):`;
  const signupLine = link
    ? `1. Open Chord at ${link} — sign in, or create an account`
    : `1. Open the Chord app (URL coming soon) — sign in, or create an account`;
  const pairLine = `2. Open the app's Settings → Connectors → Telegram, copy the pair code, then DM me that code from your personal chat with me (not here).`;
  return [head, '', signupLine, pairLine].join('\n');
}

export function buildSignupLink(signupRef: string | null): string {
  const base = env.SIGNUP_URL.trim().replace(/\/$/, '');
  if (!base) return '';
  if (!signupRef) return base;
  // Path form `/welcome/<ref>` (not `?ref=`) so the link is a claimed
  // universal/app-link path that opens the native app, not just web
  // (ADR 0048 / 0053). The web build resolves the same route. Requires
  // SIGNUP_URL to be the verified apex (https://chordapp.ai) for native
  // deep-linking; any host still works on web.
  return `${base}/welcome/${encodeURIComponent(signupRef)}`;
}

/**
 * One-time in-group signup notice the first time a shadow Telegram user
 * actually invokes the bot in a bound shared group. The notice is posted
 * to the *same group* (Telegram ToS forbids bots from initiating DMs
 * with users who haven't started a chat with the bot first, so the
 * previous DM-based nudge often silently failed). Sent before the bot
 * answers the user's actual query — they see "here's how to sign up"
 * once, then the answer to what they asked.
 *
 * Gated on:
 *   - shadow=1 (signed-up users don't need this)
 *   - mentionsBot (only fires when the user invokes Chord, not on every
 *     ambient message in the group)
 *   - not a DM (`isPrivate=false`); DMs run the stranger-welcome path
 *   - `connector_dm_greeted` cooldown (one notice per cooldown window)
 *
 * Returns `true` when a notice was actually sent, so callers can choose
 * to gate dependent work; today the inbound pipeline just awaits and
 * proceeds either way.
 */
export async function maybeAnnounceShadowSignupInGroup(
  db: Kysely<DB>,
  m: InboundMessage,
): Promise<boolean> {
  if (!env.WELCOME_DM_ENABLED) return false;
  if (m.isPrivate) return false;
  if (!m.mentionsBot) return false;

  const id = await lookupIdentity(db, m.platform, m.externalUserId);
  if (!id || !id.shadow) return false;

  const cooldownMs = env.WELCOME_DM_REGREET_DAYS * 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - cooldownMs).toISOString();
  const recent = await db
    .selectFrom('connector_dm_greeted')
    .select('greeted_at')
    .where('platform', '=', m.platform)
    .where('external_user_id', '=', m.externalUserId)
    .where('greeted_at', '>=', since)
    .executeTakeFirst();
  if (recent) return false;

  const conn = connectorRegistry.getForBinding(
    m.platform,
    m.receivedByBotUserId ?? null,
  );
  if (!conn) return false;

  let sent = false;
  try {
    await conn.send({
      externalChannelId: m.externalChannelId,
      body: renderShadowGroupSignupNudge(),
      cards: signupActionCardsForGroup(),
    });
    sent = true;
    logger.info('welcome-dm: in-group signup notice posted', {
      platform: m.platform,
      externalUserId: m.externalUserId,
      externalChannelId: m.externalChannelId,
    });
  } catch (err) {
    logger.warn('welcome-dm: in-group signup notice send failed', {
      platform: m.platform,
      externalUserId: m.externalUserId,
      err: (err as Error).message,
    });
  }

  // Mark the cooldown even on send failure — if the connector is broken
  // we don't want to retry every invocation, just on the next cooldown
  // expiry.
  const now = new Date().toISOString();
  await db
    .insertInto('connector_dm_greeted')
    .values({
      platform: m.platform,
      external_user_id: m.externalUserId,
      greeted_at: now,
    })
    .onConflict((oc) =>
      oc
        .columns(['platform', 'external_user_id'])
        .doUpdateSet({ greeted_at: now }),
    )
    .execute();

  return sent;
}

/**
 * Build the URL-button action cards we attach to signup-nudge messages
 * (welcome stranger + in-group shadow notice) so TG renders a "Sign up"
 * inline button below the prose. Returns an empty array when
 * `SIGNUP_URL` isn't configured — the prose still ships, just without
 * the button. When `signupRef` is non-null, the URL carries the
 * referrer token so Google sign-in soft-links the TG identity.
 */
function signupActionCards(signupRef: string | null): BotCard[] {
  const url = buildSignupLink(signupRef);
  if (!url) return [];
  return [
    {
      kind: 'action',
      title: 'Connect to Chord',
      url,
    },
  ];
}

// Match `maybeAnnounceShadowSignupInGroup` — in-group nudge can't
// carry a referrer token (no DM channel to scope it to), so the button
// uses the bare signup URL.
function signupActionCardsForGroup(): BotCard[] {
  return signupActionCards(null);
}

export const __testing = {
  renderWelcome,
  renderShadowGroupSignupNudge,
  signupActionCards,
  buildSignupLink,
  START_CMD_RE,
};
