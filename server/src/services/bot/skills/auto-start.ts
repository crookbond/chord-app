/**
 * ADR 0299 addendum — starting a skill without a model.
 *
 * Onboarding starts by itself on a user's first use, with no button. Two
 * moments count as first use: agreeing to AI use (ADR 0283, which every new
 * user does before the bot can answer) and, where consent is not required,
 * the first message in their personal chat. "Fresh" is judged from the data:
 * a real account (not a taster shadow, ADR 0098), onboarding never started,
 * and at most one message of theirs in the personal chat (the one that
 * triggered this).
 *
 * After that a skill runs only when asked: in words, or by its slash command
 * (`/onboard`, `/plan`), which is read here in code.
 */
import type { Kysely } from 'kysely';

import { SSE } from '@chord/kernel';

import type { DB, MessagesTable } from '../../../db/schema.js';
import { newId } from '../../../utils/ids.js';
import { getDefaultPersona } from '../../bot-personas.service.js';
import { ensurePersonalGroup } from '../../groups.service.js';
import { rowToMessage } from '../../messages.service.js';
import { sseHub } from '../../sse.hub.js';
import { allSkills, startSkill, type Skill, type StepView } from './index.js';
import { choicesCard } from './tool-result.js';

const OPENING =
  'Let me get to know you and your family so I can help. A few quick questions: skip any you like, or say "later" and we can finish another time.';

/** Start onboarding if this is the user's first use. `post` writes the opening
 *  question into their personal chat; without it, the turn already running
 *  asks it. True when a question is now open. */
export async function maybeStartOnboarding(
  db: Kysely<DB>,
  userId: string,
  opts: { post: boolean },
): Promise<boolean> {
  const user = await db.selectFrom('users').select('shadow').where('id', '=', userId).executeTakeFirst();
  if (!user || user.shadow === 1) return false;
  const run = await db
    .selectFrom('skill_runs')
    .select('id')
    .where('user_id', '=', userId)
    .where('skill_id', '=', 'onboarding')
    .executeTakeFirst();
  if (run) return false;

  const personal = await ensurePersonalGroup(db, userId);
  const said = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('group_id', '=', personal.id)
    .where('sender_id', '=', userId)
    .executeTakeFirst();
  if (Number(said?.n ?? 0) > 1) return false;

  const started = await startSkill(db, { userId, groupId: personal.id, skillId: 'onboarding' });
  if ('error' in started || !started.step) return false;
  if (opts.post) await postSkillQuestion(db, personal.id, `${OPENING}\n\n${started.step.ask}`, started.step, null);
  return true;
}

/** `/onboard`, `/plan`: the skill a slash command names, or null. */
export function parseSkillCommand(body: string | null | undefined): Skill | null {
  const m = /^\s*\/([a-z_-]+)\s*$/i.exec(body ?? '');
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  return allSkills().find((s) => s.command === name || s.id === name) ?? null;
}

/**
 * Run a slash command in the personal chat, without a model. A paused or
 * running skill resumes; a finished or stopped one starts again (the answers
 * stay saved, so their questions are skipped). `posted` = the reply is
 * already in the chat; `continue` = the turn should run, with the skill open,
 * because the model must read something before it asks.
 */
export async function runSkillCommand(
  db: Kysely<DB>,
  /** `messageId`: the turn's own reply id, whose placeholder is already showing. */
  input: { userId: string; groupId: string; skill: Skill; replyToId: string; messageId: string },
): Promise<'posted' | 'continue'> {
  const prior = await db
    .selectFrom('skill_runs')
    .select('status')
    .where('user_id', '=', input.userId)
    .where('skill_id', '=', input.skill.id)
    .executeTakeFirst();
  const restart = prior?.status === 'done' || prior?.status === 'stopped';
  const out = await startSkill(db, {
    userId: input.userId,
    groupId: input.groupId,
    skillId: input.skill.id,
    restart,
  });
  if ('error' in out) return 'continue';
  if (!out.step) {
    await postSkillQuestion(
      db,
      input.groupId,
      `Nothing left to ask for ${out.skill.title}: it is all answered already.`,
      null,
      { replyToId: input.replyToId, id: input.messageId },
    );
    return 'posted';
  }
  if (!input.skill.opensWithQuestion) return 'continue';
  const intro = out.status === 'resumed' ? 'Picking up where we left off.' : OPENING;
  await postSkillQuestion(db, input.groupId, `${intro}\n\n${out.step.ask}`, out.step, {
    replyToId: input.replyToId,
    id: input.messageId,
  });
  return 'posted';
}

/** Post a bot message into the chat without a model. `reply` makes it the
 *  turn's own reply (same id as the placeholder already showing). */
export async function postSkillQuestion(
  db: Kysely<DB>,
  groupId: string,
  body: string,
  step: StepView | null,
  reply: { replyToId: string; id: string } | null,
): Promise<void> {
  const row: MessagesTable = {
    id: reply?.id ?? newId('m'),
    group_id: groupId,
    sender_id: null,
    kind: 'bot',
    body,
    attachment_id: null,
    reply_to_id: reply?.replyToId ?? null,
    mentions_bot: 0,
    created_at: new Date().toISOString(),
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: getDefaultPersona().id,
    // In the model's history on purpose: the next turn should see it asked.
    is_proactive: 0,
  };
  await db.insertInto('messages').values(row).execute();
  const card = step ? choicesCard(step) : undefined;
  if (card) {
    await db
      .insertInto('message_cards')
      .values({ message_id: row.id, cards_json: JSON.stringify([card]), created_at: row.created_at })
      .execute();
  }
  if (reply) sseHub.broadcast(groupId, SSE.botDone, { messageId: row.id });
  sseHub.broadcast(groupId, SSE.message, rowToMessage(row, card ? JSON.stringify([card]) : undefined));
  if (card) sseHub.broadcast(groupId, SSE.botCard, { messageId: row.id, cards: [card] });
}
