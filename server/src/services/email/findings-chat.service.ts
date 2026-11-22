/**
 * The Findings tab's own chat about the user's mail (ADR 0277). A tapped
 * sample question used to be posted into the personal chat and the app
 * jumped there; now it is answered in place. The client holds the
 * conversation and sends it whole each turn, the server stores nothing, and
 * the model sees only this conversation plus read-only mail tools, so the
 * personal chat's history neither leaks in nor is added to.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { FindingsChatRequest, FindingsChatResult } from '@chord/kernel';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { zoneOrDefault } from '../availability.service.js';
import { getDefaultPersona } from '../bot-personas.service.js';
import { runSideChatTurn, type SideTool } from '../bot/bot.service.js';
import { localTimeBlock } from '../bot/context.js';
import { MAIL_QUESTION_RECIPES, TEXT_FENCE_TOOL_PROMPT } from '../bot/tools.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { byokFailureMessage, classifyLlmError } from '../llm/errors.js';
import { resolveTurnLlm } from '../llm/factory.js';
import type { LlmMessage, LlmService } from '../llm/types.js';
import { recordTokenUsage } from '../tokens.service.js';
import { ComposeFailedError, requireEntitled } from './compose-reply.service.js';
import { addressesIn, unknownAddresses } from './known-addresses.js';

/** Read-only: nothing said here changes the mailbox, a list or a to-do. */
export const FINDINGS_CHAT_TOOLS: ReadonlySet<string> = new Set([
  'query_mail_senders',
  'query_receipts',
  'list_subscriptions',
  'search',
  'read_email',
]);

const FAILED = 'Could not answer that just now. Try again.';

export const HANDOFF_TOOL = 'hand_off_to_chat';

const HandoffArgs = z.object({ request: z.string().trim().min(1).max(1000) });

const HANDOFF_DESCRIPTION =
  'Send a request for a CHANGE to the user\'s Chord chat, which can act on it: unsubscribing from a mailing list, adding a to-do, reminder, event or list item, replying to, forwarding or trashing an email. The app shows `request` to the user word for word with a Send to chat button; only if they tap it is it posted to that chat, where the assistant acts on it without having seen this conversation. So `request` is ONE message in the user\'s own first-person words that stands alone and names exactly what it is about, using what your tools returned: the sender\'s name AND address for an unsubscribe ("Unsubscribe me from the Target mailing list, target@e.target.com"), each address copied exactly from a tool result (list_subscriptions `senderEmail`) - never write an address you did not get from a tool, and give the name alone if you have no address; the email\'s subject, sender and date when it is about one email; the title, date and amount for a to-do ("Add a to-do on Nov 2 to review my Netflix subscription, $15.49 a month"). If you do not yet have the exact sender or email, look it up first. Call it only for a clear request; if it is unclear which one they mean, ask. After calling it, say in one short sentence that the message is below for them to send to their chat. Never say it is done or already sent.';

