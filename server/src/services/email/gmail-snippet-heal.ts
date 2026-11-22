/**
 * Decode the Gmail previews stored before sync decoded them.
 *
 * Gmail's API returns `snippet` HTML-escaped and the mirror kept it that way,
 * so the thread list read `haven&#39;t` and the search index held `39`. New
 * mail is decoded at sync; this rewrites what is already stored. It runs in
 * application code rather than as a migration because the column is sealed
 * (ADR 0201) - SQL cannot read it.
 *
 * Gmail mailboxes only: Outlook and IMAP previews were never escaped, and
 * decoding them would rewrite text that really does say `&amp;`. Meant to be
 * run once - a second run is harmless for ordinary text, but would decode a
 * preview that legitimately quotes an entity.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { cleanGmailSnippet } from '../../utils/email-text.js';
import { recomputeThread } from '../google/gmail.service.js';
import { sealMessageContent } from './content-seal.js';

export interface SnippetHealResult {
  scanned: number;
  changed: number;
  threads: number;
}

export async function decodeStoredGmailSnippets(
  db: Kysely<DB>,
  userId: string,
  opts: { apply: boolean },
): Promise<SnippetHealResult> {
  const gmailAccounts = (
    await db
      .selectFrom('email_accounts')
      .select('id')
      .where('user_id', '=', userId)
      .where('provider', '=', 'gmail')
      .execute()
  ).map((a) => a.id);

  const rows = await db
    .selectFrom('email_messages')
    .select(['id', 'gmail_thread_id', 'snippet'])
    .where('user_id', '=', userId)
    .where((eb) =>
      gmailAccounts.length > 0
        ? eb.or([eb('account_id', 'is', null), eb('account_id', 'in', gmailAccounts)])
        : eb('account_id', 'is', null),
    )
    .execute();

  const threads = new Set<string>();
  let changed = 0;
  for (const row of rows) {
    const next = cleanGmailSnippet(row.snippet);
    if (next === row.snippet) continue;
    changed++;
    threads.add(row.gmail_thread_id);
    if (!opts.apply) continue;
    await db
      .updateTable('email_messages')
      .set(await sealMessageContent(userId, { snippet: next }, { index: 'none' }))
      .where('id', '=', row.id)
      .execute();
  }
  if (opts.apply) {
    // The thread row carries its newest message's preview and its own index.
    for (const threadId of threads) await recomputeThread(db, userId, threadId);
  }
  return { scanned: rows.length, changed, threads: threads.size };
}
