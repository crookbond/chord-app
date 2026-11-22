import type { Kysely } from 'kysely';

import type { BotCard, Message } from '@chord/kernel';
import { SSE, buildImperativeRegex, isValidTimeZone, mentionsBot } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger, promptLogger, promptLogMode } from '../../config/logging.js';
import { promptLogMessages } from '../../utils/prompt-log.js';
import { toolArgShape } from '../../utils/tool-arg-shape.js';
import type { DB, MessagesTable } from '../../db/schema.js';
import { getDefaultPersona } from '../bot-personas.service.js';
import { connectorRegistry } from '../connectors/registry.js';
import { recordConnectorSend } from '../connectors/outbound-publisher.js';
import { newId } from '../../utils/ids.js';
import { namesATimeZone, offsetMinutesOf, reanchorNowStampedOffset, tzToOffset } from '../../utils/tz.js';
import { legDatetime, placeDatetime } from './trip_classifier.js';
import { byokFailureMessage, classifyLlmError } from '../llm/errors.js';
import { markByokKeyNudged } from '../llm/key-health.js';
import { resolveTurnLlm } from '../llm/factory.js';
import { type Entitlement, gatedTurnMessage, getEntitlement } from '../billing.service.js';
import {
  chatConsentPrompt,
  chatConsentRecorded,
  getAiConsent,
  hasAiConsent,
  parseChatConsentReply,
  setAiConsent,
} from '../ai-consent.service.js';
import { aiRecipient } from '../llm/ai-recipient.js';
import {
  addUsage,
  type LlmMessage,
  type LlmService,
  type LlmTokenUsage,
  type LlmToolCall,
  type LlmToolDef,
} from '../llm/types.js';
import { recordTokenUsage } from '../tokens.service.js';
import { rowToMessage } from '../messages.service.js';
import { instantMs } from '@/db/text-instant.js';
import { sseHub } from '../sse.hub.js';
import { buildLlmContext } from './context.js';
import { applyToolCall } from './executor.js';
import { extractMemoriesFromTurn } from './extraction.js';
import { AllowanceExhaustedError, canUseAi } from '../llm/refusal.js';
import { queueAiWork } from '../ai-backlog.service.js';
import { linkReplyMemoryCards } from '../memory-notices.service.js';
import { parseReply } from './parser.js';
import { pendingInviteRetryInstruction } from './pending-invites.js';
import { withGroupTurn } from './turn-order.js';
import { citedFiles } from './file-citations.js';
import { selectExcerptsForTurn } from './retrieval.js';
import { maybeStartOnboarding, parseSkillCommand, runSkillCommand } from './skills/auto-start.js';
import { activeSkill } from './skills/index.js';
import { handleSkillReply, type SkillTurnNote } from './skills/reply.js';
import { choicesCard } from './skills/tool-result.js';
import { getPendingFanout } from './pending-fanout.js';
import { listPendingTripTravelers } from './pending-trip-travelers.js';
import {
  groupOfTool,
  groupsForText,
  groupsNamingTools,
  MORE_TOOLS_NAME,
  moreToolsDef,
  selectToolDefs,
  TOOL_GROUPS,
} from './tool-groups.js';
import {
  allowedToolsFor,
  buildToolDefsForPersona,
  isLookupTool,
  isToolName,
  normalizeDatetimes,
  PERSONAL_ONLY_TOOL_NAMES,
  READONLY_TOOL_NAMES,
  toolSchemas,
  type ToolCall,
  type ToolName,
} from './tools.js';

/**
 * Max round-trips in the native-tools loop (ADR 0005). Each round can
 * carry many tool_calls in parallel, so this is a cap on *thinking
 * rounds*, not on total calls. Bumped from 6 to 20 so a single turn can
 * comfortably ingest a batch like "create 30 events from this PDF" even
 * when the model dribbles out a few calls per round instead of all at once.
 */
const MAX_ITERATIONS = 20;

// Per-call output cap. Must be generous enough to hold a short prose reply
// PLUS a complete tool call with several fields (event with location +
// start/end, multi-clause reminders, etc.). Too low and the model stops at
// `finish_reason: 'length'` mid-tool-call, leaving truncated JSON arguments —
// which then poison the transcript and make the provider 400 on the next
// round-trip. 500 was too tight for multi-clause requests.
const MAX_TURN_TOKENS = 1500;

function missingKeyMessage(): string | null {
  const p = env.LLM_PROVIDER;
  if (p === '') {
    return (
      "I'd reply, but no LLM provider is configured. Set OPENAI_API_KEY, " +
      'GEMINI_API_KEY, or ANTHROPIC_API_KEY in .env, or set LLM_PROVIDER=mock, ' +
      'and restart the server.'
    );
  }
  if (p === 'openai') {
    const hasKey =
      env.OPENAI_API_KEY.length > 0 ||
      env.OPENAI_BASE_URL !== 'https://api.openai.com/v1';
    if (!hasKey) {
      return "I'd reply, but OPENAI_API_KEY is not set. Set it in .env and restart the server.";
    }
  }
  if (p === 'gemini' && env.GEMINI_API_KEY.length === 0) {
    return "I'd reply, but GEMINI_API_KEY is not set. Set it in .env and restart the server.";
  }
  if (p === 'anthropic' && env.ANTHROPIC_API_KEY.length === 0) {
    return "I'd reply, but ANTHROPIC_API_KEY is not set. Set it in .env and restart the server.";
  }
  return null;
}

export interface BotDecision {
  react: boolean;
  /**
   * PR-D.2 / ADR 0018 — when the sender's listening_mode is 'passive',
   * the bot still doesn't reply (no @-mention) but it should run the
   * memory extractor on the message so persona memories accrete
   * silently. False on personal chats (those always react and
   * extraction is downstream of the reply).
   */
  passiveExtract: boolean;
  reason: string;
  /**
   * ADR 0051 — what the caller should do to the follow-up window store after
   * acting on this decision. `'open'` (re)opens it on a fresh @-mention;
   * `'consume'` spends a turn when the bot reacted *because* of the window.
   * Undefined means leave the window untouched.
   */
  followup?: 'open' | 'consume';
}

export type ListeningMode = 'invocation' | 'passive' | 'active';

export function decideReaction(opts: {
  kind: Message['kind'];
  senderId: string | null;
  groupKind: 'group' | 'personal';
  body: string;
  /** Sender's per-user listening_mode. Defaults to 'invocation'. */
  listeningMode?: ListeningMode;
  /**
   * Precomputed @-mention flag. IM connectors set it from platform-native
   * mention syntax (`<@U…>` etc.) before posting; passing it here avoids
   * re-running the kernel `@chord` regex which only matches Chord-native
   * mentions. Falls back to the regex when omitted.
   */
  mentionsBot?: boolean;
  /**
   * ADR 0051 — whether this group currently has an open post-invocation
   * follow-up window (computed by the caller from `followup-window.ts`).
   * Group-scoped: once any member invokes the bot, the group's next few
   * messages still get a reply without a re-mention. Ignored on personal
   * chats and when a mention is present.
   */
  inFollowupWindow?: boolean;
}): BotDecision {
  if (opts.senderId === null || opts.kind === 'bot' || opts.kind === 'system') {
    return { react: false, passiveExtract: false, reason: 'bot/system message' };
  }
  if (opts.groupKind === 'personal') {
    return { react: true, passiveExtract: false, reason: 'personal chat' };
  }
  const mentioned = opts.mentionsBot ?? mentionsBot(opts.body, getDefaultPersona().mentionAliases);
  const mode: ListeningMode = opts.listeningMode ?? 'invocation';
  // A fresh mention always reacts and (re)opens the follow-up window.
  if (mentioned) {
    return { react: true, passiveExtract: false, reason: '@Chord mention', followup: 'open' };
  }
  // No mention, but the user is mid-conversation within the window → keep
  // answering and spend a turn (ADR 0051). Takes precedence over passive
  // extraction so the back-and-forth actually gets replies.
  if (opts.inFollowupWindow) {
    return { react: true, passiveExtract: false, reason: 'follow-up window', followup: 'consume' };
  }
  if (mode === 'passive') {
    return { react: false, passiveExtract: true, reason: 'passive listening' };
  }
  return { react: false, passiveExtract: false, reason: 'no mention in group' };
}

// How many recent human turns (including the trigger) feed attachment
// retrieval. Enough to carry a file reference across a couple of follow-ups
// without dragging in an unrelated earlier topic.
const RETRIEVAL_CONTEXT_MSGS = 4;

/**
 * Build the text used for attachment retrieval from the last few human messages
 * in the group, not just the triggering one — so follow-ups that don't repeat
 * the file's keywords ("summarize it") still retrieve it. The trigger body is
 * always included even if the message hasn't been persisted yet.
 */
export async function recentRetrievalText(
  db: Kysely<DB>,
  groupId: string,
  triggerMsg: Message,
): Promise<string> {
  const recent = await db
    .selectFrom('messages')
    .select(['body'])
    .where('group_id', '=', groupId)
    // Human turns only: exclude bot/system messages so the retrieval query
    // isn't polluted by the bot's own prior replies.
    .where('kind', 'not in', ['bot', 'system'])
    .where('sender_id', 'is not', null)
    .orderBy('created_at', 'desc')
    .limit(RETRIEVAL_CONTEXT_MSGS)
    .execute();
  const bodies = recent.map((r) => r.body);
  if (!bodies.includes(triggerMsg.body)) bodies.unshift(triggerMsg.body);
  return bodies.join('\n');
}

/**
 * ADR 0283/0079 — the memory pass over a message is held back while its
 * sender has no consent or allowance, and run once both are met (ai-backlog).
 */
async function holdBackMemory(db: Kysely<DB>, senderId: string, messageId: string): Promise<void> {
  await queueAiWork(db, { userId: senderId, kind: 'memory_message', ref: messageId });
}

/** ai-backlog runner: the held-back memory pass over one message. A message
 *  deleted since, or one in a chat the sender has left, is skipped. */