function systemPrompt(tz: string, fenceTools: boolean): string {
  return [
    `You are ${getDefaultPersona().promptName}, answering questions about the user's own email in the Findings tab of the Chord app.`,
    'This conversation is separate from their chat with you: use only what is said here and what your tools return.',
    `Your other tools only READ. When the user wants something changed (unsubscribe, a to-do or event, a reply), call ${HANDOFF_TOOL}. Never say you did it yourself.`,
    'Keep answers short. Use a short list when naming several senders, receipts or emails. State only what the tools returned; if a tool found nothing, say so.',
    localTimeBlock(tz),
    MAIL_QUESTION_RECIPES.trim(),
    ...(fenceTools
      ? [
          TEXT_FENCE_TOOL_PROMPT,
          `Also available here: ${HANDOFF_TOOL} { request: string } — ${HANDOFF_DESCRIPTION}`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function findingsChat(
  db: Kysely<DB>,
  userId: string,
  input: FindingsChatRequest,
  opts: { llm?: LlmService } = {},
): Promise<FindingsChatResult> {
  await requireEntitled(db, userId, opts);

  let llm = opts.llm;
  let byok = false;
  if (!llm) {
    const resolved = await resolveTurnLlm(db, userId);
    llm = resolved.llm;
    byok = resolved.tier === 'byok';
  }

  let tz = input.tz ? zoneOrDefault(input.tz) : null;
  if (!tz) {
    const me = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
    tz = zoneOrDefault(me?.last_tz);
  }
  const personal = await ensurePersonalGroup(db, userId);

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt(tz, !llm.supportsNativeTools) },
    ...input.messages.map((m): LlmMessage => ({ role: m.role, content: m.text })),
  ];

  let handoff: string | null = null;
  const handoffTool: SideTool = {
    def: {
      name: HANDOFF_TOOL,
      description: HANDOFF_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: { request: { type: 'string', maxLength: 1000 } },
        required: ['request'],
      },
    },
    async run(args) {
      const parsed = HandoffArgs.safeParse(args);
      if (!parsed.success) return { error: '`request` must be a non-empty message' };
      // The request becomes the user's own message once they tap Send, so an
      // address in it must be one the user typed or one their mail actually
      // has. Prod: twelve lists handed over as `name@example.com` matched nothing.
      const typed = input.messages.filter((m) => m.role === 'user').map((m) => m.text.toLowerCase()).join('\n');
      const unknown = await unknownAddresses(db, userId, addressesIn(parsed.data.request), typed);
      if (unknown.length) {
        logger.warn('findings handoff refused: addresses not in the user mail', { userId, count: unknown.length });
        return {
          handedOff: false,
          error: 'These addresses are not in the user\'s mail and were not typed by them, so nothing was handed over.',
          unknownAddresses: unknown,
          instruction:
            'Call list_subscriptions (or search) and copy each `senderEmail` exactly, or give the name alone, then call this again.',
        };
      }
      // One change per turn: a second call replaces nothing already sent.
      handoff ??= parsed.data.request;
      return {
        handedOff: true,
        sent: false,
        instruction:
          'NOTHING has been sent yet: the user sees this message and decides whether to send it to their chat. ' +
          'Say in one short sentence that it is below for them to send. Do not say it is done or sent.',
      };
    },
  };

  let out: Awaited<ReturnType<typeof runSideChatTurn>>;
  try {
    out = await runSideChatTurn(db, llm, messages, {
      groupId: personal.id,
      userId,
      tz,
      onlyTools: FINDINGS_CHAT_TOOLS,
      sideTools: new Map([[HANDOFF_TOOL, handoffTool]]),
    });
  } catch (err) {
    logger.error('findings chat llm call failed', { err, provider: llm.providerName });
    const fixable = byok ? byokFailureMessage(llm.providerName, classifyLlmError(err).kind) : null;
    throw new ComposeFailedError(fixable ?? FAILED);
  }

  // ADR 0196 — recording IS the debit; BYOK is their key, their cost.
  if (out.tokenUsage && !byok) {
    await recordTokenUsage(db, {
      userId,
      source: 'bot_turn',
      ref: `findings:${Date.now()}`,
      model: llm.defaultModel,
      promptTokens: out.tokenUsage.promptTokens,
      completionTokens: out.tokenUsage.completionTokens,
      cachedTokens: out.tokenUsage.cachedTokens,
      costUsd: out.tokenUsage.costUsd,
    }).catch((err) => logger.warn('findings chat token usage write failed', { err }));
  }

  const reply = out.body.trim();
  const handoffMessage = handoff as string | null;
  return {
    reply: reply || (handoffMessage ? 'Here is a message to send to your chat. Tap Send to chat to do it.' : FAILED),
    ...(handoffMessage ? { handoff: { message: handoffMessage } } : {}),
    cards: out.cards
      .filter((c) => c.title && (c.href || c.url))
      .slice(0, 20)
      .map((c) => ({ title: c.title, subtitle: c.subtitle, meta: c.meta, href: c.href, url: c.url })),
  };
}
