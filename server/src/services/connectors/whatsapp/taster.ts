/**
 * WhatsApp taster turn accounting + the signup footer (ADR 0053).
 *
 * The original shape was ten silent answers followed by a hard wall: the
 * first time a stranger heard about Chord was the message that stopped
 * helping them. That spends the whole allowance buying zero awareness, and
 * attaches the ask to a refusal — the worst moment to make it.
 *
 * Instead the ask rides along with the answers, starting on the first one,
 * while the bot is visibly useful. The footer is deliberately written for
 * someone who ALREADY has a Chord account as much as for a newcomer: the
 * common case is a signed-up user messaging from a number Chord can't yet
 * tie to them, and "sign up" is the wrong instruction for them.
 *
 * Footer cadence over a 5-turn allowance: turns 1, 3, and 5 — present
 * without nagging, and the last answer says it is the last one, so the wall
 * is never a surprise.
 */
import type { Kysely } from 'kysely';

import { env } from '../../../config/env';
import type { DB } from '../../../db/schema';

export interface TasterState {
  /** The group's owner is an unsigned shadow, so the allowance applies. */
  applies: boolean;
  /** Reactive bot turns already served in this personal group. */
  used: number;
  limit: number;
  /** Allowance exhausted — the caller should nudge instead of answering. */
  spent: boolean;
}

const NOT_APPLICABLE: TasterState = {
  applies: false,
  used: 0,
  limit: 0,
  spent: false,
};

/**
 * Turn accounting for a WhatsApp taster.
 *
 * `ownerUserId` is whoever the allowance is charged to: the sender on the
 * inbound gate, the personal group's owner on the outbound side (where the
 * message being sent is the bot's own). Proactive nudges are excluded from
 * the count — they aren't user-triggered, so they shouldn't burn allowance.
 */
export async function tasterState(
  db: Kysely<DB>,
  groupId: string,
  ownerUserId: string | null,
): Promise<TasterState> {
  const limit = env.WHATSAPP_TASTER_TURNS;
  if (limit <= 0 || !ownerUserId) return NOT_APPLICABLE;

  const u = await db
    .selectFrom('users')
    .select('shadow')
    .where('id', '=', ownerUserId)
    .executeTakeFirst();
  if (!u || u.shadow !== 1) return NOT_APPLICABLE; // real user → unlimited

  const served = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('group_id', '=', groupId)
    .where('kind', '=', 'bot')
    .where('is_proactive', '=', 0)
    .executeTakeFirst();
  const used = Number(served?.n ?? 0);
  return { applies: true, used, limit, spent: used >= limit };
}

/**
 * Whether this turn carries a footer, given the turn number (1-based, the
 * reply about to go out included).
 */
export function footerDueOnTurn(turn: number, limit: number): boolean {
  if (turn < 1 || limit <= 0) return false;
  if (turn === 1 || turn >= limit) return true;
  return turn % 3 === 0;
}

/**
 * The footer text for a turn, or null when this turn carries none.
 *
 * Three voices: an introduction (the recipient may not know what answered
 * them), a periodic reminder, and a final notice on the last free answer.
 */
export function tasterFooter(
  turn: number,
  limit: number,
  link: string,
): string | null {
  if (!link || !footerDueOnTurn(turn, limit)) return null;
  if (turn >= limit) {
    return (
      `— That was the last answer I can give an unlinked chat. ` +
      `Connect it to your Chord account — or create one — to carry on: ${link}`
    );
  }
  if (turn === 1) {
    return (
      `— I'm Chord. Connect this chat to your account to keep your lists, ` +
      `reminders and calendar together — already have one? The same link ` +
      `works: ${link}`
    );
  }
  return `— Connect this chat to your Chord account: ${link}`;
}

/** Append a footer to a reply body, blank line between. */
export function withFooter(body: string, footer: string | null): string {
  return footer ? `${body}\n\n${footer}` : body;
}
