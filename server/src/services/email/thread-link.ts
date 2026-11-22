/**
 * ADR 0158 — resolve a `gmail:<threadId>` provenance string to a link that
 * opens the source email in its provider (ADR 0107's `providerThreadLink`), for
 * embedding in a travel leg's calendar-event description.
 *
 * Handles both the primary Gmail (`account_id NULL`, ADR 0080) and an attached
 * mailbox, whose stored `gmail_thread_id` is account-PREFIXED (`<id>:<native>`).
 */
import type { Kysely } from 'kysely';

import { providerThreadLink, type ProviderLink } from '@chord/kernel';

import type { DB } from '../../db/schema.js';

export async function emailThreadLinkFromProvenance(
  db: Kysely<DB>,
  userId: string,
  provenance: string | null | undefined,
): Promise<ProviderLink | null> {
  if (!provenance?.startsWith('gmail:')) return null;
  const storedGid = provenance.slice('gmail:'.length);
  const thread = await db
    .selectFrom('email_threads')
    .select(['gmail_thread_id', 'account_id'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', storedGid)
    .executeTakeFirst();
  if (!thread) return null;

  if (!thread.account_id) {
    const u = await db
      .selectFrom('users')
      .select('email')
      .where('id', '=', userId)
      .executeTakeFirst();
    return providerThreadLink({
      provider: 'gmail',
      emailAddress: u?.email ?? null,
      nativeThreadId: thread.gmail_thread_id,
    });
  }

  const acct = await db
    .selectFrom('email_accounts')
    .select(['provider', 'email_address', 'preset_key'])
    .where('id', '=', thread.account_id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!acct) return null;
  const native = thread.gmail_thread_id.includes(':')
    ? thread.gmail_thread_id.slice(thread.gmail_thread_id.indexOf(':') + 1)
    : thread.gmail_thread_id;
  return providerThreadLink({
    provider: acct.provider,
    emailAddress: acct.email_address,
    nativeThreadId: native,
    presetKey: acct.preset_key,
  });
}