export async function rerunHeldBackMemory(db: Kysely<DB>, senderId: string, messageId: string): Promise<void> {
  const row = await db.selectFrom('messages').selectAll().where('id', '=', messageId).executeTakeFirst();
  if (!row || row.sender_id !== senderId) return;
  const group = await db
    .selectFrom('groups')
    .innerJoin('group_members', 'group_members.group_id', 'groups.id')
    .select(['groups.id', 'groups.kind'])
    .where('groups.id', '=', row.group_id)
    .where('group_members.user_id', '=', senderId)
    .executeTakeFirst();
  if (!group) return;
  const sender = await db
    .selectFrom('users')
    .where('id', '=', senderId)
    .select(['username', 'display_name as displayName'])
    .executeTakeFirst();
  await extractMemoriesFromTurn(db, {
    triggerMsg: rowToMessage(row),
    triggerUserName: sender?.displayName || sender?.username || 'user',
    botReply: '',
    group: { id: group.id, kind: group.kind === 'personal' ? 'personal' : 'group' },
    noticeMessageId: null,
  });
}

/**
 * PR-D.2 — fire the memory extractor on a non-reply message. Used by the
 * 'passive' listening mode: the bot doesn't speak, but it does learn.
 * Errors are logged + swallowed to keep the message-post path fast.
 */
export function passivelyExtractFromMessage(
  db: Kysely<DB>,
  triggerMsg: Message,
  group: { id: string; kind: 'group' | 'personal' },
): void {
  trackBackgroundTask(
    (async () => {
      const senderId = triggerMsg.senderId;
      if (!senderId) return;
      if (!(await canUseAi(db, senderId))) {
        await holdBackMemory(db, senderId, triggerMsg.id);
        return;
      }
      const sender = await db
        .selectFrom('users')
        .where('id', '=', senderId)
        .select(['username', 'display_name as displayName'])
        .executeTakeFirst();
      await extractMemoriesFromTurn(db, {
        triggerMsg,
        triggerUserName: sender?.displayName || sender?.username || 'user',
        botReply: '',
        group,
        noticeMessageId: null,
      });
    })().catch((err) => logger.error('passive extraction crashed', { err })),
  );
}

const pendingReactions = new Set<Promise<void>>();

/**
 * ADR 0178 — when set (REDIS_URL configured), `reactToMessage` hands the turn
 * to this instead of running it inline. Injected rather than imported, same
 * shape and reason as ADR 0118's `setMailboxSyncRunner` / ADR 0176's
 * `setMailSyncEnqueuer`: keeps this module below the queue/connector-registry
 * services in the dependency order. `null` (the default) restores today's
 * direct `runBotTurn` call — dev/CI/`npm run sim` need no Redis.
 */
let botTurnEnqueuer: typeof runBotTurn | null = null;
export function setBotTurnEnqueuer(fn: typeof runBotTurn | null): void {
  botTurnEnqueuer = fn;
}

function trackBackgroundTask(p: Promise<unknown>): void {
  const wrapped = Promise.resolve(p)
    .then(() => undefined)
    .finally(() => {
      pendingReactions.delete(wrapped);
    });
  pendingReactions.add(wrapped);
}

/** Fire-and-forget. Streams tokens to SSE and inserts the final message. */
export function reactToMessage(
  db: Kysely<DB>,
  triggerMsg: Message,
  group: { id: string; kind: 'group' | 'personal' },
  tz?: string,
  sourceBinding?: TurnCtx['sourceBinding'],
  chordVisible: number = 1,
): void {
  // ADR 0155 / 0280 — one bot turn per group at a time, in arrival order, across
  // every web copy: three quick "add …" messages must not race one
  // resolve-or-create into forked lists. Cross-group turns still run at once.
  // Still correct with the ADR 0178 queue enqueuer wired in, since the ticket
  // is held until the enqueued turn actually finishes (see bot-turn.queue.ts).
  const runTurn = botTurnEnqueuer ?? runBotTurn;
  const p = withGroupTurn(db, group.id, triggerMsg.id, () =>
    runTurn(db, triggerMsg, group, tz, sourceBinding, chordVisible),
  )
    .catch((err) => {
      logger.error(
        `bot react failed: ${(err as Error).message ?? String(err)}`,
        { err },
      );
    })
    .finally(() => {
      pendingReactions.delete(p);
    });
  pendingReactions.add(p);
}

/**
 * Test helper. Awaits all in-flight reactToMessage promises so tests can
 * tear down the DB without racing the bot turn. No-op in production paths.
 */
export async function awaitPendingBotReactions(): Promise<void> {
  while (pendingReactions.size > 0) {
    await Promise.allSettled([...pendingReactions]);
  }
}

/**
 * Awaitable bot turn — same semantics as `reactToMessage` minus the
 * fire-and-forget wrapper. Exported for integration tests that need to assert
 * against DB state after the turn completes. Production call sites should
 * keep using `reactToMessage` so the HTTP request returns immediately.
 */
