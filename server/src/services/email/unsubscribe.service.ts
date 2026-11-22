/**
 * Unsubscribing from a mailing list (ADR 0122).
 *
 * Three mechanisms, three different things we are allowed to say afterwards:
 *
 *   one_click  RFC 8058 POST. We did it. Say so.
 *   mailto     We sent the request. We cannot confirm the sender honoured it.
 *   link       A page for a human. We opened it and nothing more.
 *
 * Collapsing these into one "Unsubscribed" toast is the ADR 0102 failure in a
 * new place: reporting a write we did not perform.
 */
import { sql, type Kysely } from 'kysely';
import {
  isFreemail,
  parseUnsubscribe,
  registrableDomain,
  type EmailUnsubscribeManyResult,
  type EmailUnsubscribeResult,
  type UnsubscribeOption,
} from '@chord/kernel';

import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';
import { assertPublicHost, BlockedHostError } from '@/utils/ssrf.js';
import { sendAccountNew, threadAccountId } from '../email-accounts/accounts.service.js';
import { sendNewMessage } from '../google/gmail.service.js';
import { listAutoTrash } from './auto-trash.service.js';
import { countsAfterLeaving, leftSenderJoin, notAutoTrashed } from './left-lists.js';

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export interface ThreadUnsubscribe extends UnsubscribeOption {
  senderEmail: string;
  /** When this user already asked this sender to stop. */
  requestedAt?: string;
}

/**
 * What this thread offers, if anything.
 *
 * Reads the NEWEST message carrying the header: a list that changed its
 * unsubscribe endpoint means the old one may be dead, and the current message
 * is the one the reader is looking at.
 */
export async function resolveThreadUnsubscribe(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
): Promise<ThreadUnsubscribe | null> {
  const row = await db
    .selectFrom('email_messages')
    .select(['from_email', 'list_unsubscribe', 'list_unsubscribe_post'])
    .where('thread_id', '=', threadRowId)
    .where('user_id', '=', userId)
    .where('list_unsubscribe', 'is not', null)
    .orderBy('internal_date', 'desc')
    .executeTakeFirst();
  if (!row) return null;

  const option = parseUnsubscribe(row.list_unsubscribe, row.list_unsubscribe_post);
  if (!option) return null;

  const senderEmail = (row.from_email ?? '').toLowerCase();
  const prior = senderEmail
    ? await db
        .selectFrom('email_unsubscribes')
        .select('requested_at')
        .where('user_id', '=', userId)
        .where('sender_email', '=', senderEmail)
        .executeTakeFirst()
    : undefined;

  return {
    ...option,
    senderEmail,
    ...(prior?.requested_at ? { requestedAt: prior.requested_at } : {}),
  };
}

/** One mailing list the user is on: a sender whose mail carries the header. */
export interface MailingListSender {
  senderEmail: string;
  senderName: string | null;
  /** Messages from this sender inside the window. */
  messages: number;
  /** How many of those the user opened. */
  opened: number;
  lastReceivedAt: string;
  /** What this sender's newest message lets us do. Null = header unusable. */
  kind: UnsubscribeOption['kind'] | null;
  /** When this user already asked this sender to stop. */
  requestedAt?: string;
  /** The newest thread carrying the header: what an unsubscribe acts on. */
  threadId: string;
  /** Its future mail goes to Trash (auto-trash.service.ts). */
  autoTrash?: boolean;
  /**
   * Only with `left: 'drop'`: the user asked it to stop and it has mailed
   * since (past the grace). `messages` then counts only that mail.
   */
  stillMailing?: boolean;
}

export interface ListSubscriptionsOptions {
  sinceDays?: number;
  limit?: number;
  /**
   * 'keep' (default): every list, already-left ones marked `requestedAt` -
   * what the Mailing lists screen and the sender matcher need.
   * 'drop': what to suggest NEXT. A left list counts only mail sent after the
   * request (left-lists.ts), so one that stopped drops out before the limit
   * and the next list moves up; lists going to Trash are left out.
   */
  left?: 'keep' | 'drop';
}

const NOT_TRASHED = sql<boolean>`not (m.gmail_label_ids @> '["TRASH"]'::jsonb) and not (m.gmail_label_ids @> '["SPAM"]'::jsonb)`;

/**
 * The lists this user is on, busiest first.
 *
 * Derived from the header, not from a category or a guess: a sender is a
 * mailing list here exactly when its mail says how to leave it. Outlook mail
 * carries the header only once a thread was opened (ADR 0122), so lists that
 * reach only an Outlook mailbox are under-counted.
 */
