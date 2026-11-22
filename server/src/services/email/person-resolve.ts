/**
 * Who "Bill" is, in this user's mail (ADR 0270).
 *
 * A person asked for by name becomes the addresses that person writes from, so
 * a search filters on the sender instead of matching the word "bill" in every
 * invoice. Candidates come only from the user's OWN mail and OWN people rows
 * (the ADR 0065 / 0114 rule: never a directory lookup).
 *
 * Matching is by whole name token, with nicknames: "bill" matches William
 * Smith and bill.smith@, never billing@ or "5 bills to automate". Every word
 * asked for must match, so "Bill Smith" does not take Bill Jones. When two
 * people match about equally, the result is `ambiguous` and the caller asks.
 */
import { sql, type Kysely } from 'kysely';

import { mentionsRole, nameVariants, roleTerms } from '@chord/kernel';

import { env } from '../../config/env.js';
import { indexKeyFor } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { buildGramsQuery } from '../../utils/blind-index.js';

export interface CorrespondentCandidate {
  name: string | null;
  emails: string[];
  /** Messages this person appears on (sent to or from the user). */
  count: number;
}

/**
 * A shared sending address, matched together with the sender's name. One
 * noreply@ can send for the school district AND the pharmacy; asking for the
 * school must not bring the pharmacy along.
 */
export interface NamedAddress {
  email: string;
  /** Name words that must appear in the sender's name (any one form of each). */
  words: string[];
}

export type ResolvedCorrespondent =
  | { status: 'address'; addresses: string[]; domains: []; label: string }
  | { status: 'domain'; addresses: []; domains: string[]; label: string }
  | {
      status: 'resolved';
      addresses: string[];
      /** Shared robot addresses (noreply@...) that are this person only under their name. */
      named: NamedAddress[];
      domains: [];
      label: string;
      candidates: CorrespondentCandidate[];
      /** ADR 0275: found as a role ("the dentist"), with the words it was matched by. */
      role?: { terms: string[]; source: 'people' | 'contacts' | 'senders' };
    }
  | { status: 'ambiguous'; addresses: []; domains: []; label: string; candidates: CorrespondentCandidate[] }
  | { status: 'none'; addresses: []; domains: []; label: string };

/** A clear winner has at least this many times the runner-up's mail. */
const CLEAR_MARGIN = 3;
const SCAN_LIMIT = 60;

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^@?([a-z0-9-]+\.)+[a-z]{2,}$/i;
/** Robots: they rarely ARE the person someone means, so they sort last. */
const ROBOT = /^(no-?reply|do-?not-?reply|notifications?|alerts?|news(letter)?s?|billing|support|info|orders?|receipts?|mailer-daemon|postmaster|updates?|hello|team)\b/i;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}]+/u)
    .filter((t) => t.length >= 2);
}

function siteOf(email: string): string {
  const labels = (email.toLowerCase().split('@')[1] ?? '').split('.');
  return labels.length >= 2 ? labels[labels.length - 2] : '';
}

/** Name tokens, the address's local part split on dots/digits, and the domain's own name. */
function candidateTokens(name: string | null, email: string): Set<string> {
  const site = siteOf(email);
  const local = email.toLowerCase().split('@')[0] ?? '';
  return new Set([...tokens(name ?? ''), ...tokens(local), ...(site ? [site] : [])]);
}

function matchesAll(queryTokens: string[], have: Set<string>): boolean {
  return queryTokens.every((q) => nameVariants(q).some((v) => have.has(v)));
}

interface Row {
  email: string;
  name: string | null;
  /** Messages this address sent the user. */
  sent: number;
  /** Messages it was on the To/Cc of. */
  received: number;
  personName?: string;
}

/**
 * `direction` is which way the mail goes: someone asked for as a sender is
 * looked for among senders only, a recipient among recipients only. Offering
 * a person who never sent the user mail for "emails from" finds nothing.
 */