export async function runBotTurn(
  db: Kysely<DB>,
  triggerMsg: Message,
  group: { id: string; kind: 'group' | 'personal' },
  tz?: string,
  sourceBinding: TurnCtx['sourceBinding'] = null,
  chordVisible: number = 1,
): Promise<void> {
  const botMsgId = newId('m');

  // ADR 0283 — no model runs on a user's data before they agree. The turn
  // posts a fixed message instead; in the personal chat AGREE / NO alone is
  // the answer, read here because no model may run to read it.
  if (triggerMsg.senderId && !(await hasAiConsent(db, triggerMsg.senderId))) {
    const userId = triggerMsg.senderId;
    const personal = group.kind === 'personal';
    const answer = personal ? parseChatConsentReply(triggerMsg.body) : null;
    let body: string;
    if (answer) {
      await setAiConsent(db, userId, {
        decision: answer,
        ageConfirmed: answer === 'granted',
        recipient: await aiRecipient(db, userId),
      });
      body = chatConsentRecorded(answer);
    } else {
      body = chatConsentPrompt(await aiRecipient(db, userId), await getAiConsent(db, userId), personal);
      await holdBackMemory(db, userId, triggerMsg.id);
    }
    await persistAndBroadcast(
      db,
      {
        id: botMsgId,
        group_id: group.id,
        sender_id: null,
        kind: 'bot',
        body,
        attachment_id: null,
        reply_to_id: triggerMsg.id,
        mentions_bot: 0,
        created_at: new Date().toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: chordVisible,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: getDefaultPersona().id,
        is_proactive: 0,
      },
      sourceBinding,
    );
    // ADR 0299 — agreeing is first use: onboarding opens after the thanks.
    if (answer === 'granted') {
      await maybeStartOnboarding(db, userId, { post: true }).catch((err) =>
        logger.warn('onboarding auto-start failed', { err }),
      );
    }
    return;
  }

  // ADR 0079/0196/0325 — the gate: with no allowance left (free tokens, a
  // plan) and no own key, the turn does not run; a short pointer at Settings →
  // AI Plan replaces it. Billing-off deploys pass straight through.
  let entitlement: Entitlement | undefined;
  if (env.BILLING_ENABLED && triggerMsg.senderId) {
    const ent = (entitlement = await getEntitlement(db, triggerMsg.senderId));
    if (!ent.entitled) {
      await holdBackMemory(db, triggerMsg.senderId, triggerMsg.id);
      await persistAndBroadcast(
        db,
        {
          id: botMsgId,
          group_id: group.id,
          sender_id: null,
          kind: 'bot',
          body: gatedTurnMessage(ent),
          attachment_id: null,
          reply_to_id: triggerMsg.id,
          mentions_bot: 0,
          created_at: new Date().toISOString(),
          source: null,
          external_message_id: null,
          chord_visible: chordVisible,
          mentions_others: 0,
          auto_mirror: 1,
          bot_persona_id: getDefaultPersona().id,
          is_proactive: 0,
        },
        sourceBinding,
      );
      return;
    }
  }

  const missingMsg = missingKeyMessage();
  if (missingMsg) {
    await persistAndBroadcast(
      db,
      {
        id: botMsgId,
        group_id: group.id,
        sender_id: null,
        kind: 'bot',
        body: missingMsg,
        attachment_id: null,
        reply_to_id: triggerMsg.id,
        mentions_bot: 0,
        created_at: new Date().toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: chordVisible,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: getDefaultPersona().id,
        is_proactive: 0,
      },
      sourceBinding,
    );
    return;
  }

  // ADR 0022 (quiet mode): we no longer stream tokens. Emit bot.start so
  // consumers (sim, web admin, future clients) can bind botMsgId →
  // triggerMsg.id up front, but no bot.token follows — the LLM stream is
  // buffered server-side and surfaces either as a single `message`
  // event (Q&A turn, no tool fired) or as a `bot.receipt` (directive
  // turn) at the end.
  if (chordVisible === 1) {
    sseHub.broadcast(group.id, SSE.botStart, {
      triggerMessageId: triggerMsg.id,
      messageId: botMsgId,
    });
  }

  const triggeringUserId = triggerMsg.senderId ?? '';

  // Whether the trigger carried an attachment, and whether it's an image.
  // Image attachments are extracted by BOTH the trip auto-filer and the content
  // classifier; non-image docs only by the trip auto-filer. The bot turn
  // suppresses the matching tool families so it doesn't re-propose what those
  // deterministic paths already file (see suppressedAutoFileTools).
  // These three are independent — run them concurrently. The attachment-excerpt
  // selection below consumes retrievalText, so it stays sequential after.
  //   - triggerAttachmentIsImage: image attachments are extracted by BOTH the
  //     trip auto-filer and the content classifier; non-image docs only by the
  //     trip auto-filer. The bot turn suppresses the matching tool families so
  //     it doesn't re-propose what those deterministic paths already file.
  //   - retrievalText: retrieve against the recent conversation, not just the
  //     current message, so a content-free follow-up ("summarize it", "show me")
  //     still re-finds the file named a turn or two earlier.
  const [triggerAttachment, retrievalText, turnLlm] = await Promise.all([
    (async () => {
      if (!triggerMsg.attachmentId) return null;
      const att = await db
        .selectFrom('attachments')
        .select(['mime_type', 'filename'])
        .where('id', '=', triggerMsg.attachmentId)
        .executeTakeFirst();
      return { isImage: !!att?.mime_type?.startsWith('image/'), filename: att?.filename ?? null };
    })(),
    recentRetrievalText(db, group.id, triggerMsg),
    // Consent was checked above (a sender who has not agreed never gets here),
    // and the entitlement read there is this turn's too.
    resolveTurnLlm(db, triggeringUserId || null, { consented: true, entitlement }),
  ]);
  const { llm, tier: llmTier } = turnLlm;
  const triggerAttachmentIsImage = !!triggerAttachment?.isImage;
  const triggerIsBareUpload =
    !!triggerMsg.attachmentId && isBareAttachmentUpload(triggerMsg.body, triggerAttachment?.filename);

  const attachments = await selectExcerptsForTurn(db, {
    groupId: group.id,
    triggeringUserId,
    triggerText: retrievalText,
  });

  // ADR 0299 — while a skill runs here, this message IS the answer to its
  // open question: the server records it and moves on before any model runs
  // (the model, left to call skill_step, asked follow-ups instead). Otherwise
  // a user's first message in their own chat is first use where no
  // consent step came before it; this turn's reply then asks the first question.
  // A slash command (`/onboard`, `/plan`) is read in code, not by the model.
  let skillTurn: SkillTurnNote | undefined;
  if (group.kind === 'personal' && triggeringUserId) {
    const command = parseSkillCommand(triggerMsg.body);
    if (command) {
      const handled = await runSkillCommand(db, {
        userId: triggeringUserId,
        groupId: group.id,
        skill: command,
        replyToId: triggerMsg.id,
        messageId: botMsgId,
      });
      if (handled === 'posted') return;
    } else {
      const reply = await handleSkillReply(db, {
        userId: triggeringUserId,
        groupId: group.id,
        body: triggerMsg.body,
        replyToId: triggerMsg.id,
        messageId: botMsgId,
      });
      if (reply.kind === 'posted') return;
      if (reply.kind === 'note') skillTurn = reply.note;
      else
        await maybeStartOnboarding(db, triggeringUserId, { post: false }).catch((err) =>
          logger.warn('onboarding auto-start failed', { err }),
        );
    }
  }

  const messages = await buildLlmContext(db, {
    groupId: group.id,
    isPersonal: group.kind === 'personal',
    triggerMessageId: triggerMsg.id,
    triggeringUserId,
    attachments,
    useNativeTools: llm.supportsNativeTools,
    tz,
    sourceSurface: sourceBinding
      ? { platform: sourceBinding.platform }
      : null,
    triggerHasAttachment: !!triggerMsg.attachmentId,
    triggerAttachmentIsImage,
    triggerIsBareUpload,
    skillTurn,
  });
  promptLogger.info('bot turn prompt', {
    botMsgId,
    groupId: group.id,
    groupKind: group.kind,
    triggerMessageId: triggerMsg.id,
    triggeringUserId,
    provider: llm.providerName,
    useNativeTools: llm.supportsNativeTools,
    tz: tz ?? null,
    sourceSurface: sourceBinding ? sourceBinding.platform : null,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      pinned: a.pinned,
      indexed: a.indexedAt !== null,
    })),
    messages: promptLogMessages(messages, promptLogMode),
  });
  let finalBody = '';
  let anyToolsExecuted = false;
  let toolNames: string[] = [];
  const usedFileIds = new Set<string>();
  const cards: BotCard[] = [];

  const tzOffset = tz ? tzToOffset(tz) : '+00:00';

  try {
    const turnCtx: TurnCtx = {
      botMsgId,
      groupId: group.id,
      triggeringUserId: triggerMsg.senderId ?? null,
      triggeringMessageId: triggerMsg.id,
      tzOffset,
      tz: tz ?? null,
      sourceBinding,
      chordVisible,
      isPersonal: group.kind === 'personal',
      triggerHasAttachment: !!triggerMsg.attachmentId,
      triggerAttachmentIsImage,
      toolHints:
        llm.supportsNativeTools && env.BOT_TOOL_SUBSET && triggeringUserId
          ? await turnToolHints(db, group.id, triggeringUserId, group.kind === 'personal')
          : undefined,
      toolWords:
        llm.supportsNativeTools && env.BOT_TOOL_SUBSET
          ? await turnToolWords(db, group.id, triggerMsg).catch(() => triggerMsg.body)
          : undefined,
    };
    const result = llm.supportsNativeTools
      ? await runNativeLoop(db, llm, messages, turnCtx)
      : await runTextFenceTurn(db, llm, messages, turnCtx);
    finalBody = result.body;
    toolNames = result.toolNames;
    anyToolsExecuted = toolNames.length > 0;
    cards.push(...result.cards);
    for (const id of result.usedFileIds) usedFileIds.add(id);

    // ADR 0193/0196 — recording usage IS the debit now: a system-key
    // subscriber's remaining balance is computed on read as
    // MONTHLY_TOKEN_ALLOWANCE minus SUM(token_usage) since their period
    // started (`getEntitlement`), so this write is the only accounting a
    // completed turn needs — no separate strict-ledger step. Independent
    // of BILLING_ENABLED: a team/dev deploy still wants to see its own
    // usage. Skipped only for BYOK ("their key, their cost") — `llmTier`
    // is computed even when billing is off, so it's a reliable BYOK signal
    // on every deploy shape.
    // Called once per model run, so the strict retry below is counted too
    // (it is a second full run of the loop; its tokens used to go unrecorded).
    const recordRun = async (usage: LlmTokenUsage | null): Promise<void> => {
      if (!usage || !triggeringUserId || llmTier === 'byok') return;
      await recordTokenUsage(db, {
        userId: triggeringUserId,
        source: 'bot_turn',
        ref: botMsgId,
        model: llm.defaultModel,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        costUsd: usage.costUsd,
      }).catch((err) =>
        logger.warn('token usage record failed', { err: String(err), botMsgId, triggeringUserId }),
      );
    };
    await recordRun(result.tokenUsage);

    // Imperative-verb retry: if the user opened the message with an
    // imperative directed at @Chord ("remember X", "add Y", "create Z")
    // and the LLM didn't even *attempt* a tool call, re-roll once with
    // a strict system message. Skip the retry when the LLM tried a
    // tool but validation rejected it — re-rolling won't fix bad args
    // and would just produce another rejection. One retry only —
    // bounds cost and latency.
    const shouldRetryImperative =
      !anyToolsExecuted &&
      result.attemptedTools === 0 &&
      isImperativeChordPrompt(triggerMsg.body);
    const shouldRetryWhereIs =
      !anyToolsExecuted &&
      result.attemptedTools === 0 &&
      isWhereIsPrompt(triggerMsg.body);
    // ADR 0317 — a message that supplies an address for an invitee
    // still waiting on one must reach update_event. A bare address has no
    // verb, so the imperative retry above never fires; the prompt block alone
    // let a prose reply ("Got it") leave the invite unsent. Only when nothing
    // was written this turn, so the retry cannot repeat a write.
    const inviteRetry =
      !shouldRetryImperative &&
      !shouldRetryWhereIs &&
      triggeringUserId &&
      toolNames.every((n) => READONLY_TOOL_NAMES.has(n as ToolName))
        ? await pendingInviteRetryInstruction(db, group.id, triggeringUserId, triggerMsg.body).catch(() => null)
        : null;
    if (shouldRetryImperative || shouldRetryWhereIs || inviteRetry) {
      const retryReason = inviteRetry ? 'pending-invite' : shouldRetryImperative ? 'imperative' : 'where-is';
      logger.info(`bot turn: no tool fired on ${retryReason} prompt — retrying with strict mode`, {
        botMsgId,
        body: triggerMsg.body.slice(0, 80),
      });
      const strictContent = inviteRetry
        ? inviteRetry
        : shouldRetryWhereIs
        ? 'STRICT MODE: The user asked a "where is X?" / "find X" / "directions to X" question. Your previous reply did NOT call any tool — that is not allowed for this question shape. Call `suggest_external_action` NOW. Routing: if X matches a saved person, a kid_name / spouse_name memory, or a group member, use `kind: \'find_person\'` with `label: \'Open Find My\'` and `query.q: <person\'s display name>`. Otherwise (a restaurant, landmark, city, address, or any POI) use `kind: \'map\'` with `label: \'Open in Maps\'` and `query.q: <place name>`. Do not reply with prose only. No claiming to have surfaced a card unless you actually emit the tool call this turn.'
        : 'STRICT MODE: The user gave you an imperative directive ("remember…", "add…", "save…", "create…", "put… on calendar", "remind…", "book…", "reserve…", "find…", "show me…", or similar). Your previous reply did not call any tool. Re-read the user\'s last message and call the tool that matches their intent NOW. Do not reply with prose only — the user expects you to act. The ONE exception: if none of your tools can represent what they actually asked for (a freeform spreadsheet, a custom tracker with arbitrary columns — not something a task/list/event/save/trip would satisfy), don\'t force a mismatched write into the nearest tool; instead reply proposing the closest of those as a substitute and ask them to confirm before you act. Use this exception only when it is genuinely true — it is not a way to avoid firing a tool that does fit.';
      const strictMessages: LlmMessage[] = [
        ...messages,
        { role: 'system', content: strictContent },
      ];
      try {
        const retry = llm.supportsNativeTools
          ? await runNativeLoop(db, llm, strictMessages, turnCtx)
          : await runTextFenceTurn(db, llm, strictMessages, turnCtx);
        await recordRun(retry.tokenUsage);
        if (retry.toolNames.length > 0) {
          finalBody = retry.body || finalBody;
          toolNames = retry.toolNames;
          anyToolsExecuted = true;
          cards.push(...retry.cards);
          for (const id of retry.usedFileIds) usedFileIds.add(id);
        }
      } catch (err) {
        logger.warn(`strict-mode retry failed: ${(err as Error).message ?? String(err)}`, { err });
      }
    }
  } catch (err) {
    // OpenAI/OpenRouter SDK errors carry the useful detail on `.status` and
    // `.error`/`.response`, none of which survive a bare `{ err }` log (Error
    // fields aren't enumerable). Pull them out explicitly so a recurring 400
    // is diagnosable instead of showing up as `err:{}`.
    const e = err as { message?: string; status?: number; code?: string; error?: unknown };
    logger.error(`LLM stream error: ${e.message ?? String(err)}`, {
      status: e.status,
      code: e.code,
      detail: e.error,
    });
    finalBody = 'Service is temporarily unavailable — please try again in a moment.';

    // ADR 0044: when the turn ran on the user's own BYOK key and the failure
    // is theirs to fix (key rejected / out of credits), tell them so they
    // can re-paste or top up — don't masquerade it as our outage, and don't
    // fall back to the system key (that silently puts the cost back on us).
    if (triggeringUserId) {
      const byok = await db
        .selectFrom('users')
        .select(['model_provider', 'model_base_url', 'model_key_ciphertext'])
        .where('id', '=', triggeringUserId)
        .executeTakeFirst();
      if (byok?.model_provider && byok.model_key_ciphertext) {
        const msg = byokFailureMessage(byok.model_provider, classifyLlmError(err).kind, byok.model_base_url);
        if (msg) {
          finalBody = msg;
          // This reply IS the heads-up; the chat nudge would say it twice.
          await markByokKeyNudged(db, triggeringUserId).catch(() => undefined);
        }
      }
    }
  }

  const body = finalBody || (anyToolsExecuted ? 'Done.' : '…');

  // ADR 0299 — a skill's next question must be read, so a turn that saved an
  // answer is still a bubble (not a receipt strip), and the question's
  // tappable answers come from the server, not from the model remembering.
  const skillOpen =
    group.kind === 'personal' && triggeringUserId
      ? await activeSkill(db, triggeringUserId, group.id).catch(() => null)
      : null;
  const skillReply = !!skillTurn || !!skillOpen;
  if (skillOpen?.step && !cards.some((c) => c.kind === 'choices')) {
    const card = choicesCard(skillOpen.step);
    if (card) cards.push(card);
  }

  // ADR 0022: a directive turn (≥1 tool fired) is silent — the bot row
  // persists at chord_visible=0 (kept for LLM context only), and a
  // `bot.receipt` SSE event tells the client to render a tiny receipt
  // strip under the trigger message instead of a bot bubble. Q&A turns
  // (no tool fired) take the existing visible path: persist at
  // chord_visible=chordVisible, and persistAndBroadcast emits
  // `bot.done` + `message`.
  //
  // Special case: imperative prompt that still failed to fire a tool
  // even after the strict-mode retry → surface as a 'failed' receipt
  // strip (⚠️) so the user can see Chord misfired rather than getting
  // a confusing "Got it" bubble that looks like success.
  const failedImperative =
    chordVisible === 1 &&
    !anyToolsExecuted &&
    !skillTurn &&
    (isImperativeChordPrompt(triggerMsg.body) || isWhereIsPrompt(triggerMsg.body));
  // Read-only query tools (find_conflicts, find_events, list_*, search_*, …)
  // produce an answer the user is waiting to read — surface the LLM's
  // natural-language reply as a normal bubble rather than a silent receipt.
  // Write tools stay on the receipt path so the chat doesn't get cluttered
  // with "Got it." confirmations.
  const allReadOnly =
    anyToolsExecuted &&
    toolNames.every((n) => READONLY_TOOL_NAMES.has(n as ToolName));
  // A card left waiting for the user's tap is not a done write: nothing has
  // happened yet, the confirm buttons hang off the reply, and the reply says
  // what is and is not on the card. The quiet receipt would hide all three.
  const leftCardWaiting =
    anyToolsExecuted &&
    !!(await db
      .selectFrom('proposals')
      .select('id')
      .where('group_id', '=', group.id)
      .where('proposed_by_message_id', '=', triggerMsg.id)
      .where('status', '=', 'pending')
      .limit(1)
      .executeTakeFirst()
      .catch(() => undefined));
  // Bare auto-filed upload: the user just dropped a file with no question, and
  // the deterministic auto-filer posts its own "📎 Indexed —…" line. A visible
  // turn here (no tool, no real question) would only double-post a generic
  // narration, so persist it for LLM context but render nothing.
  const bareAutoFileUpload =
    chordVisible === 1 &&
    triggerMsg.attachmentId != null &&
    !anyToolsExecuted &&
    !failedImperative &&
    triggerIsBareUpload;
  const surfaceMode: 'receipt' | 'receipt-failed' | 'visible' | 'silent-bridge' | 'silent-autofile' =
    chordVisible === 0
      ? 'silent-bridge'
      : bareAutoFileUpload
        ? 'silent-autofile'
        : anyToolsExecuted && !allReadOnly && !skillReply && !leftCardWaiting
          ? 'receipt'
          : failedImperative
            ? 'receipt-failed'
            : 'visible';
  const persistedChordVisible = surfaceMode === 'visible' ? 1 : 0;

  await persistAndBroadcast(
    db,
    {
      id: botMsgId,
      group_id: group.id,
      sender_id: null,
      kind: 'bot',
      body,
      attachment_id: null,
      reply_to_id: triggerMsg.id,
      mentions_bot: 0,
      created_at: new Date().toISOString(),
      source: null,
      external_message_id: null,
      chord_visible: persistedChordVisible,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: getDefaultPersona().id,
      is_proactive: 0,
    },
    // silent-autofile must not reach the source bridge either — the auto-filer's
    // own acknowledgment is the single message; pass no binding so the silent
    // path skips connector.send (the row still persists for LLM context).
    surfaceMode === 'silent-autofile' ? null : sourceBinding,
    cards,
  );
  // ADR 0281 — a fact a tool just saved (remember_fact, correct_memory) has its
  // card on this reply; record that so a later change to the fact updates it.
  if (cards.some((c) => c.kind === 'memory')) {
    await linkReplyMemoryCards(db, botMsgId, cards).catch((err) =>
      logger.warn('memory notice link failed', { err }),
    );
  }

  if (surfaceMode === 'receipt' || surfaceMode === 'receipt-failed') {
    sseHub.broadcast(group.id, SSE.botReceipt, {
      triggerMessageId: triggerMsg.id,
      messageId: botMsgId,
      status: surfaceMode === 'receipt' ? 'ok' : 'error',
      toolNames,
    });
  }

  // Cards SSE for client rendering — under the bubble in the visible
  // path, under the receipt strip in the receipt path. The DB row was
  // already persisted above (before persistAndBroadcast) so bridges
  // see them too. Skipped in silent-bridge mode.
  if (cards.length > 0 && surfaceMode !== 'silent-bridge') {
    sseHub.broadcast(group.id, SSE.botCard, { messageId: botMsgId, cards });
  }

  // ADR 0288 (addendum 2026-10-25) — name only files a file tool used this turn.
  const publicSources = citedFiles({
    attachments,
    groupId: group.id,
    usedFileIds,
  });
  if (publicSources.length > 0) {
    sseHub.broadcast(group.id, SSE.botSources, {
      messageId: botMsgId,
      sources: publicSources.map((a) => ({
        attachmentId: a.id,
        filename: a.filename,
        summary: a.summary ?? undefined,
        pinned: a.pinned === 1,
      })),
    });
  }

  const triggerUser = triggerMsg.senderId
    ? await db
        .selectFrom('users')
        .where('id', '=', triggerMsg.senderId)
        .select(['username', 'display_name as displayName'])
        .executeTakeFirst()
    : null;
  trackBackgroundTask(
    extractMemoriesFromTurn(db, {
      triggerMsg,
      triggerUserName: triggerUser?.displayName || triggerUser?.username || 'user',
      botReply: body,
      group,
      // ADR 0281 — the notice goes under this reply when Chord shows it;
      // otherwise to the sayer's personal chat.
      noticeMessageId:
        surfaceMode === 'silent-bridge' || surfaceMode === 'silent-autofile' ? null : botMsgId,
    }).catch((err) => logger.error('memory extraction crashed', { err })),
  );

  // Cross-group document sharing offer was removed: documents stay
  // confined to their owning group by default. Users can still share
  // explicitly via the attachment-share API, but Chord no longer
  // proactively suggests it.
}