export async function listSubscriptions(
  db: Kysely<DB>,
  userId: string,
  opts: ListSubscriptionsOptions = {},
): Promise<MailingListSender[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 90) * 86_400_000).toISOString();
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 500);
  const drop = opts.left === 'drop';
  const trashRules = await listAutoTrash(db, userId);

  const counts = await db
    .selectFrom('email_messages as m')
    .leftJoin('email_unsubscribes as u', (j) => j.on(leftSenderJoin))
    .select([
      sql<string>`lower(m.from_email)`.as('sender'),
      sql<string>`count(*)`.as('n'),
      sql<string>`count(*) filter (where m.is_unread = 0)`.as('opened'),
      sql<string>`max(m.internal_date)`.as('last_at'),
    ])
    .where('m.user_id', '=', userId)
    .where('m.list_unsubscribe', 'is not', null)
    .where('m.from_email', 'is not', null)
    .where('m.internal_date', '>=', since)
    .where(NOT_TRASHED)
    // Filtered before the limit, not after: dropping rows from the top 30
    // would only shorten the answer; the next lists would never move up.
    .$if(drop, (qb) =>
      qb.where(countsAfterLeaving).where(notAutoTrashed(trashRules.map((r) => r.sender))),
    )
    .groupBy(sql`lower(m.from_email)`)
    .orderBy(sql`count(*)`, 'desc')
    .orderBy(sql`max(m.internal_date)`, 'desc')
    .limit(limit)
    .execute();
  if (counts.length === 0) return [];

  const senders = counts.map((c) => c.sender);
  // The newest message per sender supplies the name, the thread and the header
  // that is current (a list that moved its endpoint leaves old ones dead).
  const newest = await db
    .selectFrom('email_messages as m')
    .distinctOn(sql`lower(m.from_email)`)
    .select([
      sql<string>`lower(m.from_email)`.as('sender'),
      'm.from_name',
      'm.thread_id',
      'm.list_unsubscribe',
      'm.list_unsubscribe_post',
    ])
    .where('m.user_id', '=', userId)
    .where('m.list_unsubscribe', 'is not', null)
    .where(sql<boolean>`lower(m.from_email) in (${sql.join(senders)})`)
    .where(NOT_TRASHED)
    .orderBy(sql`lower(m.from_email)`)
    .orderBy('m.internal_date', 'desc')
    .execute();
  const newestBySender = new Map(newest.map((r) => [r.sender, r]));

  const prior = await db
    .selectFrom('email_unsubscribes')
    .select(['sender_email', 'requested_at'])
    .where('user_id', '=', userId)
    .where('sender_email', 'in', senders)
    .execute();
  const priorBySender = new Map(prior.map((r) => [r.sender_email, r.requested_at]));
  const trashing = new Set(trashRules.map((r) => r.sender));

  const out: MailingListSender[] = [];
  for (const c of counts) {
    const n = newestBySender.get(c.sender);
    if (!n) continue;
    const requestedAt = priorBySender.get(c.sender);
    out.push({
      senderEmail: c.sender,
      senderName: n.from_name?.trim() || null,
      messages: Number(c.n),
      opened: Number(c.opened),
      lastReceivedAt: c.last_at,
      kind: parseUnsubscribe(n.list_unsubscribe, n.list_unsubscribe_post)?.kind ?? null,
      ...(requestedAt ? { requestedAt } : {}),
      threadId: n.thread_id,
      ...(trashing.has(c.sender) ? { autoTrash: true } : {}),
      ...(drop && requestedAt ? { stillMailing: true } : {}),
    });
  }
  return out;
}

/**
 * `senders` is every address of the one list the user means, busiest first:
 * a brand that mails from several addresses (`no-reply@em.macys.com`,
 * `shop@em.macys.com`) is one list to the person leaving it. `sender` is the
 * busiest of them.
 */
export type SubscriptionSenderMatch =
  | { ok: true; sender: MailingListSender; senders: MailingListSender[] }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: MailingListSender[] };

/** Words that name the request, not the sender ("the Macy's mailing list"),
 *  and address pieces every sender shares (`no-reply`, `.com`). */
const NOT_A_SENDER_WORD = new Set([
  'the', 'a', 'an', 'my', 'me', 'from', 'of', 'off', 'and', 'to', 'all', 'their',
  'mailing', 'list', 'lists', 'email', 'emails', 'mail', 'newsletter', 'newsletters',
  'unsubscribe', 'stop', 'subscription', 'subscriptions', 'marketing', 'promo', 'promos',
  'com', 'net', 'org', 'co', 'io', 'www', 'e', 'em', 'info', 'no', 'reply', 'noreply', 'news',
]);

/** "Macy's" and "macys" are the same word; so are "1-800" and "1800". */
function senderWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOT_A_SENDER_WORD.has(w));
}

/** The name a domain is registered under: `macys` for `e.macys.com`. */
function brandOfDomain(domain: string): string | null {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return null;
  // `example.co.uk`: the registered name sits one label further in.
  const sld = labels[labels.length - 2]!;
  if (labels.length >= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(sld)) return labels[labels.length - 3]!;
  return sld;
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1);

