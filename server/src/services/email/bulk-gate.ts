/**
 * The bulk-mail gate (ADR 0127).
 *
 * A deny-list: the AI passes mine everything EXCEPT mail that looks like a
 * blast. The alternative — mine only non-bulk — is much cheaper and silently
 * drops the flight confirmation and the invoice, which are the highest-value
 * mail we extract from and which carry no `List-Unsubscribe` at all.
 *
 * One helper, three callers. Scattering this rule across the passes would be
 * three places to forget it, which is the argument ADR 0105 makes about write
 * sites.
 *
 * The rule exists twice, in SQL and in TypeScript, because the passes need to
 * filter in the query and the ADR needs the reasoning testable. `isMinable`
 * and `minablePredicate` are pinned against one table of cases so they cannot
 * drift, the same way ADR 0085 pins the two search paths.
 */
import { sql, type Expression, type RawBuilder } from 'kysely';

import { env } from '@/config/env.js';

/** Categories whose mail is bulk-sent by nature and wanted anyway. */
const ALWAYS_MINE_CATEGORY = 'events & invites';

export interface BulkGateInputs {
  /** ADR 0109's header signal: List-Unsubscribe / List-Id / CATEGORY_PROMOTIONS. */
  bulk: boolean;
  /** ADR 0110's classifier opinion, stored separately so neither clobbers the other. */
  bulkInferred: boolean;
  /** ADR 0086's axis. `to_do` / `reply_needed` outrank the gate. */
  action: string | null;
  /** The sender is in this user's own people rows (ADR 0076's `people.email`). */
  senderKnown: boolean;
  /** Top-level category title, when the caller has it joined. */
  categoryTitle?: string | null;
  /** The user has had at least IGNORED_SENDER_MIN messages from this sender,
   *  opened none of them, and never written to it. */
  senderIgnored?: boolean;
}

/** How many unopened messages make a sender one the user ignores. One or two
 *  is a sender the user simply has not got to yet (a new school, an airline
 *  they flew once). */
export const IGNORED_SENDER_MIN = 3;

/**
 * May this thread be mined?
 *
 * Skipping requires BOTH bulk signals to agree. That is load-bearing rather
 * than cautious: ADR 0109 says the header "is a signal, never a verdict" and
 * that "nothing demotes on it alone", so a gate keyed on the header by itself
 * would contradict the ADR that produced the header. Two independent signals
 * agreeing is not "alone".
 */
export function isMinable(i: BulkGateInputs): boolean {
  if (!env.EMAIL_BULK_GATE) return true;

  // Mail that wants something from you is never a blast, whatever the headers
  // say (ADR 0086's axis overrides the gate everywhere — ADR 0109's own rule).
  if (i.action === 'to_do' || i.action === 'reply_needed') return true;

  // A person you know is never suppressed. One stale row re-opens the
  // firehose for that one sender, which is a bounded cost.
  if (i.senderKnown) return true;

  // Evite, Eventbrite and Meetup are bulk by construction and are exactly the
  // mail ADR 0088 wanted kept.
  if ((i.categoryTitle ?? '').trim().toLowerCase() === ALWAYS_MINE_CATEGORY) return true;

  // Mass mail from a sender the user never opens or writes to: the user's own
  // behaviour is the second signal, so ONE bulk signal is enough here. Prod:
  // USPS Informed Delivery and retail lists passed the two-signal rule because
  // the classifier was unsure, and filled a new user's Action Items.
  if (i.senderIgnored && (i.bulk || i.bulkInferred)) return false;

  return !(i.bulk && i.bulkInferred);
}

/**
 * The same rule as a WHERE clause.
 *
 * `prefix` is the caller's table alias, following `email/folders.ts` — the
 * passes each build their query differently, and the alternative is three
 * hand-written copies of this predicate.
 */
export function minablePredicate(
  userId: string,
  opts: { prefix?: string; categoryTitleRef?: string } = {},
): Expression<boolean> {
  if (!env.EMAIL_BULK_GATE) return sql<boolean>`true`;
  const p = opts.prefix ?? '';
  const col = (name: string) => sql.ref(`${p}${name}`);
  const category = opts.categoryTitleRef
    ? sql<boolean>`lower(coalesce(${sql.ref(opts.categoryTitleRef)}, '')) = ${ALWAYS_MINE_CATEGORY}`
    : sql<boolean>`false`;

  return sql<boolean>`(
    ${col('action')} in ('to_do', 'reply_needed')
    or exists (
      select 1 from people p
      where p.owner_user_id = ${userId}
        and p.email is not null
        and lower(p.email) = lower(coalesce(${col('from_email')}, ''))
    )
    or ${category}
    or (
      not (${col('bulk')} = 1 and ${col('bulk_inferred')} = 1)
      and not ((${col('bulk')} = 1 or ${col('bulk_inferred')} = 1) and ${senderIgnoredSql(userId, col('from_email'))})
    )
  )`;
}

/** `senderIgnored` in SQL. Uses the (user_id, lower(from_email)) index. */
export function senderIgnoredSql(userId: string, fromEmail: Expression<unknown>): RawBuilder<boolean> {
  return sql<boolean>`(
    (select count(*) from (
       select 1 from email_messages s
       where s.user_id = ${userId} and lower(s.from_email) = lower(coalesce(${fromEmail}, ''))
       limit ${IGNORED_SENDER_MIN}
     ) n) >= ${IGNORED_SENDER_MIN}
    and not exists (
      select 1 from email_messages s
      where s.user_id = ${userId} and lower(s.from_email) = lower(coalesce(${fromEmail}, ''))
        and s.is_unread = 0
    )
    and not exists (
      select 1 from email_messages s, jsonb_array_elements_text(s.to_emails) t(addr)
      where s.user_id = ${userId} and s.gmail_label_ids @> '["SENT"]'::jsonb
        and s.auto_reply = 0
        and lower(t.addr) = lower(coalesce(${fromEmail}, ''))
    )
  )`;
}
