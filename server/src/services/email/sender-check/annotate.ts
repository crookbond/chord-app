/**
 * ADR 0294 — attach a `SenderCheck` to each message of an opened thread.
 *
 * Everything here is a read of what is already stored: the headers sync
 * captured (`reply_to`, `auth_results`), the body's link hosts, and whether
 * the user has corresponded with the address before. No provider call and no
 * model call, so it costs the open one query.
 */
import { sql, type Kysely } from 'kysely';

import {
  addressOf,
  checkSender,
  linkHostsFromHtml,
  registrableDomain,
  type EmailMessage,
  type SenderAuth,
  type SenderHistory,
} from '@chord/kernel';

import type { DB } from '../../../db/schema.js';
import { ownAddresses } from '../sender-stats.service.js';

export interface SenderRowFacts {
  id: string;
  auth_results?: SenderAuth | null;
}

/**
 * What the user has SENT changes only when they send (or a sync brings in
 * mail sent elsewhere), while every thread open asks about it - and each
 * answer scans every sent message. Remembered per user for a while, keyed on
 * the database too so two test databases never share answers.
 */
const SENT_FACTS_TTL_MS = 10 * 60_000;
const SENT_FACTS_MAX_USERS = 500;
const SENT_FACTS_MAX_ADDRESSES = 2000;

interface SentFacts {
  at: number;
  domains: string[] | null;
  wrote: Map<string, number>;
}

const sentFactsByDb = new WeakMap<object, Map<string, SentFacts>>();

function sentFacts(db: Kysely<DB>, userId: string): SentFacts {
  let byUser = sentFactsByDb.get(db);
  if (!byUser) {
    byUser = new Map();
    sentFactsByDb.set(db, byUser);
  }
  const now = Date.now();
  const hit = byUser.get(userId);
  if (hit && now - hit.at < SENT_FACTS_TTL_MS) return hit;
  if (hit) byUser.delete(userId);
  if (byUser.size >= SENT_FACTS_MAX_USERS) {
    const oldest = byUser.keys().next().value;
    if (oldest !== undefined) byUser.delete(oldest);
  }
  const fresh: SentFacts = { at: now, domains: null, wrote: new Map() };
  byUser.set(userId, fresh);
  return fresh;
}

/** Called whenever a SENT message is stored for the user. */
export function forgetSentFacts(db: Kysely<DB>, userId: string): void {
  sentFactsByDb.get(db)?.delete(userId);
}

async function wroteCounts(db: Kysely<DB>, userId: string, want: string[]): Promise<Map<string, number>> {
  const facts = sentFacts(db, userId);
  const missing = want.filter((a) => !facts.wrote.has(a));
  if (missing.length > 0) {
    const rows = await db
      .selectFrom('email_messages as m')
      .innerJoin(sql<{ value: string }>`lateral jsonb_array_elements_text(m.to_emails)`.as('t'), (j) => j.onTrue())
      .select([sql<string>`lower(t.value)`.as('email'), sql<number>`count(*)::int`.as('n')])
      .where('m.user_id', '=', userId)
      .where(sql<boolean>`m.gmail_label_ids @> '["SENT"]'::jsonb`)
      // An automatic reply (ADR 0314) is not the user choosing to write: a
      // phisher answered by the vacation responder must not become known.
      .where('m.auto_reply', '=', 0)
      .where(sql<boolean>`lower(t.value) in (${sql.join(missing)})`)
      .groupBy(sql`lower(t.value)`)
      .execute();
    if (facts.wrote.size + missing.length > SENT_FACTS_MAX_ADDRESSES) facts.wrote.clear();
    for (const a of missing) facts.wrote.set(a, 0);
    for (const r of rows) if (facts.wrote.has(r.email)) facts.wrote.set(r.email, Number(r.n));
  }
  return new Map(want.map((a) => [a, facts.wrote.get(a) ?? 0]));
}

/** Earlier mail from, mail to, and People membership — per address, outside this thread. */
export async function senderHistories(
  db: Kysely<DB>,
  userId: string,
  addresses: string[],
  excludeThreadId: string,
): Promise<Map<string, SenderHistory>> {
  const want = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(Boolean);
  const out = new Map<string, SenderHistory>();
  if (want.length === 0) return out;
  for (const a of want) out.set(a, { received: 0, wrote: 0, inPeople: false });
  const [received, wrote, people] = await Promise.all([
    db
      .selectFrom('email_messages')
      .select([sql<string>`lower(from_email)`.as('email'), sql<number>`count(*)::int`.as('n')])
      .where('user_id', '=', userId)
      .where('thread_id', '!=', excludeThreadId)
      .where(sql<boolean>`lower(from_email) in (${sql.join(want)})`)
      .groupBy(sql`lower(from_email)`)
      .execute(),
    wroteCounts(db, userId, want),
    db
      .selectFrom('people')
      .select(sql<string>`lower(email)`.as('email'))
      .where('owner_user_id', '=', userId)
      .where(sql<boolean>`lower(email) in (${sql.join(want)})`)
      .execute(),
  ]);
  for (const r of received) out.get(r.email)!.received = Number(r.n);
  for (const [email, n] of wrote) if (out.has(email)) out.get(email)!.wrote = n;
  for (const r of people) if (out.has(r.email)) out.get(r.email)!.inPeople = true;
  return out;
}