/** Domains many unrelated senders mail from: two lists here are two lists. */
const SHARED_SENDING_BRANDS = new Set([
  'substack', 'beehiiv', 'mailchimp', 'mailchi', 'list-manage', 'convertkit', 'ck', 'ghost', 'buttondown',
  'medium', 'patreon', 'eventbrite', 'sendgrid', 'ccsend', 'constantcontact', 'mailerlite', 'sendinblue', 'brevo',
]);

/** The brand every one of these senders mails as, when they share one. */
function sharedBrand(senders: MailingListSender[]): string | null {
  const brands = new Set(senders.map((s) => brandOfDomain(domainOf(s.senderEmail))));
  if (brands.size !== 1) return null;
  const [brand] = brands;
  if (!brand || SHARED_SENDING_BRANDS.has(brand)) return null;
  if (isFreemail(registrableDomain(domainOf(senders[0]!.senderEmail)))) return null;
  return brand;
}

/**
 * Which list the user means by "the Target emails".
 *
 * An exact address wins outright. An address or domain the user typed that is
 * not quite the sender's (lists send from a subdomain the user never sees:
 * `macys@e.macys.com` for mail from `no-reply@em.macys.com`) matches by the
 * name the domain is registered under. Otherwise the words, minus the ones
 * that name the request ("mailing list"), are matched against the address and
 * the display name; a typed address whose domain matched nothing counts by its
 * local part only, so an invented domain (`macys@example.com`) cannot veto
 * the name in front of it. Hits that are all one brand are one list; anything
 * else but exactly one hit is handed back as candidates so the caller asks
 * instead of picking.
 */
export async function resolveSubscriptionSender(
  db: Kysely<DB>,
  userId: string,
  query: string,
): Promise<SubscriptionSenderMatch> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { ok: false, reason: 'not_found', candidates: [] };
  const all = await listSubscriptions(db, userId, { sinceDays: 365, limit: 500 });
  const decide = (hits: MailingListSender[]): SubscriptionSenderMatch => {
    if (hits.length === 1 || (hits.length > 1 && sharedBrand(hits))) return { ok: true, sender: hits[0]!, senders: hits };
    return { ok: false, reason: hits.length === 0 ? 'not_found' : 'ambiguous', candidates: hits.slice(0, 5) };
  };

  const address = needle.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/);
  if (address) {
    const exact = all.find((s) => s.senderEmail === address[0]);
    if (exact) return { ok: true, sender: exact, senders: [exact] };
  }
  const domain = address?.[1] ?? needle.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}|[a-z0-9-]+\.[a-z]{2,})\b/)?.[1];
  const brand = domain ? brandOfDomain(domain) : null;
  if (brand) {
    const byBrand = all.filter((s) => brandOfDomain(domainOf(s.senderEmail)) === brand);
    if (byBrand.length > 0) return decide(byBrand);
  }

  const words = senderWords(needle.replace(/([a-z0-9._%+-]+)@[a-z0-9.-]+\.[a-z]{2,}/g, '$1'));
  if (words.length === 0) return { ok: false, reason: 'not_found', candidates: [] };
  return decide(
    all.filter((s) => {
      const parts = senderWords(`${s.senderEmail} ${s.senderName ?? ''}`);
      const hay = parts.join(' ');
      // `houzzpartners@…` names "Houzz Partners": an address runs the words together.
      const compact = parts.join('');
      return words.every((w) => hay.includes(w) || compact.includes(w));
    }),
  );
}

/**
 * RFC 8058 one-click. The URL comes out of an email, so it is screened by the
 * same guard as any other user-directed outbound fetch, and each redirect hop
 * is screened again.
 */
async function postOneClick(target: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicHost(url.hostname);
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) return false;
        const next = new URL(location, url);
        if (next.protocol !== 'https:') return false;
        url = next;
        continue;
      }
      return res.ok;
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Send the RFC 2369 mailto, from the mailbox the list is actually writing to. */
async function sendMailtoRequest(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  option: UnsubscribeOption,
): Promise<void> {
  // The list keys on the subscribed address, so this must leave from the
  // account that received the mail rather than the primary mailbox.
  const accountId = await threadAccountId(db, userId, threadRowId);
  const message = {
    to: [option.target],
    subject: option.subject ?? 'unsubscribe',
    body: 'unsubscribe',
  };
  if (accountId) await sendAccountNew(db, userId, accountId, message);
  else await sendNewMessage(db, userId, message);
}

async function record(
  db: Kysely<DB>,
  userId: string,
  senderEmail: string,
  kind: string,
): Promise<void> {
  if (!senderEmail) return;
  const now = new Date().toISOString();
  await db
    .insertInto('email_unsubscribes')
    .values({ user_id: userId, sender_email: senderEmail, kind, requested_at: now })
    .onConflict((oc) =>
      oc.columns(['user_id', 'sender_email']).doUpdateSet({ kind, requested_at: now }),
    )
    .execute();
}

