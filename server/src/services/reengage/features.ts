/**
 * ADR 0351 — the features a re-engage nudge can name, in the order they are
 * offered. "Used" is read from data Chord already keeps (a list the user made,
 * a mailbox they connected, a tldr they asked for), so nothing new is written
 * on the hot paths to track usage, and a feature used before this shipped
 * already counts.
 *
 * A new feature is one entry here. Keep the push short: the title is a nudge,
 * the body one concrete thing to say or tap.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { scopesCoverGmail } from '../google/gmail.service.js';

export interface UsageContext {
  db: Kysely<DB>;
  userId: string;
  /** The user's personal 1:1 chat, if they have one. */
  personalGroupId: string | null;
}

export interface ReengageFeature {
  /** Stored in the sent log. Never rename a shipped id. */
  id: string;
  title: string;
  body: string;
  /** In-app route the tap opens. */
  url(ctx: UsageContext): string;
  /** Other features that must be used first (no tldr tip before a mailbox). */
  needs?: string[];
  used(ctx: UsageContext): Promise<boolean>;
}

async function exists(q: { executeTakeFirst(): Promise<unknown> }): Promise<boolean> {
  return (await q.executeTakeFirst()) !== undefined;
}

const personalChat = (ctx: UsageContext) =>
  ctx.personalGroupId ? `/groups/${ctx.personalGroupId}` : '/groups';

async function usedTokenSource(
  ctx: UsageContext,
  source: DB['token_usage']['source'],
): Promise<boolean> {
  return exists(
    ctx.db
      .selectFrom('token_usage')
      .select('id')
      .where('user_id', '=', ctx.userId)
      .where('source', '=', source)
      .limit(1),
  );
}

export const REENGAGE_FEATURES: ReengageFeature[] = [
  {
    id: 'connect_email',
    title: 'Bring your email into Chord',
    body: 'Connect your mailbox and Chord pulls out the dates, to-dos and replies that need you.',
    url: () => '/settings?open=mailboxes',
    async used({ db, userId }) {
      const u = await db
        .selectFrom('users')
        .select('refresh_token_scopes')
        .where('id', '=', userId)
        .executeTakeFirst();
      if (scopesCoverGmail(u?.refresh_token_scopes)) return true;
      return exists(db.selectFrom('email_accounts').select('id').where('user_id', '=', userId).limit(1));
    },
  },
  {
    id: 'ask_chord',
    title: 'Just ask Chord',
    body: 'Try "what\'s on this week?" in your Chord chat.',
    url: personalChat,
    async used({ db, userId, personalGroupId }) {
      if (!personalGroupId) return false;
      return exists(
        db
          .selectFrom('messages')
          .select('id')
          .where('group_id', '=', personalGroupId)
          .where('sender_id', '=', userId)
          .where('kind', '=', 'text')
          .limit(1),
      );
    },
  },
  {
    id: 'shared_list',
    title: 'Keep a list with Chord',
    body: 'Say "add milk and eggs to the Costco list" and it is there for the whole family.',
    url: () => '/catchup/lists',
    used: ({ db, userId }) =>
      exists(db.selectFrom('lists').select('id').where('created_by', '=', userId).limit(1)),
  },
  {
    id: 'email_tldr',
    title: 'Long email? Tap tldr',
    body: 'Open any email and tap tldr for the few lines that matter.',
    url: () => '/email',
    needs: ['connect_email'],
    used: (ctx) => usedTokenSource(ctx, 'email_summary'),
  },
  {
    id: 'plan_my_day',
    title: 'Plan your day in one line',
    body: 'Type /plan in your Chord chat and it lays out your day around your calendar.',
    url: personalChat,
    used: ({ db, userId }) =>
      exists(
        db
          .selectFrom('skill_runs')
          .select('user_id')
          .where('user_id', '=', userId)
          .where('skill_id', '=', 'plan_my_day')
          .limit(1),
      ),
  },
  {
    id: 'reply_drafts',
    title: 'Let Chord draft the reply',
    body: 'Open an email, tap Reply, then Suggested - Chord writes it with your free times.',
    url: () => '/email',
    needs: ['connect_email'],
    used: (ctx) => usedTokenSource(ctx, 'email_reply'),
  },
  {
    id: 'unsubscribe',
    title: 'Clear out the newsletters',
    body: 'See every mailing list you are on and leave the ones you never open in one tap.',
    url: () => '/email/lists',
    needs: ['connect_email'],
    used: ({ db, userId }) =>
      exists(db.selectFrom('email_unsubscribes').select('user_id').where('user_id', '=', userId).limit(1)),
  },
  {
    id: 'trips',
    title: 'Your trips, in one place',
    body: 'Forward a flight or hotel booking and Chord builds the trip.',
    url: () => '/catchup/trips',
    used: ({ db, userId }) =>
      exists(db.selectFrom('trips').select('id').where('created_by', '=', userId).limit(1)),
  },
  {
    id: 'family_chat',
    title: 'Bring the family in',
    body: 'Start a chat with your partner and share lists, plans and events.',
    url: () => '/groups',
    used: ({ db, userId }) =>
      exists(
        db
          .selectFrom('group_members as m')
          .innerJoin('groups as g', 'g.id', 'm.group_id')
          .select('g.id')
          .where('m.user_id', '=', userId)
          .where('g.kind', '=', 'group')
          .where(
            sql<boolean>`(select count(*) from group_members gm where gm.group_id = g.id) > 1`,
          )
          .limit(1),
      ),
  },
];

/**
 * The first feature not used yet whose prerequisites are used and that was
 * never sent before. Pure so the order rules are tested without a database.
 */
export function pickFeature(
  features: ReengageFeature[],
  used: ReadonlySet<string>,
  alreadySent: ReadonlySet<string>,
): ReengageFeature | null {
  for (const f of features) {
    if (used.has(f.id) || alreadySent.has(f.id)) continue;
    if (f.needs && !f.needs.every((n) => used.has(n))) continue;
    return f;
  }
  return null;
}