// Imperative-verb regex: matches messages where the user is clearly
// directing the bot to do something (not asking a question). Used by
// the strict-mode retry to detect "@Chord remember Alice's birthday is
// May 8" → expect a tool call; "@Chord what's on Friday?" → expect prose.
// Built per-call from the persona's aliases so a deployment using
// `@chord-beta` matches the same way.
function isImperativeChordPrompt(body: string): boolean {
  return buildImperativeRegex(getDefaultPersona().mentionAliases).test(body);
}

/**
 * "Where is X?" pattern — questions that should always fire
 * `suggest_external_action` (find_person for people, map for places).
 * Used to trigger the strict-mode retry when the LLM produces prose
 * like "I opened X in Maps" without actually calling the tool.
 */
const WHERE_IS_RE =
  /\b(where(?:'s| is)|find(?: my| out where| where is)?|directions to|how do (?:i|we) get to|locate)\b/i;
export function isWhereIsPrompt(body: string): boolean {
  return WHERE_IS_RE.test(body);
}

/**
 * True when the trigger is a bare attachment upload — a file with no
 * substantive instruction or question once the bot @-mention is stripped
 * (e.g. an empty body, or just "@Chord"). The deterministic auto-filer posts
 * its own "📎 Indexed —…" acknowledgment for calendars/itineraries/trips, so a
 * visible bot turn that fired no tool and answered no question would just
 * double-post a generic narration ("The image shows a calendar… how can I
 * assist?"). Detecting this lets the turn stay silent and leave the auto-filer's
 * line as the single acknowledgment.
 *
 * The app posts a picked file with the body `📎 <filename>`, so the file's own
 * name is not an instruction either (the app hides that caption by the same
 * rule).
 */
export function isBareAttachmentUpload(body: string, filename?: string | null): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alt = getDefaultPersona().mentionAliases.map(escape).join('|');
  const withoutName = filename?.trim()
    ? body.replace(new RegExp(escape(filename.trim()), 'gi'), ' ')
    : body;
  const stripped = withoutName
    .replace(new RegExp(`@(?:${alt})\\b`, 'gi'), ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
  return stripped.length === 0;
}

async function persistAndBroadcast(
  db: Kysely<DB>,
  row: MessagesTable,
  sourceBinding: TurnCtx['sourceBinding'] = null,
  cards: BotCard[] = [],
): Promise<void> {
  await db.insertInto('messages').values(row).execute();
  // Cards must persist before SSE.message fires — the outbound publisher
  // reads message_cards to enrich bridge sends, and the FK on
  // message_cards.message_id requires the message row to exist first.
  if (cards.length > 0) {
    await db
      .insertInto('message_cards')
      .values({
        message_id: row.id,
        cards_json: JSON.stringify(cards),
        created_at: new Date().toISOString(),
      })
      .execute();
  }
  if (row.chord_visible === 1) {
    // Normal path — Chord clients see the reply, outbound publisher
    // mirrors it across bridges.
    sseHub.broadcast(row.group_id, SSE.botDone, { messageId: row.id });
    sseHub.broadcast(row.group_id, SSE.message, rowToMessage(row));
    return;
  }
  // Silent path: the trigger was chord_visible=0, so the reply is too.
  // Skip SSE so Chord clients don't see anything; deliver the reply
  // straight to the source bridge (where the user was speaking) via
  // connector.send. Other bridges are intentionally bypassed.
  if (sourceBinding) {
    const conn = connectorRegistry.getForBinding(
      sourceBinding.platform,
      sourceBinding.botUserId,
    );
    if (conn) {
      try {
        const sent = await conn.send({
          externalChannelId: sourceBinding.externalChannelId,
          body: row.body,
          cards,
        });
        // Recorded like a mirrored send, so a typed YES / NO here can tell
        // which cards this chat was actually shown (reply-answer.ts).
        if (sent?.externalMessageId) {
          await recordConnectorSend(db, {
            chordMessageId: row.id,
            platform: sourceBinding.platform,
            externalChannelId: sourceBinding.externalChannelId,
            externalMessageId: sent.externalMessageId,
            botUserId: sourceBinding.botUserId,
          });
        }
      } catch (err) {
        logger.warn('silent bot reply: connector send failed', {
          platform: sourceBinding.platform,
          err,
        });
      }
    }
  }
}

interface TurnResult {
  body: string;
  cards: BotCard[];
  toolNames: string[];
  /**
   * Number of tool calls the LLM *attempted* this turn (regardless of
   * whether validation accepted them). Used by the strict-mode retry to
   * distinguish "model chatted back, ignored the directive" (0
   * attempts → retry helps) from "model tried but args were invalid"
   * (≥1 attempt → re-rolling won't fix bad args, skip retry).
   */
  attemptedTools: number;
  /** ADR 0193 — summed across every `llm.stream()` round-trip this turn made
   *  (the native loop can iterate several times). `null` when the provider
   *  never reported usage (mock, or a provider call that threw). */
  tokenUsage: LlmTokenUsage | null;
  /** ADR 0288 — files a file tool opened, sent or referenced this turn. */
  usedFileIds: string[];
}

/**
 * Exported so bot-turn.queue.ts (ADR 0178) can type its job payload without
 * duplicating this shape — the queue only ever needs to carry it through
 * Redis and hand it back to `runBotTurn`, never to construct one itself.
 */
export type BotTurnSourceBinding = {
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  externalChannelId: string;
  /** ADR 0025 — null = deploy-wide bot; non-null = BYO. */
  botUserId: string | null;
} | null;

interface TurnCtx {
  botMsgId: string;
  groupId: string;
  triggeringUserId: string | null;
  triggeringMessageId: string | null;
  tzOffset: string;
  /** IANA zone, when known — see `ApplyToolCallInput.tz` for why this is
   *  threaded separately from `tzOffset`. */
  tz: string | null;
  /**
   * Connector binding this turn came in through. Threaded down to the
   * `relay` tool so target='all' can exclude the source surface.
   */
  sourceBinding: BotTurnSourceBinding;
  /**
   * 1 = ordinary turn (Chord clients see token streaming + the final bot
   * message). 0 = silent turn (the trigger itself is chord_visible=0;
   * Chord clients see nothing; the bot's final reply is delivered
   * directly to `sourceBinding` via connector.send instead of broadcast).
   */
  chordVisible: number;
  /** group.kind === 'personal'. Gates personal-only tools (e.g. set_my_name). */
  isPersonal: boolean;
  /**
   * The trigger carried an uploaded attachment. Document extraction is owned by
   * the deterministic auto-filers (`classifyAndAutoFileAttachment` for trips,
   * `classifyAndProposeContent` for image content), so the bot must not also
   * propose those tools from the same upload — otherwise confirming duplicates
   * what was auto-filed and trips a conflict. See ADR 0009 / trip_classifier.
   */
  triggerHasAttachment: boolean;
  /** The attachment is an image — the content classifier also handled it, so
   *  content tools (tasks/events/lists/saves) are suppressed too. */
  triggerAttachmentIsImage: boolean;
  /** Only these tools are offered and run (a side chat such as Findings). */
  onlyTools?: ReadonlySet<string>;
  /** Tools that exist only on this surface, answered by the caller (ADR 0277). */
  sideTools?: ReadonlyMap<string, SideTool>;
  /** Broadcast nothing: the turn belongs to no chat's message stream. */
  quiet?: boolean;
  /** The user's own words, for a turn with no stored message (ADR 0279). */
  userText?: string[];
  /**
   * ADR 0322 — text naming tools this turn may need though the conversation
   * does not say so: a running skill's steps, a pending share offer.
   */
  toolHints?: string;
  /** ADR 0322 addendum — the user's own words that pick the starting groups. */
  toolWords?: string;
}

/** ADR 0322 addendum — how recent the user's previous message must be to count. */
const TOOL_GROUP_FOLLOWUP_MS = 10 * 60_000;

/**
 * ADR 0322 addendum — the words that pick a turn's tool groups: the
 * triggering message, plus the same user's previous message in this chat when
 * it is under ten minutes older (so "yes" or "that one" keeps its context).
 * Bot replies are never read: they are long and name every topic, and reading
 * them started most turns with nearly every group.
 */
export async function turnToolWords(
  db: Kysely<DB>,
  groupId: string,
  triggerMsg: Pick<Message, 'id' | 'body' | 'senderId' | 'createdAt'>,
): Promise<string> {
  if (!triggerMsg.senderId) return triggerMsg.body;
  const prev = await db
    .selectFrom('messages')
    .select(['body', 'created_at'])
    .where('group_id', '=', groupId)
    .where('sender_id', '=', triggerMsg.senderId)
    .where('kind', 'not in', ['bot', 'system'])
    .where('id', '!=', triggerMsg.id)
    .where('created_at', '<=', triggerMsg.createdAt)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const gap = prev ? instantMs(triggerMsg.createdAt) - instantMs(prev.created_at) : Infinity;
  return gap >= 0 && gap <= TOOL_GROUP_FOLLOWUP_MS ? `${prev!.body}\n${triggerMsg.body}` : triggerMsg.body;
}

/**
 * The tool groups for a turn: groups whose words are in `words`, plus any
 * group a hint names. Without `words` (a turn with no stored message), the
 * latest user message's text after its "name: " prefix. Neither the system
 * prompt nor bot replies are read — between them they mention every topic.
 */
function turnToolGroups(
  messages: readonly LlmMessage[],
  words: string | undefined,
  hints: string | undefined,
): Set<string> {
  let text = words;
  if (text === undefined) {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const raw = last && typeof last.content === 'string' ? last.content : '';
    text = raw.replace(/^[^:\n]{0,80}:\s/, '');
  }
  const groups = groupsForText(text);
  if (hints) for (const g of groupsNamingTools(hints)) groups.add(g);
  return groups;
}

/** ADR 0322 — what a running skill or a pending offer will need. */
async function turnToolHints(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  isPersonal: boolean,
): Promise<string> {
  const parts: string[] = [];
  const [skill, fanout, tripsAsked] = await Promise.all([
    isPersonal ? activeSkill(db, userId, groupId).catch(() => null) : null,
    getPendingFanout(db, groupId, userId).catch(() => null),
    isPersonal ? listPendingTripTravelers(db, userId).catch(() => []) : [],
  ]);
  if (skill) {
    parts.push(skill.skill.instructions, skill.skill.finish);
    for (const s of skill.skill.steps) parts.push(s.saveWith.join(' '));
  }
  if (fanout) parts.push(fanout.kind === 'trip' ? 'share_trip' : 'share_event');
  if (tripsAsked.length > 0) parts.push('set_trip_passengers');
  return parts.join('\n');
}

// Trip tools — owned by the trip auto-filer, which runs on ANY uploaded doc.
const TRIP_TOOLS: ReadonlySet<string> = new Set([
  'create_trip',
  'add_travel_leg',
  'add_accommodation',
  'add_reservation',
]);

// Content tools — owned by the content classifier, which runs only for IMAGE
// uploads (attachments.service gates it on mimeType image + imageMeta).
const CONTENT_TOOLS: ReadonlySet<string> = new Set([
  'create_task',
  'add_list_item',
  'create_event',
  'save_link',
  'save_place',
  'save_media',
  'save_contact',
]);

/** Tools the deterministic auto-filers own for THIS trigger's attachment, which
 *  the bot turn must not re-propose. Trip tools for any attachment; content
 *  tools additionally for images. Empty when there's no attachment. */
function suppressedAutoFileTools(ctx: TurnCtx): ReadonlySet<string> {
  if (!ctx.triggerHasAttachment) return new Set();
  if (!ctx.triggerAttachmentIsImage) return TRIP_TOOLS;
  return new Set([...TRIP_TOOLS, ...CONTENT_TOOLS]);
}

/**
 * Single-shot path for providers without native tool support (Gemini, mock).
 * Streams text, then parses ` ```chord-tool ``` ` fences out of the reply and
 * executes whatever the regex found. ADR 0003.
 */
async function runTextFenceTurn(
  db: Kysely<DB>,
  llm: LlmService,
  messages: LlmMessage[],
  ctx: TurnCtx,
): Promise<TurnResult> {
  const { botMsgId, groupId } = ctx;
  let accumulated = '';
  let tokenUsage: LlmTokenUsage | null = null;
  // ADR 0022: tokens are buffered, never streamed to the client.
  for await (const chunk of llm.stream(messages, {
    maxTokens: MAX_TURN_TOKENS,
    onUsage: (u) => {
      tokenUsage = u;
    },
  })) {
    if (chunk.type === 'text') {
      accumulated += chunk.delta;
    } else if (chunk.type === 'done') {
      break;
    }
  }

  const side = ctx.sideTools;
  const sideNames: string[] = [];
  if (side?.size) {
    // The fence parser drops names it does not know, so a side tool's fence
    // is taken out first and answered here.
    const fences = [...accumulated.matchAll(/```chord-tool\s*([\s\S]*?)```/g)];
    for (const [whole, payload] of fences) {
      let obj: { name?: string; args?: unknown };
      try {
        obj = JSON.parse((payload ?? '').trim()) as { name?: string; args?: unknown };
      } catch {
        continue;
      }
      const tool = obj.name ? side.get(obj.name) : undefined;
      if (!tool || !obj.name) continue;
      await runSideTool(tool, obj.name, obj.args);
      sideNames.push(obj.name);
      accumulated = accumulated.replace(whole, '');
    }
  }
  const { cleanBody, calls, warnings } = parseReply(accumulated);
  for (const w of warnings) logger.warn(`bot parser: ${w}`);

  // ADR 0027 — drop calls for tools the active persona disallows. The native
  // path filters at definition time; the text-fence path filters here so a
  // restricted persona can't be talked into a write via a fenced block.
  const allowed = allowedToolsFor(getDefaultPersona());
  const suppressed = suppressedAutoFileTools(ctx);
  const gatedCalls = calls.filter((c) => {
    if (ctx.onlyTools && !ctx.onlyTools.has(c.name)) {
      logger.warn(`bot parser: dropping ${c.name} — not offered on this surface`);
      return false;
    }
    if (suppressed.has(c.name)) {
      logger.warn(`bot parser: dropping ${c.name} — attachment content is auto-filed, not proposed`);
      return false;
    }
    if (allowed.has(c.name as ToolName)) return true;
    logger.warn(`bot parser: dropping disallowed tool ${c.name} (persona policy)`);
    return false;
  });

  const cards: BotCard[] = [];
  const turnBundle: TurnBundle = { tripBundleId: null };
  const toolNames: string[] = [...sideNames];
  const usedFileIds = new Set<string>();
  // ADR 0245 - the fence path gets the same clock fix as native calls. It
  // reaches the executor without passing `validateNativeCall`, so a mock or
  // text-only provider still stamped today's offset on a later date.
  const zoneNamedInTurn = zoneNamedIn(messages);
  for (const fenced of gatedCalls) {
    const call = {
      ...fenced,
      args: anchorModelTimes(
        fenced.name,
        normalizeDatetimes(fenced.args, ctx.tzOffset, ctx.tz),
        ctx.tzOffset,
        ctx.tz,
        zoneNamedInTurn,
      ),
    } as ToolCall;
    await executeAndBroadcast({
      db,
      groupId,
      botMsgId,
      triggeringUserId: ctx.triggeringUserId,
      triggeringMessageId: ctx.triggeringMessageId,
      sourceBinding: ctx.sourceBinding,
      tzOffset: ctx.tzOffset,
      tz: ctx.tz,
      call,
      cards,
      turnBundle,
      triggerFromAttachment: ctx.triggerHasAttachment,
      isPersonal: ctx.isPersonal,
      quiet: ctx.quiet,
      userText: ctx.userText,
      usedFileIds,
    });
    toolNames.push(call.name);
  }

  return {
    body: cleanBody,
    cards,
    toolNames,
    attemptedTools: calls.length + sideNames.length,
    tokenUsage,
    usedFileIds: [...usedFileIds],
  };
}

/**
 * Iterative native function-calling loop (ADR 0005). Runs up to
 * `MAX_ITERATIONS` round-trips: stream → tool calls → execute → append tool
 * results → stream again. Terminates as soon as the model returns a turn with
 * no tool_calls, or when we hit the iteration cap.
 */
async function runNativeLoop(
  db: Kysely<DB>,
  llm: LlmService,
  initialMessages: LlmMessage[],
  ctx: TurnCtx,
): Promise<TurnResult> {
  const { botMsgId, groupId, tzOffset, tz } = ctx;
  const working: LlmMessage[] = [...initialMessages];
  let tools = buildToolDefsForPersona(getDefaultPersona());
  if (!ctx.isPersonal) {
    tools = tools.filter((d) => !PERSONAL_ONLY_TOOL_NAMES.has(d.name as ToolName));
  }
  if (ctx.onlyTools) {
    const only = ctx.onlyTools;
    tools = tools.filter((d) => only.has(d.name));
  }
  if (ctx.sideTools) tools = [...tools, ...[...ctx.sideTools.values()].map((t) => t.def)];
  const suppressed = suppressedAutoFileTools(ctx);
  const personaAllowed = allowedToolsFor(getDefaultPersona());
  if (suppressed.size > 0) {
    // Attachment content is auto-filed deterministically; don't offer the bot
    // those tools or it re-proposes what was already filed.
    tools = tools.filter((d) => !suppressed.has(d.name));
  }
  // ADR 0322 — every tool this chat may use, and the share of it sent now.
  // A side chat (`onlyTools`) already has its own short list.
  const subsetting = env.BOT_TOOL_SUBSET && !ctx.onlyTools;
  const allTools = tools;
  const loadedGroups = subsetting ? turnToolGroups(initialMessages, ctx.toolWords, ctx.toolHints) : new Set<string>();
  const offerTools = (): void => {
    tools = selectToolDefs(allTools, loadedGroups, [moreToolsDef()]);
  };
  if (subsetting) offerTools();
  const startGroups = [...loadedGroups];
  let iterations = 0;
  const cards: BotCard[] = [];
  const turnBundle: TurnBundle = { tripBundleId: null };
  // The reply is the text of each round, with what the model wrote beside a
  // lookup left out (`isLookupTool`): it had not seen the result, so that text is
  // "Let me check your calendar". Pasting every round together put that in
  // the reply, glued to the answer with no space.
  const replyParts: string[] = [];
  const lookupNarration: string[] = [];
  const toolNames: string[] = [];
  const usedFileIds = new Set<string>();
  let attemptedTools = 0;
  // ADR 0244 — "3pm ET" from the user is a zone they chose; only the last few
  // things they said are read, so an old mention does not switch the fix off.
  const zoneNamedInTurn = zoneNamedIn(initialMessages);
  // ADR 0193 — summed across every iteration; the loop can round-trip the
  // provider several times for one bot turn.
  let runUsage: LlmTokenUsage | null = null;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    iterations += 1;
    let iterationText = '';
    const rawCalls: LlmToolCall[] = [];

    // ADR 0022: tokens are buffered, never streamed to the client.
    // ADR 0332: the model gate refuses a round trip once this turn has spent
    // what is left of the user's dollar budget. A later round trip ends the
    // turn with what it has (its spend is still recorded); the first one
    // throws as before, since nothing was spent.
    try {
      for await (const chunk of llm.stream(working, {
        maxTokens: MAX_TURN_TOKENS,
        tools,
        onUsage: (u) => {
          runUsage = addUsage(runUsage, u);
        },
      })) {
        if (chunk.type === 'text') {
          iterationText += chunk.delta;
        } else if (chunk.type === 'tool_call') {
          rawCalls.push(chunk.call);
        } else if (chunk.type === 'done') {
          break;
        }
      }
    } catch (err) {
      if (iter > 0 && err instanceof AllowanceExhaustedError) {
        logger.info('bot turn stopped at the allowance', { botMsgId, iterations });
        break;
      }
      throw err;
    }

    // A call whose arguments couldn't be parsed (the `{ __raw }` sentinel from
    // the provider adapter) means the model was cut off mid-tool-call — almost
    // always a `finish_reason: 'length'` truncation. Echoing such a call back
    // into `working` corrupts the transcript and makes the provider reject the
    // next request with a 400. Drop them before they re-enter the loop.
    const usableCalls = rawCalls.filter((c) => {
      const broken =
        c.args !== null &&
        typeof c.args === 'object' &&
        '__raw' in (c.args as Record<string, unknown>);
      if (broken) {
        logger.warn(`native tool call dropped: truncated arguments for ${c.name}`, {
          botMsgId,
        });
      }
      return !broken;
    });
    const text = iterationText.trim();
    if (usableCalls.length === 0) {
      if (text) replyParts.push(text);
      break;
    }
    if (text) {
      const onlyLookups = usableCalls.every((c) => isLookupTool(c.name) || c.name === MORE_TOOLS_NAME);
      (onlyLookups ? lookupNarration : replyParts).push(text);
    }
    rawCalls.length = 0;
    rawCalls.push(...usableCalls);

    // Echo the assistant message (text + tool_calls) back into the working
    // transcript so the next LLM call sees its own prior turn with tool calls.
    working.push({
      role: 'assistant',
      content: iterationText,
      toolCalls: rawCalls,
    });

    for (const raw of rawCalls) {
      if (subsetting && raw.name === MORE_TOOLS_NAME) {
        // Loading tools is not acting: it doesn't count as an attempt, so a
        // turn that loads and then only talks still gets the strict retry.
        const asked = (raw.args as { groups?: unknown } | null)?.groups;
        const known = (Array.isArray(asked) ? asked : []).filter(
          (g): g is string => typeof g === 'string' && TOOL_GROUPS.some((x) => x.id === g),
        );
        for (const g of known) loadedGroups.add(g);
        offerTools();
        working.push({
          role: 'tool',
          toolCallId: raw.id,
          toolName: raw.name,
          content: JSON.stringify(
            known.length
              ? { loaded: known, instruction: 'These tools are available now. Use them to do what the user asked.' }
              : { error: 'Unknown group.', groups: TOOL_GROUPS.map((g) => g.id) },
          ),
        });
        continue;
      }
      attemptedTools += 1;
      // A tool called by name though it was not sent is still run (sending is
      // a cost choice, not a guard); its group is sent from here on so the
      // model sees its parameters if this call needs another try.
      const calledGroup = subsetting ? groupOfTool(raw.name) : null;
      if (calledGroup && !loadedGroups.has(calledGroup)) {
        loadedGroups.add(calledGroup);
        offerTools();
      }
      const sideTool = ctx.sideTools?.get(raw.name);
      if (sideTool) {
        toolNames.push(raw.name);
        working.push({
          role: 'tool',
          toolCallId: raw.id,
          toolName: raw.name,
          content: JSON.stringify(await runSideTool(sideTool, raw.name, raw.args)),
        });
        continue;
      }
      // Leaving a tool out of `tools` is a hint, not a guard: a model can still
      // call it (from history, or a guessed name). Refuse here what the text-
      // fence path drops, so an attachment's auto-filed content is not
      // proposed twice (ADR 0009) and a persona's policy holds (ADR 0027).
      const offered =
        (!ctx.onlyTools || ctx.onlyTools.has(raw.name)) &&
        !suppressed.has(raw.name) &&
        personaAllowed.has(raw.name as ToolName);
      const validated = offered
        ? validateNativeCall(raw, tzOffset, tz, zoneNamedInTurn)
        : ({ ok: false, reason: `${raw.name} is not available here` } as const);
      if (!validated.ok) {
        logger.warn(`native tool call rejected: ${validated.reason}`);
        if (!ctx.quiet) {
          sseHub.broadcast(groupId, SSE.botTool, {
            messageId: botMsgId,
            name: raw.name,
            summary: validated.reason,
            status: 'error',
          });
        }
        working.push({
          role: 'tool',
          toolCallId: raw.id,
          toolName: raw.name,
          content: JSON.stringify({ error: validated.reason }),
        });
        continue;
      }
      toolNames.push(validated.call.name);
      const toolResult = await executeAndBroadcast({
        db,
        groupId,
        botMsgId,
        triggeringUserId: ctx.triggeringUserId,
        triggeringMessageId: ctx.triggeringMessageId,
        sourceBinding: ctx.sourceBinding,
        tzOffset: ctx.tzOffset,
        tz: ctx.tz,
        call: validated.call,
        cards,
        turnBundle,
        triggerFromAttachment: ctx.triggerHasAttachment,
        isPersonal: ctx.isPersonal,
        quiet: ctx.quiet,
        userText: ctx.userText,
        usedFileIds,
      });
      // Serialize the full structured result (summary + data for read-side
      // tools) so the next iteration can reason about it.
      const payload: Record<string, unknown> = toolResult.ok
        ? { summary: toolResult.summary }
        : {
            error: toolResult.error,
            // Same posture as the ADR 0100 past-date refusal: say what did not
            // happen and forbid the invention of a reason. Without it a failed
            // create_event was reported to the user as an existing meeting.
            instruction:
              'Tell the user plainly that this did not go through and they can try again. ' +
              'Do NOT say it worked, and do NOT explain the failure as if it were a fact ' +
              'about their calendar, tasks or lists.',
          };
      if (toolResult.ok && toolResult.data !== undefined) {
        Object.assign(payload, toolResult.data as object);
      }
      working.push({
        role: 'tool',
        toolCallId: raw.id,
        toolName: raw.name,
        content: JSON.stringify(payload),
      });
    }
  }

  // ADR 0322 — what a turn was sent and what it cost, to check the selection
  // in the logs (token_usage keeps only the turn's sum).
  // Set inside the onUsage callback, which TypeScript's narrowing cannot see.
  const turnUsage = runUsage as LlmTokenUsage | null;
  logger.info('bot turn tools', {
    botMsgId,
    subset: subsetting,
    startGroups,
    loadedLater: [...loadedGroups].filter((g) => !startGroups.includes(g)),
    toolsSent: tools.length,
    toolsAvailable: allTools.length,
    iterations,
    promptTokens: turnUsage?.promptTokens ?? null,
    cachedTokens: turnUsage?.cachedTokens ?? null,
    costUsd: turnUsage?.costUsd ?? null,
  });
  // Narration is still better than an empty reply (a turn that ran out of
  // rounds, or answered before its lookup and said nothing after).
  const body = (replyParts.length ? replyParts : lookupNarration).join('\n\n');
  return {
    body,
    cards,
    toolNames,
    attemptedTools,
    tokenUsage: turnUsage,
    usedFileIds: [...usedFileIds],
  };
}

/** A tool only one surface offers; `run` answers it without the executor. */
export interface SideTool {
  def: LlmToolDef;
  run(args: unknown): Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * A side tool that throws answers the model like a thrown executor tool
 * (ADR 0102: one fixed sentence, never the error's own words) instead of
 * ending the whole turn - a Findings hand-off whose address lookup hit the
 * database lost the user's answer along with it.
 */
async function runSideTool(tool: SideTool, name: string, args: unknown): Promise<Record<string, unknown>> {
  try {
    return await tool.run(args);
  } catch (err) {
    logger.error(`side tool ${name} failed`, { err, args: toolArgShape(args) });
    return {
      error: toolErrorForModel(err),
      instruction:
        'Tell the user plainly that this did not go through and they can try again. ' +
        'Do NOT say it worked, and do NOT explain the failure as if it were a fact about their mail.',
    };
  }
}

/**
 * One turn of a side chat (ADR 0277): the caller supplies the whole prompt
 * and the tools it may use; nothing is stored, broadcast or posted to a chat.
 * `groupId` is the scope the tools read under (the personal chat, for mail).
 */
export async function runSideChatTurn(
  db: Kysely<DB>,
  llm: LlmService,
  messages: LlmMessage[],
  opts: {
    groupId: string;
    userId: string;
    tz: string | null;
    onlyTools: ReadonlySet<string>;
    sideTools?: ReadonlyMap<string, SideTool>;
  },
): Promise<{ body: string; cards: BotCard[]; tokenUsage: LlmTokenUsage | null }> {
  const ctx: TurnCtx = {
    botMsgId: newId('m'),
    groupId: opts.groupId,
    triggeringUserId: opts.userId,
    triggeringMessageId: null,
    tzOffset: opts.tz ? tzToOffset(opts.tz) : '+00:00',
    tz: opts.tz,
    sourceBinding: null,
    chordVisible: 1,
    isPersonal: true,
    triggerHasAttachment: false,
    triggerAttachmentIsImage: false,
    onlyTools: opts.onlyTools,
    sideTools: opts.sideTools,
    quiet: true,
    userText: messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')).reverse(),
  };
  const result = llm.supportsNativeTools
    ? await runNativeLoop(db, llm, messages, ctx)
    : await runTextFenceTurn(db, llm, messages, ctx);
  return { body: result.body, cards: result.cards, tokenUsage: result.tokenUsage };
}

/**
 * ADR 0335 — one tool call from an outside AI app (the MCP connector). The
 * same checks a chat turn's call passes (schema, time anchoring, the
 * personal-only gate, the ADR 0032 scrubber, the fixed failure sentence), run
 * in the user's personal chat, with every write staged as a proposal the
 * user confirms in Chord. Nothing is posted or broadcast as a bot reply.
 */
export async function runToolForAiApp(
  db: Kysely<DB>,
  opts: { userId: string; groupId: string; tz: string | null; name: string; args: unknown; provenance: string },
): Promise<ExecResult> {
  const tzOffset = opts.tz ? tzToOffset(opts.tz) : '+00:00';
  const validated = validateNativeCall({ id: newId('call'), name: opts.name, args: opts.args ?? {} }, tzOffset, opts.tz);
  if (!validated.ok) return { ok: false, error: validated.reason };
  return executeAndBroadcast({
    db,
    groupId: opts.groupId,
    botMsgId: newId('m'),
    triggeringUserId: opts.userId,
    triggeringMessageId: null,
    sourceBinding: null,
    tzOffset,
    tz: opts.tz,
    call: validated.call,
    cards: [],
    turnBundle: { tripBundleId: null },
    triggerFromAttachment: false,
    isPersonal: true,
    quiet: true,
    provenance: opts.provenance,
    stageWrites: true,
  });
}

/**
 * The fields where a model writes a NEW time for the user's own calendar or
 * to-dos (ADR 0244). Only these are checked for an offset stamped from
 * today: a time that identifies something already stored (a leg's
 * departure, an event being looked up) carries the offset it was stored
 * with, and a travel leg is put on its airport's clock by `legDatetime`.
 */
const NEW_TIME_FIELDS: Partial<Record<ToolName, readonly string[]>> = {
  create_event: ['startsAt', 'endsAt'],
  update_event: ['startsAt', 'endsAt'],
  create_task: ['dueAt', 'remindAt'],
  update_task: ['dueAt', 'remindAt'],
  add_reservation: ['dateTime'],
};

/**
 * Where a tool call says its time happens (ADR 0245): an event's `location`,
 * a reservation's `address`. A time there is on that place's clock.
 */
const PLACE_FIELD: Partial<Record<ToolName, string>> = {
  create_event: 'location',
  update_event: 'location',
  add_reservation: 'address',
};

/** A tool whose field holds another tool's arguments, run as that tool. */
const NESTED_TIME_CALL: Partial<Record<ToolName, { field: string; as: ToolName }>> = {
  message_user: { field: 'event', as: 'create_event' },
};

/**
 * Put the times a model just wrote on the right clock, for BOTH tool paths
 * (native calls and text fences): on the place's clock when the call names a
 * place the table knows, otherwise on the user's own clock for that date
 * rather than today's (ADR 0244). Left as written when the user named a time
 * zone themselves. Mutates and returns `args`.
 */
export function anchorModelTimes(
  name: string,
  args: unknown,
  tzOffset: string,
  tz: string | null,
  zoneNamed: boolean,
): unknown {
  // `message_user`'s `event` is a `create_event` the executor runs as one, so
  // its times get the same clock (it once got none, being nested).
  const nested = NESTED_TIME_CALL[name as ToolName];
  if (nested && args && typeof args === 'object') {
    const inner = (args as Record<string, unknown>)[nested.field];
    if (inner && typeof inner === 'object') anchorModelTimes(nested.as, inner, tzOffset, tz, zoneNamed);
    return args;
  }
  const fields = NEW_TIME_FIELDS[name as ToolName];
  if (!fields || !args || typeof args !== 'object') return args;
  const a = args as Record<string, unknown>;
  // ADR 0297 — a zone the call names outright: its times are that zone's clock.
  if (typeof a.timeZone === 'string' && isValidTimeZone(a.timeZone)) {
    for (const f of fields) {
      const v = a[f];
      if (typeof v === 'string') a[f] = legDatetime(v, undefined, a.timeZone, offsetMinutesOf(tzOffset), tz);
    }
    return a;
  }
  if (!tz || zoneNamed) return args;
  const placeField = PLACE_FIELD[name as ToolName];
  const place = placeField && typeof a[placeField] === 'string' ? (a[placeField] as string) : null;
  for (const f of fields) {
    const v = a[f];
    if (typeof v !== 'string') continue;
    const there = place ? placeDatetime(v, place, offsetMinutesOf(tzOffset), tz) : null;
    a[f] = there?.zone ? there.at : reanchorNowStampedOffset(v, tz);
  }
  return a;
}

/** Did the user name a time zone in the last few things they said? */
function zoneNamedIn(messages: LlmMessage[]): boolean {
  return namesATimeZone(
    messages
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n'),
  );
}

export function validateNativeCall(
  raw: LlmToolCall,
  tzOffset: string,
  tz: string | null,
  /** The user named a time zone themselves this turn: leave offsets as written. */
  zoneNamed = false,
):
  | { ok: true; call: ToolCall }
  | { ok: false; reason: string } {
  if (!isToolName(raw.name)) return { ok: false, reason: `unknown tool: ${raw.name}` };
  const schema = toolSchemas[raw.name];
  const normalizedArgs = normalizeDatetimes(raw.args, tzOffset, tz);
  anchorModelTimes(raw.name, normalizedArgs, tzOffset, tz, zoneNamed);
  const parsed = schema.safeParse(normalizedArgs);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `invalid args for ${raw.name}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  return { ok: true, call: { name: raw.name, args: parsed.data } };
}

export type ExecResult =
  | { ok: true; summary: string; data?: unknown }
  | { ok: false; error: string };

/**
 * Per-turn bundle state (ADR 0009). When `create_trip` is proposed in this
 * turn, `tripBundleId` is set so subsequent `add_travel_leg` /
 * `add_accommodation` / `add_reservation` proposals in the same turn join
 * the same bundle — approving one commits the whole trip.
 */
interface TurnBundle {
  tripBundleId: string | null;
}

const TRIP_CHILD_TOOLS: ReadonlySet<string> = new Set([
  'add_travel_leg',
  'add_accommodation',
  'add_reservation',
]);

function bundleIdForCall(turnBundle: TurnBundle, call: ToolCall): string | null {
  if (call.name === 'create_trip') {
    // First create_trip in this turn opens a bundle; later ones start fresh.
    if (!turnBundle.tripBundleId) turnBundle.tripBundleId = newId('bundle');
    return turnBundle.tripBundleId;
  }
  if (TRIP_CHILD_TOOLS.has(call.name) && turnBundle.tripBundleId) {
    return turnBundle.tripBundleId;
  }
  return null;
}

interface ExecuteAndBroadcastOpts {
  db: Kysely<DB>;
  groupId: string;
  botMsgId: string;
  triggeringUserId: string | null;
  triggeringMessageId: string | null;
  sourceBinding: TurnCtx['sourceBinding'];
  tzOffset: string;
  tz: string | null;
  call: ToolCall;
  cards: BotCard[];
  turnBundle: TurnBundle;
  /** ADR 0155 — the trigger carried an uploaded file, so a past create_event /
   *  update_event is history from that document, not a typo to ask about. */
  triggerFromAttachment: boolean;
  /** The turn's chat is the personal 1:1; else personal-only tools refuse. */
  isPersonal: boolean;
  quiet?: boolean;
  userText?: string[];
  usedFileIds?: Set<string>;
  /** Overrides the `chat:<message>` provenance (ADR 0335: `connector:<grant>`). */
  provenance?: string;
  /** ADR 0335 — stage every write as a proposal, not only PROPOSABLE_TOOLS. */
  stageWrites?: boolean;
}

/**
 * A tool call that ran without throwing but whose own result says nothing
 * happened — `created: false`, `updated: false`, a past-date refusal, an
 * unresolvable repeat, a scope/ambiguous-match question, … Every one of
 * these returns normally (not a thrown error), so without this check the
 * tool pill showed "created event · <the refusal, verbatim>" — styled
 * exactly like a real success, because `executeAndBroadcast`'s only signal
 * was "did it throw", never "what did it actually do".
 *
 * Deliberately generic rather than per-tool: the executor's own refusal
 * shapes already agree on naming the outcome after its verb
 * (`created`/`updated`/`deleted`/`cancelled`/`merged`/`sent`/`added`), so
 * reading any of those as `false` catches the whole class without a
 * per-case switch that would need updating every time a new refusal shape
 * is added. A tool whose result carries none of these keys (a pure read,
 * or a shape not yet using this convention) is simply not flagged —
 * false negatives here are "still shows as ok", not a new failure mode.
 */
export function declinedOutcome(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const rec = data as Record<string, unknown>;
  return ['created', 'updated', 'deleted', 'cancelled', 'merged', 'sent', 'added'].some(
    (k) => rec[k] === false,
  );
}

const FILE_TOOLS = new Set(['look_at_attachment', 'reference_file', 'send_file']);

/** The file a file tool actually reached. Each one's success result carries
 *  `attachmentId`; a refusal (not found, not visible, blob missing) does not. */
export function fileToolTarget(name: string, data: unknown): string | null {
  if (!FILE_TOOLS.has(name) || !data || typeof data !== 'object') return null;
  const id = (data as Record<string, unknown>).attachmentId;
  return typeof id === 'string' ? id : null;
}

async function executeAndBroadcast(opts: ExecuteAndBroadcastOpts): Promise<ExecResult> {
  const { db, groupId, botMsgId, call, cards } = opts;
  // The one personal-only gate both turn paths pass through. The native path
  // only left these tools out of the offered list, so a model that called one
  // anyway (from history, or a name it guessed) ran it in a shared group.
  if (!opts.isPersonal && PERSONAL_ONLY_TOOL_NAMES.has(call.name as ToolName)) {
    const msg = `${call.name} is only available in your personal chat with Chord, and NOTHING was done`;
    logger.warn(`bot tool refused: personal-only tool ${call.name} in a shared chat`, { groupId });
    if (!opts.quiet) {
      sseHub.broadcast(groupId, SSE.botTool, { messageId: botMsgId, name: call.name, summary: msg, status: 'error' });
    }
    return { ok: false, error: msg };
  }
  try {
    // ADR 0009: bot-initiated write tools route through propose mode. The
    // executor stages proposable tools via the proposals table; everything
    // else commits as before.
    const result = await applyToolCall(db, {
      groupId,
      call,
      actorUserId: opts.triggeringUserId,
      // ADR 0162 — a real pointer to the triggering chat message, not a
      // hardcoded null, so create_event (and anything else reading
      // provenance) can excerpt "what led to this" the same way an
      // email-derived event already can via `gmail:<threadId>`.
      provenance: opts.provenance ?? (opts.triggeringMessageId ? `chat:${opts.triggeringMessageId}` : null),
      mode: 'propose',
      triggeringMessageId: opts.triggeringMessageId,
      bundleId: bundleIdForCall(opts.turnBundle, call),
      sourceBinding: opts.sourceBinding,
      tzOffset: opts.tzOffset,
      tz: opts.tz,
      turnId: botMsgId,
      triggerFromAttachment: opts.triggerFromAttachment,
      userText: opts.userText,
      stageWrites: opts.stageWrites,
    });
    logger.info(`bot tool exec: ${result.summary}`, { args: toolArgShape(call.args) });
    if (!opts.quiet) sseHub.broadcast(groupId, SSE.botTool, {
      messageId: botMsgId,
      name: call.name,
      summary: result.summary,
      status: declinedOutcome(result.data) ? 'declined' : 'ok',
    });
    if (result.card) cards.push(result.card);
    if (result.cards) cards.push(...result.cards);
    const usedId = fileToolTarget(call.name, result.data);
    if (usedId) opts.usedFileIds?.add(usedId);
    return { ok: true, summary: result.summary, data: result.data };
  } catch (err) {
    logger.error(`tool ${call.name} failed`, { err, args: toolArgShape(call.args) });
    const msg = toolErrorForModel(err);
    if (!opts.quiet) sseHub.broadcast(groupId, SSE.botTool, {
      messageId: botMsgId,
      name: call.name,
      summary: msg,
      status: 'error',
    });
    return { ok: false, error: msg };
  }
}

/**
 * What a thrown tool gets to tell the model.
 *
 * Never the driver's own words. A `create_event` that hit a unique-index
 * violation handed the model `duplicate key value violates unique constraint
 * "events_external_uid_per_group"`, which it relayed to the user as "you
 * already have a meeting with Sharon at 3:30" — a fact about their calendar
 * invented out of a Postgres string, for an event that was never written and
 * a calendar that was empty. An internal failure is not information about the
 * user's data, and anything the model can paraphrase, it will.
 *
 * Application errors raised deliberately (TrustError and friends) still speak
 * for themselves; a pg error carries a five-character SQLSTATE, and anything
 * unrecognized is treated as internal too — silence is safer than a leak.
 */
function toolErrorForModel(err: unknown): string {
  // TrustError is the one failure that is really about the request rather than
  // about us — but its own message carries raw user ids, so it is restated,
  // not forwarded.
  if ((err as { code?: unknown } | null)?.code === 'TRUST_DENIED') {
    return 'that person has not approved writes to their calendar or task list yet';
  }
  return (
    'the tool failed inside the server and NOTHING was written — no record was ' +
    'created, updated or deleted'
  );
}
