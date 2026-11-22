/**
 * Who you might be writing to (ADR 0114).
 *
 * Ranked from the user's OWN mail and their OWN people rows, never from a
 * global lookup. That constraint is the same one ADR 0065 put on contact
 * resolution: suggesting an address is a small disclosure, and a directory of
 * everyone's addresses reachable by prefix is a large one. Every row returned
 * here is one the user has already seen.
 *
 * The ranking is deliberately dumb and deliberately not recency-only: the
 * person you mail constantly should beat the person you mailed yesterday,
 * because the first is who you are probably writing to and the second is
 * already on screen.
 */
import { sql, type Kysely } from 'kysely';

import type { EmailRecipientSuggestion } from '@chord/kernel';

import { env } from '../../config/env.js';
import { indexKeyFor } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { buildGramsQuery } from '../../utils/blind-index.js';

/** Enough to fill a dropdown without covering the message being written. */
const LIMIT = 8;

/**
 * Below this, a prefix matches most of a mailbox and the ranking does all the
 * work — which is a slow scan to produce a list nobody asked for. ADR 0085 made
 * the same call about the literal search arm for the same reason.
 */
const MIN_PREFIX = 2;

interface Candidate {
  email: string;
  name: string | null;
  /** How many messages this address appears on. */
  weight: number;
  lastAt: string | null;
  source: EmailRecipientSuggestion['source'];
}

function merge(into: Map<string, Candidate>, c: Candidate): void {
  const key = c.email.toLowerCase();
  const existing = into.get(key);
  if (!existing) {
    into.set(key, c);
    return;
  }
  existing.weight += c.weight;
  // A name from `people` is one the user typed; a name off a From header is
  // whatever the sender chose. Prefer the former, then any name over none.
  if (c.source === 'person' || (!existing.name && c.name)) existing.name = c.name;
  if (c.lastAt && (!existing.lastAt || c.lastAt > existing.lastAt)) existing.lastAt = c.lastAt;
  if (c.source === 'person') existing.source = 'person';
}

export async function suggestRecipients(
  db: Kysely<DB>,
  userId: string,
  query: string,
): Promise<EmailRecipientSuggestion[]> {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_PREFIX) return [];
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const byEmail = new Map<string, Candidate>();
  // ADR 0201 — a sender's display name is sealed, so it is found through the
  // blind trigram index (three characters or more) and confirmed against the
  // opened name below. The address is not sealed and still matches by LIKE, so
  // a two-character query matches addresses only.
  const key = await indexKeyFor(userId, false);
  const nameGrams = key ? buildGramsQuery(key, q) : null;
  const legacyOn = env.CONTENT_LEGACY_TSV;

  // Three independent reads — none depends on another's result — fired
  // together rather than paying three round trips in series on every
  // keystroke (ADR 0114). Merged in the same order as before (senders,
  // recipients, people): `merge`'s own precedence rules (a `person` source
  // always wins the name, weight always sums) don't depend on arrival order,
  // only this loop order, which is unchanged.
  const [senders, recipients, people] = await Promise.all([
    // People you have received mail from.
    db
      .selectFrom('email_messages')
      .select([
        sql<string>`lower(from_email)`.as('email'),
        sql<string | null>`max(from_name)`.as('name'),
        sql<number>`count(*)`.as('weight'),
        sql<string>`max(internal_date)`.as('lastAt'),
        // A row with no blind index still has a readable name (CONTENT_LEGACY_TSV).
        sql<boolean>`bool_or(lower(from_email) like ${like} escape '\\' or (${legacyOn} and blind_from is null and lower(coalesce(from_name,'')) like ${like} escape '\\'))`.as('emailHit'),
      ])
      .where('user_id', '=', userId)
      .where('from_email', 'is not', null)
      .where(
        sql<boolean>`(lower(from_email) like ${like} escape '\\' or ${
          nameGrams ? sql`blind_from @@ ${sql`${nameGrams}::tsquery`}` : sql`false`
        } or ${
          legacyOn ? sql`(blind_from is null and lower(coalesce(from_name,'')) like ${like} escape '\\')` : sql`false`
        })`,
      )
      .groupBy(sql`lower(from_email)`)
      .orderBy('weight', 'desc')
      .limit(LIMIT * 3)
      .execute(),

    // People you have written to. Worth more per message than a sender: mail
    // arrives unbidden, and an address on a To line was chosen.
    db
      .selectFrom('email_messages as m')
      .innerJoin(
        sql<{ v: string }>`lateral jsonb_array_elements_text(m.to_emails)`.as('t'),
        (join) => join.onTrue(),
      )
      .select([
        sql<string>`lower(t.value)`.as('email'),
        sql<number>`count(*)`.as('weight'),
        sql<string>`max(m.internal_date)`.as('lastAt'),
      ])
      .where('m.user_id', '=', userId)
      .where(sql<boolean>`lower(t.value) like ${like} escape '\\'`)
      .groupBy(sql`lower(t.value)`)
      .orderBy('weight', 'desc')
      .limit(LIMIT * 3)
      .execute(),

    // People the user has actually named (ADR 0076). Weighted high because a
    // person in the family graph is one they told us about.
    db
      .selectFrom('people')
      .select(['display_name as name', 'email'])
      .where('owner_user_id', '=', userId)
      .where('email', 'is not', null)
      .where(
        sql<boolean>`(lower(email) like ${like} escape '\\' or lower(display_name) like ${like} escape '\\')`,
      )
      .limit(LIMIT)
      .execute(),
  ]);

  for (const r of senders) {
    // Found only through the name's trigrams: every piece is present, which is
    // not the same as the name containing the query (three characters is one
    // trigram, so it is exact; longer needs the opened name).
    if (!r.emailHit && q.length > 3 && !(r.name ?? '').toLowerCase().includes(q)) continue;
    merge(byEmail, {
      email: r.email,
      name: r.name,
      weight: Number(r.weight),
      lastAt: r.lastAt,
      source: 'correspondent',
    });
  }
  for (const r of recipients) {
    merge(byEmail, {
      email: r.email,
      name: null,
      weight: Number(r.weight) * 2,
      lastAt: r.lastAt,
      source: 'correspondent',
    });
  }
  for (const p of people) {
    if (!p.email) continue;
    merge(byEmail, {
      email: p.email.toLowerCase(),
      name: p.name,
      weight: 25,
      lastAt: null,
      source: 'person',
    });
  }

  return [...byEmail.values()]
    .sort((a, b) => b.weight - a.weight || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
    .slice(0, LIMIT)
    .map((c) => ({ email: c.email, name: c.name, source: c.source }));
}