export async function resolveCorrespondent(
  db: Kysely<DB>,
  userId: string,
  raw: string,
  opts: { direction?: 'from' | 'to' } = {},
): Promise<ResolvedCorrespondent> {
  const direction = opts.direction;
  const label = raw.trim().replace(/^(?:the|my|our)\s+/i, '');
  const lower = label.toLowerCase();
  if (ADDRESS.test(lower)) return { status: 'address', addresses: [lower], domains: [], label };
  if (DOMAIN.test(lower) && !lower.includes(' ')) {
    return { status: 'domain', addresses: [], domains: [lower.replace(/^@/, '')], label };
  }

  const queryTokens = tokens(label);
  if (queryTokens.length === 0) return { status: 'none', addresses: [], domains: [], label };

  // Every form of every word, for the candidate scan. Confirmation below is
  // stricter (all words must match), so this only has to not miss anyone.
  const variants = [...new Set(queryTokens.flatMap((t) => nameVariants(t)))];
  const key = await indexKeyFor(userId, false);
  const grams = key
    ? variants.filter((v) => v.length >= 3).map((v) => buildGramsQuery(key, v)).filter((g): g is string => !!g)
    : [];
  const likes = variants.map((v) => `%${v.replace(/[\\%_]/g, '\\$&')}%`);
  const legacyOn = env.CONTENT_LEGACY_TSV;
  const anyLike = (col: string) =>
    sql.join(
      likes.map((l) => sql`lower(${sql.raw(col)}) like ${l} escape '\\'`),
      sql` or `,
    );

  const [senders, recipients, people] = await Promise.all([
    db
      .selectFrom('email_messages')
      .select([
        sql<string>`lower(from_email)`.as('email'),
        sql<string | null>`max(from_name)`.as('name'),
        sql<number>`count(*)`.as('count'),
      ])
      .where('user_id', '=', userId)
      .where('from_email', 'is not', null)
      .where(
        sql<boolean>`(${anyLike('from_email')}${
          grams.length ? sql` or ${sql.join(grams.map((g) => sql`blind_from @@ ${g}::tsquery`), sql` or `)}` : sql``
        }${legacyOn ? sql` or (blind_from is null and (${anyLike("coalesce(from_name,'')")}))` : sql``})`,
      )
      .groupBy(sql`lower(from_email)`)
      .orderBy('count', 'desc')
      .limit(SCAN_LIMIT)
      .execute(),
    db
      .selectFrom('email_messages as m')
      .innerJoin(sql<{ value: string }>`lateral jsonb_array_elements_text(m.to_emails || m.cc_emails)`.as('t'), (j) => j.onTrue())
      .select([sql<string>`lower(t.value)`.as('email'), sql<number>`count(*)`.as('count')])
      .where('m.user_id', '=', userId)
      .where(sql<boolean>`(${anyLike('t.value')})`)
      .groupBy(sql`lower(t.value)`)
      .orderBy('count', 'desc')
      .limit(SCAN_LIMIT)
      .execute(),
    db
      .selectFrom('people')
      .select(['display_name as name', 'email'])
      .where('owner_user_id', '=', userId)
      .where('email', 'is not', null)
      .where(sql<boolean>`(${anyLike('display_name')} or ${anyLike('email')})`)
      .limit(SCAN_LIMIT)
      .execute(),
  ]);

  const byEmail = new Map<string, Row>();
  const add = (email: string, name: string | null, sent: number, received: number, personName?: string) => {
    const e = email.toLowerCase();
    const cur = byEmail.get(e) ?? { email: e, name: null, sent: 0, received: 0 };
    cur.sent += sent;
    cur.received += received;
    if (personName) cur.personName = personName;
    if (!cur.name && name) cur.name = name;
    byEmail.set(e, cur);
  };
  for (const s of senders) add(s.email, s.name, Number(s.count), 0);
  for (const r of recipients) add(r.email, null, 0, Number(r.count));
  for (const p of people) if (p.email) add(p.email, p.name, 0, 0, p.name);

  const own = await ownAddresses(db, userId);
  const matched = [...byEmail.values()].filter(
    (r) =>
      !own.has(r.email) &&
      (matchesAll(queryTokens, candidateTokens(r.personName ?? r.name, r.email)) ||
        (r.personName !== undefined && r.name !== null && matchesAll(queryTokens, candidateTokens(r.name, r.email)))),
  );

  // "Deloitte" names the company, not one of its people: one word that is the
  // domain of every match. Search the domain rather than ask which person
  // ("Deloitte Billing" carries the company in its name too, so the name is
  // not what decides it).
  const [only] = queryTokens;
  const domainOnly =
    queryTokens.length === 1 &&
    matched.length > 0 &&
    matched.every((r) => nameVariants(only!).includes(siteOf(r.email)));
  if (domainOnly) {
    const domains = [...new Set(matched.map((r) => r.email.split('@')[1]!))].sort();
    return { status: 'domain', addresses: [], domains, label };
  }

  // A People row with no mail stays a candidate: the user told us about them.
  const confirmed = matched
    .filter((r) => direction !== 'from' || r.sent > 0 || (r.personName !== undefined && r.received === 0))
    .filter((r) => direction !== 'to' || r.received > 0 || (r.personName !== undefined && r.sent === 0))
    .map((r) => ({ ...r, count: direction === 'from' ? r.sent : direction === 'to' ? r.received : r.sent + r.received }));
  // Nobody by that name. "The dentist" is not a name but a role: ADR 0275.
  if (confirmed.length === 0) {
    const terms = roleTerms(label);
    const byRole = terms ? await resolveByRole(db, userId, label, terms, own) : null;
    return byRole ?? { status: 'none', addresses: [], domains: [], label };
  }

  // One person can write from several addresses: group by the name they go
  // by (a people row's name first), falling back to the address.
  const groups = new Map<string, { name: string | null; emails: string[]; count: number; robot: boolean }>();
  for (const r of confirmed) {
    const name = r.personName ?? r.name;
    const k = name ? tokens(name).sort().join(' ') || r.email : r.email;
    const g = groups.get(k) ?? { name, emails: [], count: 0, robot: true };
    g.emails.push(r.email);
    // A people row is someone the user told us about: worth a lot of mail.
    g.count += r.count + (r.personName ? 25 : 0);
    if (!ROBOT.test(r.email.split('@')[0])) g.robot = false;
    groups.set(k, g);
  }
  const ranked = [...groups.values()].sort((a, b) => Number(a.robot) - Number(b.robot) || b.count - a.count);
  const candidates = ranked.slice(0, 5).map((g) => ({ name: g.name, emails: g.emails, count: g.count }));
  const [top, second] = ranked;
  if (second && !second.robot && !top.robot && top.count < second.count * CLEAR_MARGIN) {
    return { status: 'ambiguous', addresses: [], domains: [], label, candidates };
  }
  const addresses: string[] = [];
  const named: NamedAddress[] = [];
  for (const email of top.emails) {
    const local = email.split('@')[0];
    if (ROBOT.test(local) && !matchesAll(queryTokens, candidateTokens(null, email))) {
      const have = candidateTokens(top.name, email);
      named.push({ email, words: queryTokens.map((q) => nameVariants(q).find((v) => have.has(v)) ?? q) });
    } else {
      addresses.push(email);
    }
  }
  return { status: 'resolved', addresses, named, domains: [], label, candidates };
}

