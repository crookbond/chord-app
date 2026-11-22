/**
 * ADR 0293 addendum 2026-11-02 — a Microsoft sign-in that made a NEW account
 * for a mailbox another account already reads is usually one person with two
 * accounts. Nothing is merged here (only connecting Google from inside the
 * new account proves both logins are one person, 2026-10-28 addendum); both
 * accounts are told, in their personal chat, how to combine them.
 *
 * The new account is never told WHICH account reads the mailbox: it may be a
 * parent's account that reads a child's school mailbox. The existing account
 * already holds that mailbox, so naming it there tells it nothing new.
 */
import { SSE } from '@chord/kernel';
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { postMessage } from '../messages.service.js';
import { sseHub } from '../sse.hub.js';

/** Other real accounts that read this address: as an attached mailbox, or as
 *  the address they signed in with. Only accounts with a Google login are
 *  returned, since connecting Google is the only way the two can be combined. */
async function otherAccountsReading(
  db: Kysely<DB>,
  newUserId: string,
  address: string,
): Promise<Array<{ id: string; email: string | null }>> {
  const lower = address.trim().toLowerCase();
  return db
    .selectFrom('users')
    .select(['users.id', 'users.email'])
    .where('users.id', '!=', newUserId)
    .where('users.shadow', '=', 0)
    .where('users.google_sub', 'is not', null)
    .where((eb) =>
      eb.or([
        eb(eb.fn('lower', ['users.email']), '=', lower),
        eb.exists(
          eb
            .selectFrom('email_accounts')
            .select('email_accounts.id')
            .whereRef('email_accounts.user_id', '=', 'users.id')
            .where((sub) => sub(sub.fn('lower', ['email_accounts.email_address']), '=', lower)),
        ),
      ]),
    )
    .orderBy('users.created_at', 'asc')
    .execute();
}

async function post(db: Kysely<DB>, userId: string, body: string): Promise<void> {
  const personal = await ensurePersonalGroup(db, userId);
  const message = await postMessage(db, { groupId: personal.id, senderId: null, body, mentionsBot: false });
  sseHub.broadcast(personal.id, SSE.message, message);
}

export function newAccountNotice(address: string): string {
  return (
    `Chord made a new account for ${address}. If you already use Chord with a Google account, ` +
    'you now have two. To combine them, go to Settings, Connected accounts, Google here, and connect that ' +
    'Google account: this account and its Outlook mailbox move into it, and the next Sign in with ' +
    'Microsoft opens it.'
  );
}

export function existingAccountNotice(address: string, googleEmail: string | null): string {
  const which = googleEmail ? `your Google account (${googleEmail})` : 'your Google account';
  return (
    `Someone signed in to Chord with Microsoft as ${address}, a mailbox this account reads, and got a ` +
    `separate account. If that was you and you want one account: sign in with Microsoft, go to Settings, ` +
    `Connected accounts, Google, and connect ${which}. The Microsoft account then moves into this one. ` +
    'If it was not you, nothing here has changed.'
  );
}

/** Best-effort: a failed notice never fails the sign-in. */
export async function tellAboutSecondAccount(
  db: Kysely<DB>,
  newUserId: string,
  address: string,
): Promise<void> {
  try {
    const others = await otherAccountsReading(db, newUserId, address);
    if (others.length === 0) return;
    await post(db, newUserId, newAccountNotice(address));
    for (const other of others) {
      await post(db, other.id, existingAccountNotice(address, other.email));
    }
    logger.info('microsoft sign-in made a second account; both told', {
      newUserId,
      others: others.map((o) => o.id),
    });
  } catch (err) {
    logger.warn('second-account notice failed', { newUserId, err: (err as Error).message });
  }
}