/**
 * Saved people whose full name a display name uses, with their addresses.
 * Two words at least: "Bill" alone names half the senders in a mailbox.
 */
export async function contactsNamed(
  db: Kysely<DB>,
  userId: string,
  names: (string | null)[],
): Promise<Map<string, { name: string; addresses: string[] }>> {
  const want = [
    ...new Set(
      names
        .map((n) => n?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '')
        .filter((n) => n.split(' ').length >= 2 && !n.includes('@')),
    ),
  ];
  const out = new Map<string, { name: string; addresses: string[] }>();
  if (want.length === 0) return out;
  const rows = await db
    .selectFrom('people')
    .select(['display_name', 'email'])
    .where('owner_user_id', '=', userId)
    .where('email', 'is not', null)
    .where(sql<boolean>`lower(regexp_replace(trim(display_name), '\\s+', ' ', 'g')) in (${sql.join(want)})`)
    .execute();
  for (const r of rows) {
    const key = r.display_name.trim().replace(/\s+/g, ' ').toLowerCase();
    const hit = out.get(key) ?? { name: r.display_name, addresses: [] };
    hit.addresses.push(r.email!);
    out.set(key, hit);
  }
  return out;
}

/** Most distinct domains read for one check; a mailbox writes to far fewer. */
const KNOWN_DOMAINS_MAX = 2000;

/**
 * Registrable domains the user has written to, or saved in People: what a
 * look-alike would imitate when it is not a listed brand ("the school").
 * Mail RECEIVED is deliberately not a source: a phishing domain that has
 * mailed you twice would otherwise become something to compare against.
 */
export async function knownDomains(db: Kysely<DB>, userId: string): Promise<string[]> {
  const facts = sentFacts(db, userId);
  if (facts.domains) return facts.domains;
  const domains = await readKnownDomains(db, userId);
  facts.domains = domains;
  return domains;
}

async function readKnownDomains(db: Kysely<DB>, userId: string): Promise<string[]> {
  const rows = await sql<{ d: string }>`
    select distinct split_part(lower(a.value), '@', 2) as d
    from email_messages m,
         lateral jsonb_array_elements_text(m.to_emails || m.cc_emails) a
    where m.user_id = ${userId}
      and m.gmail_label_ids @> '["SENT"]'::jsonb
      and m.auto_reply = 0
    union
    select distinct split_part(lower(p.email), '@', 2)
    from people p
    where p.owner_user_id = ${userId} and p.email is not null
    limit ${KNOWN_DOMAINS_MAX}
  `.execute(db);
  const out = new Set<string>();
  for (const r of rows.rows) {
    const reg = registrableDomain(r.d.replace(/>.*$/, ''));
    if (reg) out.add(reg);
  }
  return [...out];
}

export const nameKey =(n: string | null): string => n?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';

export async function annotateSenderChecks(
  db: Kysely<DB>,
  userId: string,
  opts: { threadId: string; bulk: boolean; rows: SenderRowFacts[]; messages: EmailMessage[] },
): Promise<EmailMessage[]> {
  const authById = new Map(opts.rows.map((r) => [r.id, r.auth_results ?? null]));
  const senders = opts.messages.filter((m) => !m.sent && m.fromEmail).map((m) => m.fromEmail!);
  const [own, histories, named, known] = await Promise.all([
    ownAddresses(db, userId),
    senderHistories(db, userId, senders, opts.threadId),
    contactsNamed(db, userId, opts.messages.filter((m) => !m.sent).map((m) => m.fromName)),
    knownDomains(db, userId),
  ]);
  return opts.messages.map((m) => ({
    ...m,
    senderCheck: checkSender({
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      replyTo: m.replyTo ?? null,
      auth: authById.get(m.id) ?? null,
      toEmails: m.toEmails.map(addressOf),
      ccEmails: m.ccEmails.map(addressOf),
      ownAddresses: own,
      history: m.fromEmail ? (histories.get(m.fromEmail.toLowerCase()) ?? null) : null,
      bulk: opts.bulk,
      linkHosts: linkHostsFromHtml(m.bodyHtml),
      contactNamed: named.get(nameKey(m.fromName)) ?? null,
      attachmentNames: (m.attachments ?? []).map((a) => a.filename),
      knownDomains: known,
      sent: m.sent,
    }),
  }));
}
