/**
 * Who the user's mail is with (ADR 0246).
 *
 * Counting is done here, in SQL over the unsealed address columns, so a
 * ranking over thousands of messages is one query and an exact number rather
 * than something a model adds up across pages of search results.
 *
 * Every question is about the user's OWN mail (ADR 0065/0114): a row here is
 * an address they have already seen in their own mailbox.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { listAutoTrash } from './auto-trash.service.js';
import { countsAfterLeaving, leftSenderJoin, notAutoTrashed } from './left-lists.js';

export type SenderRank = 'received' | 'written_to' | 'awaiting_reply' | 'gone_quiet';

export interface SenderStat {
  email: string;
  name: string | null;
  /** What `rank` counted: messages received, messages sent, or threads waiting. */
  count: number;
  /** Newest message for received/written_to/gone_quiet; OLDEST waiting thread for awaiting_reply. */
  lastAt: string;
  /** Already one of the user's People (ADR 0076), matched on address. */
  inPeople: boolean;
  /**
   * The user asked this sender to stop on this date and it kept mailing:
   * `count` is only what came after (left-lists.ts). Absent otherwise.
   */
  unsubscribedAt?: string;
}

export interface SenderStatsOptions {
  rank: SenderRank;
  /** Window for received / written_to (default 90). */
  sinceDays?: number;
  /** gone_quiet: silent for at least this long (default 60). awaiting_reply: waiting at least this long (default 0). */
  quietDays?: number;
  /** Count newsletters and other mass mail too (default false). */
  includeBulk?: boolean;
  limit?: number;
}

/** A sender needs this much history before going silent means anything. */
const QUIET_MIN_MESSAGES = 5;
const DAY = 86_400_000;

const label = (l: string) => sql<boolean>`m.gmail_label_ids @> ${JSON.stringify([l])}::jsonb`;
const LIVE = sql<boolean>`not ${label('TRASH')} and not ${label('SPAM')}`;
/** Mass mail by either signal (ADR 0109/0110), or by the header itself. */
const BULK = sql<boolean>`(coalesce(t.bulk, 0) = 1 or coalesce(t.bulk_inferred, 0) = 1 or m.list_unsubscribe is not null)`;

export async function ownAddresses(db: Kysely<DB>, userId: string): Promise<string[]> {
  const [user, accounts] = await Promise.all([
    db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirst(),
    db.selectFrom('email_accounts').select('email_address').where('user_id', '=', userId).execute(),
  ]);
  return [user?.email, ...accounts.map((a) => a.email_address)]
    .filter((e): e is string => !!e)
    .map((e) => e.toLowerCase());
}

/** Names and People membership for a set of addresses. */
async function decorate(
  db: Kysely<DB>,
  userId: string,
  rows: Array<{ email: string; count: number; lastAt: string; unsubscribedAt?: string | null }>,
): Promise<SenderStat[]> {
  if (rows.length === 0) return [];
  const emails = rows.map((r) => r.email);
  const [names, people] = await Promise.all([
    db
      .selectFrom('email_messages as m')
      .distinctOn(sql`lower(m.from_email)`)
      .select([sql<string>`lower(m.from_email)`.as('email'), 'm.from_name'])
      .where('m.user_id', '=', userId)
      .where(sql<boolean>`lower(m.from_email) in (${sql.join(emails)})`)
      .where('m.from_name', 'is not', null)
      .orderBy(sql`lower(m.from_email)`)
      .orderBy('m.internal_date', 'desc')
      .execute(),
    db
      .selectFrom('people')
      .select(['display_name', sql<string>`lower(email)`.as('email')])
      .where('owner_user_id', '=', userId)
      .where(sql<boolean>`lower(email) in (${sql.join(emails)})`)
      .execute(),
  ]);
  const nameBy = new Map(names.map((n) => [n.email, n.from_name?.trim() || null]));
  const personBy = new Map(people.map((p) => [p.email, p.display_name]));
  return rows.map((r) => ({
    email: r.email,
    // A name the user gave beats whatever the sender put on a From header.
    name: personBy.get(r.email) ?? nameBy.get(r.email) ?? null,
    count: r.count,
    lastAt: r.lastAt,
    inPeople: personBy.has(r.email),
    ...(r.unsubscribedAt ? { unsubscribedAt: r.unsubscribedAt } : {}),
  }));
}