/**
 * Do whatever this sender's headers actually allow, and describe it in the
 * words that are true of it.
 */
export async function unsubscribeThread(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
): Promise<EmailUnsubscribeResult> {
  const option = await resolveThreadUnsubscribe(db, userId, threadRowId);
  if (!option) {
    return {
      kind: 'link',
      unsubscribed: false,
      message: 'This sender did not offer a way to unsubscribe.',
    };
  }

  if (option.kind === 'link') {
    // Nothing to perform: the reader finishes this on the sender's page.
    return {
      kind: 'link',
      unsubscribed: false,
      url: option.target,
      message: 'Opening the sender’s unsubscribe page.',
    };
  }

  if (option.kind === 'one_click') {
    let ok = false;
    try {
      ok = await postOneClick(option.target);
    } catch (err) {
      if (!(err instanceof BlockedHostError)) {
        logger.warn('one-click unsubscribe failed', { userId, err: (err as Error).message });
      }
      ok = false;
    }
    if (!ok) {
      // The link is still there to fall back to, and saying nothing happened
      // is the point.
      return {
        kind: 'one_click',
        unsubscribed: false,
        // The same address the email's own unsubscribe link points at: opened
        // in a browser it usually shows the sender's page, where a person can
        // finish what the unattended request could not.
        url: option.target,
        message: 'The sender’s unsubscribe endpoint did not accept the request.',
      };
    }
    await record(db, userId, option.senderEmail, 'one_click');
    return { kind: 'one_click', unsubscribed: true, message: 'Unsubscribed.' };
  }

  try {
    await sendMailtoRequest(db, userId, threadRowId, option);
  } catch (err) {
    logger.warn('mailto unsubscribe failed', { userId, err: (err as Error).message });
    return {
      kind: 'mailto',
      unsubscribed: false,
      message: 'Could not send the unsubscribe request.',
    };
  }
  await record(db, userId, option.senderEmail, 'mailto');
  return {
    kind: 'mailto',
    unsubscribed: false,
    requested: true,
    // Deliberately not "Unsubscribed": a mailto is a request, and whether the
    // list honours it is not something we observe.
    message: 'Unsubscribe request sent.',
  };
}

/**
 * Leave several lists in one go: the Mailing lists screen's "Unsubscribe from
 * all" and the bot's several-lists card both come here.
 *
 * One at a time and never all-or-nothing: each list is a request to a
 * different outside sender that cannot be taken back, so a failure on one must
 * not hide that the others went out. Each line reports what happened to that
 * list (ADR 0122's three outcomes). A list already asked to stop is skipped, as
 * is an address that is not a list the user is on.
 */
export async function unsubscribeFromSenders(
  db: Kysely<DB>,
  userId: string,
  senderEmails: string[],
): Promise<EmailUnsubscribeManyResult> {
  const lists = await listSubscriptions(db, userId, { sinceDays: 365, limit: 500 });
  const bySender = new Map(lists.map((l) => [l.senderEmail, l]));
  const results: EmailUnsubscribeManyResult['results'] = [];
  for (const raw of [...new Set(senderEmails.map((e) => e.trim().toLowerCase()))]) {
    const list = bySender.get(raw);
    if (!list) {
      results.push({
        senderEmail: raw,
        senderName: null,
        kind: 'link',
        unsubscribed: false,
        skipped: 'not_a_list',
        message: 'Not a mailing list Chord can see in your mail.',
      });
      continue;
    }
    if (list.requestedAt) {
      results.push({
        senderEmail: raw,
        senderName: list.senderName,
        kind: list.kind ?? 'link',
        unsubscribed: false,
        skipped: 'already_requested',
        message: `Already asked to stop on ${list.requestedAt.slice(0, 10)}.`,
      });
      continue;
    }
    let out: EmailUnsubscribeResult;
    try {
      out = await unsubscribeThread(db, userId, list.threadId);
    } catch (err) {
      logger.warn('unsubscribe failed', { userId, sender: raw, err: (err as Error).message });
      out = { kind: list.kind ?? 'mailto', unsubscribed: false, message: 'Could not send the request.' };
    }
    results.push({ ...out, senderEmail: raw, senderName: list.senderName });
  }
  // Whatever Chord could not finish is the user's to finish: on the sender's
  // page when there is one, or by sending that sender's future mail to Trash.
  const trashing = new Set((await listAutoTrash(db, userId)).map((r) => r.sender));
  return {
    results: results.map((r) => ({
      ...r,
      ...(!r.unsubscribed && !r.requested ? { needsYou: true } : {}),
      ...(trashing.has(r.senderEmail) ? { autoTrash: true } : {}),
    })),
  };
}