/** The user's own addresses: a person asked for is never the user. */
async function ownAddresses(db: Kysely<DB>, userId: string): Promise<Set<string>> {
  const [user, accounts] = await Promise.all([
    db.selectFrom('users').select(['email']).where('id', '=', userId).executeTakeFirst(),
    db.selectFrom('email_accounts').select(['email_address as email']).where('user_id', '=', userId).execute(),
  ]);
  return new Set([user?.email, ...accounts.map((a) => a.email)].filter((e): e is string => !!e).map((e) => e.toLowerCase()));
}

/** At most this many addresses stand for one role ("the school" is several senders). */
const ROLE_MAX_ADDRESSES = 10;

/**
 * ADR 0275 — "the dentist" as the addresses that are the dentist, from what
 * the user already has, strongest first:
 *   1. a People row whose notes or name say so ("Dr. Patel - our dentist"),
 *   2. a saved contact whose organisation, note or tags say so, by its name,
 *   3. senders whose own name or address says so ("Bright Smiles Dental",
 *      office@brightsmilesdental.com).
 * A role is not asked about when several match: every sender that is "the
 * school" is the school. Null when nothing matches; the caller may then ask
 * the phone's address book.
 */
async function resolveByRole(
  db: Kysely<DB>,
  userId: string,
  label: string,
  terms: string[],
  own: Set<string>,
): Promise<ResolvedCorrespondent | null> {
  const done = (
    addresses: string[],
    named: NamedAddress[],
    candidates: CorrespondentCandidate[],
    source: 'people' | 'contacts' | 'senders',
  ): ResolvedCorrespondent => ({
    status: 'resolved',
    addresses: [...new Set(addresses)].filter((a) => !own.has(a)).slice(0, ROLE_MAX_ADDRESSES),
    named,
    domains: [],
    label,
    candidates,
    role: { terms, source },
  });

  // 1. People the user told us about.
  const people = (
    await db
      .selectFrom('people')
      .select(['display_name as name', 'notes', 'email'])
      .where('owner_user_id', '=', userId)
      .where('email', 'is not', null)
      .execute()
  ).filter((p) => mentionsRole(p.notes, terms) || mentionsRole(p.name, terms));
  if (people.length > 0) {
    return done(
      people.map((p) => p.email!.toLowerCase()),
      [],
      people.map((p) => ({ name: p.name, emails: [p.email!.toLowerCase()], count: 25 })),
      'people',
    );
  }

  // 2. Saved contacts in the user's groups: no email of their own, so their
  //    name is looked up among the user's correspondents.
  const contacts = (
    await db
      .selectFrom('contacts as c')
      .innerJoin('group_members as gm', 'gm.group_id', 'c.group_id')
      .select(['c.name', 'c.org', 'c.note', 'c.tags'])
      .where('gm.user_id', '=', userId)
      .execute()
  ).filter((c) => mentionsRole(c.org, terms) || mentionsRole(c.note, terms) || mentionsRole(c.tags, terms));
  const fromContacts: string[] = [];
  const contactCandidates: CorrespondentCandidate[] = [];
  for (const c of contacts.slice(0, 5)) {
    for (const who of [c.name, c.org].filter((x): x is string => !!x)) {
      if (roleTerms(who)) continue;
      const r = await resolveCorrespondent(db, userId, who);
      if (r.status === 'resolved' && r.addresses.length > 0) {
        fromContacts.push(...r.addresses);
        contactCandidates.push({ name: c.name, emails: r.addresses, count: 0 });
        break;
      }
    }
  }
  if (fromContacts.length > 0) return done(fromContacts, [], contactCandidates, 'contacts');

  // 3. Senders whose own name or address says what they are.
  const key = await indexKeyFor(userId, false);
  const singleWords = terms.filter((t) => !t.includes(' '));
  const grams = key ? terms.filter((t) => t.length >= 3).map((t) => buildGramsQuery(key, t)).filter((g): g is string => !!g) : [];
  const likes = singleWords.filter((t) => t.length >= 4).map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
  if (grams.length === 0 && likes.length === 0) return null;
  const legacyOn = env.CONTENT_LEGACY_TSV;
  const rows = await db
    .selectFrom('email_messages')
    .select([sql<string>`lower(from_email)`.as('email'), sql<string | null>`max(from_name)`.as('name'), sql<number>`count(*)`.as('count')])
    .where('user_id', '=', userId)
    .where('from_email', 'is not', null)
    .where(
      sql<boolean>`(${sql.join(
        [
          ...grams.map((g) => sql`blind_from @@ ${g}::tsquery`),
          ...likes.map((l) => sql`lower(from_email) like ${l} escape '\\'`),
          ...(legacyOn ? likes.map((l) => sql`(blind_from is null and lower(coalesce(from_name,'')) like ${l} escape '\\'`) : []),
        ],
        sql` or `,
      )})`,
    )
    .groupBy(sql`lower(from_email)`)
    .orderBy('count', 'desc')
    .limit(SCAN_LIMIT)
    .execute();

  const addresses: string[] = [];
  const named: NamedAddress[] = [];
  const candidates: CorrespondentCandidate[] = [];
  for (const r of rows) {
    if (own.has(r.email)) continue;
    const [local = ''] = r.email.split('@');
    const inName = mentionsRole(r.name, terms);
    // The local part has word breaks ("school.office@"); a domain does not, so
    // "dental" inside "dentalplansweekly" cannot be told from
    // "brightsmilesdental" and the domain is not read for a role.
    const inAddress = mentionsRole(local.replace(/[._+-]+/g, ' '), terms);
    if (!inName && !inAddress) continue;
    if (ROBOT.test(local) && !inAddress) {
      // A shared noreply@ is this role only under a name that says so.
      named.push({ email: r.email, words: [terms.find((t) => mentionsRole(r.name, [t]))!] });
    } else {
      addresses.push(r.email);
    }
    candidates.push({ name: r.name, emails: [r.email], count: Number(r.count) });
    if (addresses.length + named.length >= ROLE_MAX_ADDRESSES) break;
  }
  if (addresses.length === 0 && named.length === 0) return null;
  return done(addresses, named, candidates.slice(0, 5), 'senders');
}