export async function senderStats(
  db: Kysely<DB>,
  userId: string,
  opts: SenderStatsOptions,
): Promise<SenderStat[]> {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);
  const includeBulk = opts.includeBulk ?? false;
  const now = Date.now();
  const since = new Date(now - (opts.sinceDays ?? 90) * DAY).toISOString();
  const mine = await ownAddresses(db, userId);
  const notMine = (col: ReturnType<typeof sql>) =>
    mine.length ? sql<boolean>`${col} not in (${sql.join(mine)})` : sql<boolean>`true`;

  if (opts.rank === 'written_to') {
    const rows = await db
      .selectFrom('email_messages as m')
      .innerJoin(
        sql<{ value: string }>`lateral jsonb_array_elements_text(m.to_emails)`.as('r'),
        (join) => join.onTrue(),
      )
      .select([
        sql<string>`lower(r.value)`.as('email'),
        sql<string>`count(*)`.as('n'),
        sql<string>`max(m.internal_date)`.as('last_at'),
      ])
      .where('m.user_id', '=', userId)
      .where(label('SENT'))
      .where('m.auto_reply', '=', 0)
      .where(sql<boolean>`not ${label('TRASH')}`)
      .where('m.internal_date', '>=', since)
      .where(notMine(sql`lower(r.value)`))
      .groupBy(sql`lower(r.value)`)
      .orderBy(sql`count(*)`, 'desc')
      .orderBy(sql`max(m.internal_date)`, 'desc')
      .limit(limit)
      .execute();
    return decorate(db, userId, rows.map((r) => ({ email: r.email, count: Number(r.n), lastAt: r.last_at })));
  }

  if (opts.rank === 'awaiting_reply') {
    const waitedSince = new Date(now - (opts.quietDays ?? 0) * DAY).toISOString();
    const rows = await db
      .selectFrom('email_threads as t')
      .select([
        sql<string>`lower(t.from_email)`.as('email'),
        sql<string>`count(*)`.as('n'),
        sql<string>`min(t.last_message_at)`.as('oldest_at'),
      ])
      .where('t.user_id', '=', userId)
      .where('t.action', '=', 'reply_needed')
      .where('t.is_archived', '=', 0)
      .where('t.from_email', 'is not', null)
      .where(sql<boolean>`not (t.gmail_label_ids @> '["TRASH"]'::jsonb)`)
      .where('t.last_message_at', '<=', waitedSince)
      .where(notMine(sql`lower(t.from_email)`))
      .groupBy(sql`lower(t.from_email)`)
      .orderBy(sql`min(t.last_message_at)`, 'asc')
      .limit(limit)
      .execute();
    return decorate(db, userId, rows.map((r) => ({ email: r.email, count: Number(r.n), lastAt: r.oldest_at })));
  }

  // A list the user left counts only by what it sent after the request, and
  // one going to Trash not at all: otherwise the list just left stays at the
  // top of "who emails me most" and comes back as the next thing to leave.
  const trashing = (await listAutoTrash(db, userId)).map((r) => r.sender);
  const received = db
    .selectFrom('email_messages as m')
    .innerJoin('email_threads as t', 't.id', 'm.thread_id')
    .leftJoin('email_unsubscribes as u', (j) => j.on(leftSenderJoin))
    .select([
      sql<string>`lower(m.from_email)`.as('email'),
      sql<string>`count(*)`.as('n'),
      sql<string>`max(m.internal_date)`.as('last_at'),
      sql<string | null>`max(u.requested_at)`.as('unsubscribed_at'),
    ])
    .where('m.user_id', '=', userId)
    .where('m.from_email', 'is not', null)
    .where(LIVE)
    .where(sql<boolean>`not ${label('SENT')}`)
    .where(includeBulk ? sql<boolean>`true` : sql<boolean>`not ${BULK}`)
    .where(notMine(sql`lower(m.from_email)`))
    .where(notAutoTrashed(trashing))
    .groupBy(sql`lower(m.from_email)`);

  if (opts.rank === 'gone_quiet') {
    // Not "who writes least": that is thousands of one-off senders. This is
    // someone with a real history whose mail has stopped.
    const quietBefore = new Date(now - (opts.quietDays ?? 60) * DAY).toISOString();
    // A list the user left went quiet because they asked: not news.
    const rows = await received
      .where(sql<boolean>`u.requested_at is null`)
      .having(sql<boolean>`count(*) >= ${QUIET_MIN_MESSAGES}`)
      .having(sql<boolean>`max(m.internal_date) < ${quietBefore}`)
      .orderBy(sql`count(*)`, 'desc')
      .limit(limit)
      .execute();
    return decorate(db, userId, rows.map((r) => ({ email: r.email, count: Number(r.n), lastAt: r.last_at })));
  }

  const rows = await received
    .where('m.internal_date', '>=', since)
    .where(countsAfterLeaving)
    .orderBy(sql`count(*)`, 'desc')
    .orderBy(sql`max(m.internal_date)`, 'desc')
    .limit(limit)
    .execute();
  return decorate(
    db,
    userId,
    rows.map((r) => ({ email: r.email, count: Number(r.n), lastAt: r.last_at, unsubscribedAt: r.unsubscribed_at })),
  );
}
