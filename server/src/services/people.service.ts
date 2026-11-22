/**
 * People + important dates (ADR 0016 — first slice). The whole graph is
 * per-user, identified by `owner_user_id`. Bot tools and `/me/people`
 * routes share this module so creation rules stay consistent.
 *
 * Migration 082 (docs/notes/0189) completes ADR 0016's never-shipped
 * `relationships` table (`addPersonRelationship`/`listRelationshipEdges`)
 * and adds `getPersonProfile`, the "tell me about X" read.
 */
import { sql, type Kysely, type Selectable } from 'kysely';

import {
  RELATION_KINDS,
  type ImportantDateId,
  type PersonActivityMention,
  type PersonFact,
  type PersonId,
  type PersonProfile,
  type PersonRelationship,
  type RelationKind,
  type RelationSubjectType,
  type ResolvedRelationship,
  type UserId,
} from '@chord/kernel';

import type {
  DB,
  PeopleTable,
  PersonRelationshipsTable,
  ProvisionalPeopleTable,
} from '../db/schema.js';
import { instantMs, textInstant } from '../db/text-instant.js';
import { newId } from '../utils/ids.js';
import { dayOf } from '../utils/tz.js';
import { confirmMemory, upsertMemory } from './memory.service.js';

export type ImportantDateKind = 'birthday' | 'anniversary' | 'death' | 'other';

export interface Person {
  id: string;
  ownerUserId: string;
  displayName: string;
  notes: string | null;
  /** ADR 0076 — known email address (sender anchor for email extraction). */
  email: string | null;
  /** ADR 0212 — as the user gave it. */
  phone: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToPerson(row: Selectable<PeopleTable>): Person {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    displayName: row.display_name,
    notes: row.notes,
    email: row.email ?? null,
    phone: row.phone ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ImportantDate {
  id: string;
  personId: string;
  kind: ImportantDateKind;
  date: string;
  recurs: boolean;
}

export interface PersonWithDates extends Person {
  importantDates: ImportantDate[];
}

export async function listPeopleForUser(
  db: Kysely<DB>,
  ownerUserId: string,
): Promise<PersonWithDates[]> {
  const people = await db
    .selectFrom('people')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .orderBy('display_name', 'asc')
    .execute();
  if (people.length === 0) return [];

  const dates = await db
    .selectFrom('important_dates')
    .selectAll()
    .where(
      'person_id',
      'in',
      people.map((p) => p.id),
    )
    .execute();

  const byPerson = new Map<string, ImportantDate[]>();
  for (const d of dates) {
    const arr = byPerson.get(d.person_id) ?? [];
    arr.push({
      id: d.id,
      personId: d.person_id,
      kind: d.kind as ImportantDateKind,
      date: d.date,
      recurs: Number(d.recurs) === 1,
    });
    byPerson.set(d.person_id, arr);
  }

  return people.map((p) => ({
    ...rowToPerson(p),
    importantDates: byPerson.get(p.id) ?? [],
  }));
}

export async function findPersonByName(
  db: Kysely<DB>,
  ownerUserId: string,
  displayName: string,
): Promise<Person | null> {
  const wanted = displayName.trim().toLowerCase();
  const candidates = await db
    .selectFrom('people')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .execute();
  // Case-insensitive comparison without an extra index. Cardinality stays low
  // (people the user knows), so a scan is fine.
  const hit = candidates.find((c) => c.display_name.trim().toLowerCase() === wanted);
  if (!hit) return null;
  return rowToPerson(hit);
}

/** ADR 0076 — resolve a sender address to a known person (case-insensitive). */
export async function findPersonByEmail(
  db: Kysely<DB>,
  ownerUserId: string,
  email: string,
): Promise<Person | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  const candidates = await db
    .selectFrom('people')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .where('email', 'is not', null)
    .execute();
  const hit = candidates.find((c) => (c.email ?? '').trim().toLowerCase() === wanted);
  if (!hit) return null;
  return rowToPerson(hit);
}

export async function createPerson(
  db: Kysely<DB>,
  args: {
    ownerUserId: string;
    displayName: string;
    notes?: string | null;
    email?: string | null;
    /** docs/notes/0191 — promoting a provisional person reuses its id so attached facts need no re-point. */
    id?: string;
    /** ADR 0312 — what produced this person (`gmail:<threadId>` for mail), so
     *  disconnecting that mailbox can remove it. */
    provenance?: string | null;
  },
): Promise<Person> {
  const id = args.id ?? newId('p');
  const now = new Date().toISOString();
  const email = args.email?.trim().toLowerCase() || null;
  await db
    .insertInto('people')
    .values({
      id,
      owner_user_id: args.ownerUserId,
      display_name: args.displayName.trim(),
      notes: args.notes?.trim() || null,
      email,
      provenance: args.provenance ?? null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return {
    id,
    ownerUserId: args.ownerUserId,
    displayName: args.displayName.trim(),
    notes: args.notes?.trim() || null,
    email,
    phone: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * ADR 0212 — patch a person's own fields. `undefined` leaves a field alone;
 * `null` (or an empty string) clears it. Owner-scoped: another user's person
 * id updates nothing and returns null.
 */
export async function updatePerson(
  db: Kysely<DB>,
  ownerUserId: string,
  personId: string,
  patch: {
    displayName?: string;
    notes?: string | null;
    email?: string | null;
    phone?: string | null;
  },
): Promise<Person | null> {
  const set: Partial<Selectable<PeopleTable>> = {};
  if (patch.displayName !== undefined && patch.displayName.trim()) {
    set.display_name = patch.displayName.trim();
  }
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  if (patch.email !== undefined) set.email = patch.email?.trim().toLowerCase() || null;
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (Object.keys(set).length > 0) {
    set.updated_at = new Date().toISOString();
    await db
      .updateTable('people')
      .set(set)
      .where('id', '=', personId)
      .where('owner_user_id', '=', ownerUserId)
      .execute();
  }
  const row = await db
    .selectFrom('people')
    .selectAll()
    .where('id', '=', personId)
    .where('owner_user_id', '=', ownerUserId)
    .executeTakeFirst();
  return row ? rowToPerson(row) : null;
}

export async function deletePerson(
  db: Kysely<DB>,
  ownerUserId: string,
  personId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('people')
    .where('id', '=', personId)
    .where('owner_user_id', '=', ownerUserId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

export async function addImportantDate(
  db: Kysely<DB>,
  args: {
    personId: string;
    kind: ImportantDateKind;
    date: string;
    recurs: boolean;
  },
): Promise<ImportantDate> {
  const id = newId('d');
  await db
    .insertInto('important_dates')
    .values({
      id,
      person_id: args.personId,
      kind: args.kind,
      date: args.date,
      recurs: args.recurs ? 1 : 0,
    })
    .execute();
  return { id, ...args };
}

export async function deleteImportantDate(
  db: Kysely<DB>,
  ownerUserId: string,
  dateId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('important_dates')
    .where('id', '=', dateId)
    .where(
      'person_id',
      'in',
      db.selectFrom('people').select('id').where('owner_user_id', '=', ownerUserId),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

/**
 * ADR 0076/0078 — what Chord has learned about each saved person, keyed by
 * person id, for the People screen. ADR 0333: a fact is shown under the
 * person it is ABOUT (`subject_type = 'person'`, `subject_id`), never under
 * someone whose first name happens to appear in its value ("Maya Lin" was
 * shown "kid name: Maya Doe"). Confirmed, non-superseded only — proposals
 * stay in the Memory tab until accepted.
 */
export async function learnedFactsForPeople(
  db: Kysely<DB>,
  ownerUserId: string,
  people: Array<{ id: string; displayName: string }>,
): Promise<Map<string, Array<{ key: string; value: string }>>> {
  const out = new Map<string, Array<{ key: string; value: string }>>();
  if (people.length === 0) return out;
  const memories = await db
    .selectFrom('memories')
    .innerJoin('people', 'people.id', 'memories.subject_id')
    .select(['memories.subject_id as personId', 'memories.key as key', 'memories.value as value'])
    .where('memories.subject_type', '=', 'person')
    .where('memories.subject_id', 'in', people.map((p) => p.id))
    .where('people.owner_user_id', '=', ownerUserId)
    .where('memories.status', '=', 'confirmed')
    .where('memories.superseded_by', 'is', null)
    .orderBy('memories.created_at', 'desc')
    .execute();
  for (const m of memories) {
    const list = out.get(m.personId!) ?? [];
    list.push({ key: m.key, value: m.value });
    out.set(m.personId!, list);
  }
  // The owner's own relationship facts ("spouse name: Alice", ADR 0076)
  // name a person outright: shown under them when the WHOLE value is that
  // person's full or first name, never when the name is only somewhere in it.
  const relations = await db
    .selectFrom('memories')
    .select(['key', 'value'])
    .where('persona_id', '=', ownerUserId)
    .where('scope', '=', 'persona')
    .where('key', 'like', '%\\_name')
    .where('status', '=', 'confirmed')
    .where('superseded_by', 'is', null)
    .execute();
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const p of people) {
    const full = norm(p.displayName);
    const first = full.split(' ')[0] ?? '';
    for (const r of relations) {
      const v = norm(r.value);
      if (v !== full && v !== first) continue;
      const list = out.get(p.id) ?? [];
      list.push({ key: r.key, value: r.value });
      out.set(p.id, list);
    }
  }
  return out;
}

/**
 * ADR 0078 — staged add_person / add_important_date proposals awaiting the
 * owner's decision, for the People screen's "waiting on you" strip. Resolve
 * through the standard proposal routes.
 */
export async function listPendingPersonSuggestions(
  db: Kysely<DB>,
  ownerUserId: string,
): Promise<Array<{ proposalId: string; kind: 'person' | 'date'; title: string; detail: string | null }>> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'provenance'])
    .where('proposed_by_user_id', '=', ownerUserId)
    .where('status', '=', 'pending')
    .where('expires_at', '>', new Date().toISOString())
    .where('tool_name', 'in', ['add_person', 'add_important_date'])
    .orderBy('created_at', 'desc')
    .execute();
  // Resolve gmail provenance → the owner's local email-thread row, so the
  // suggestion text can open its source email before ✓/✕.
  const gmailIds = [
    ...new Set(
      rows
        .filter((r) => r.provenance?.startsWith('gmail:'))
        .map((r) => r.provenance!.slice('gmail:'.length)),
    ),
  ];
  const rowByGmailId = new Map<string, string>();
  if (gmailIds.length > 0) {
    const threads = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id'])
      .where('user_id', '=', ownerUserId)
      .where('gmail_thread_id', 'in', gmailIds)
      .execute();
    for (const t of threads) rowByGmailId.set(t.gmail_thread_id, t.id);
  }
  const hrefFor = (provenance: string | null): string | null => {
    if (!provenance?.startsWith('gmail:')) return null;
    const rowId = rowByGmailId.get(provenance.slice('gmail:'.length));
    return rowId ? `/email/${rowId}` : null;
  };
  // docs/notes/0191 — the facts riding on a provisional person are part of
  // what the tap confirms, so the card lists them.
  const provisionalIds: string[] = [];
  for (const r of rows) {
    if (r.tool_name !== 'add_person') continue;
    try {
      const a = JSON.parse(r.args_json) as { provisionalPersonId?: unknown };
      if (typeof a.provisionalPersonId === 'string') provisionalIds.push(a.provisionalPersonId);
    } catch {
      // malformed args — skipped again below
    }
  }
  const attachedFacts = await provisionalFactsFor(db, provisionalIds);
  const out: Array<{
    proposalId: string;
    kind: 'person' | 'date';
    title: string;
    detail: string | null;
    sourceHref: string | null;
  }> = [];
  for (const r of rows) {
    try {
      const args = JSON.parse(r.args_json) as Record<string, unknown>;
      if (r.tool_name === 'add_person' && typeof args.displayName === 'string') {
        const facts =
          typeof args.provisionalPersonId === 'string' ? attachedFacts.get(args.provisionalPersonId) ?? [] : [];
        const parts = [
          typeof args.notes === 'string' ? args.notes : null,
          ...facts.map((f) => `${f.key.replace(/_/g, ' ')}: ${f.value}`),
        ].filter((p): p is string => !!p);
        out.push({
          proposalId: r.id,
          kind: 'person',
          title: args.displayName,
          detail: parts.length > 0 ? parts.join(' · ') : null,
          sourceHref: hrefFor(r.provenance),
        });
      } else if (
        r.tool_name === 'add_important_date' &&
        typeof args.personName === 'string' &&
        typeof args.date === 'string'
      ) {
        out.push({
          proposalId: r.id,
          kind: 'date',
          title: args.personName,
          detail: `${typeof args.kind === 'string' ? args.kind : 'date'} · ${args.date}`,
          sourceHref: hrefFor(r.provenance),
        });
      }
    } catch {
      // malformed args — skip
    }
  }
  return out;
}

/**
 * Used by the proactive morning scan: returns dated occurrences of every
 * important date in the next `withinDays` window for the given user.
 * Recurring entries fire once in the year that produces the next match.
 */
export async function listImportantDayOccurrences(
  db: Kysely<DB>,
  ownerUserId: string,
  withinDays: number,
): Promise<Array<{ personName: string; kind: ImportantDateKind; on: string }>> {
  const rows = await db
    .selectFrom('important_dates as d')
    .innerJoin('people as p', 'p.id', 'd.person_id')
    .where('p.owner_user_id', '=', ownerUserId)
    .select([
      'd.kind as kind',
      'd.date as date',
      'd.recurs as recurs',
      'p.display_name as personName',
    ])
    .execute();

  // Plain calendar dates, with "today" the owner's own day: the server clock
  // (UTC) has already moved on to tomorrow on a US evening.
  const owner = await db.selectFrom('users').select('last_tz').where('id', '=', ownerUserId).executeTakeFirst();
  const today = dayOf(new Date().toISOString(), owner?.last_tz ?? null);
  const dateOn = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  const todayYear = Number.parseInt(today.slice(0, 4), 10);
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + withinDays * 86400000).toISOString().slice(0, 10);

  const out: Array<{ personName: string; kind: ImportantDateKind; on: string }> = [];
  for (const r of rows) {
    const [yStr, mStr, dStr] = r.date.split('-');
    const m = Number.parseInt(mStr ?? '', 10);
    const d = Number.parseInt(dStr ?? '', 10);
    if (!m || !d) continue;
    const recurs = Number(r.recurs) === 1 || yStr === '0000';
    if (recurs) {
      // Try this year first; if already past today, try next year.
      for (const y of [todayYear, todayYear + 1]) {
        const on = dateOn(y, m, d);
        if (on >= today && on <= horizon) {
          out.push({ personName: r.personName, kind: r.kind as ImportantDateKind, on });
          break;
        }
      }
    } else {
      const y = Number.parseInt(yStr ?? '', 10);
      if (!y) continue;
      const on = dateOn(y, m, d);
      if (on >= today && on <= horizon) {
        out.push({ personName: r.personName, kind: r.kind as ImportantDateKind, on });
      }
    }
  }
  out.sort((a, b) => a.on.localeCompare(b.on));
  return out;
}

// ---------------------------------------------------------------------------
// Migration 082 — relationship edges (ADR 0016 completion) + person profiles.
// ---------------------------------------------------------------------------

/** Free-text → canonical vocabulary, mirroring `RELATION_MEMORY_KEY` in
 *  `email/person-extraction.ts` (kept in sync by hand; there's exactly one
 *  server-side write path today, so a shared kernel helper would be premature
 *  — see ADR 0158's `trip_classifier` precedent for when to promote one). */
const RELATION_ALIASES: Record<string, RelationKind> = {
  spouse: 'spouse',
  wife: 'spouse',
  husband: 'spouse',
  partner: 'partner',
  kid: 'kid',
  child: 'kid',
  son: 'kid',
  daughter: 'kid',
  parent: 'parent',
  mother: 'parent',
  father: 'parent',
  mom: 'parent',
  dad: 'parent',
  sibling: 'sibling',
  brother: 'sibling',
  sister: 'sibling',
  friend: 'friend',
  teacher: 'teacher',
  coach: 'coach',
  doctor: 'doctor',
  'travel companion': 'travel_companion',
  travel_companion: 'travel_companion',
};

export function normalizeRelation(raw: string): RelationKind {
  const key = raw.trim().toLowerCase();
  const hit = RELATION_ALIASES[key];
  if (hit) return hit;
  return (RELATION_KINDS as readonly string[]).includes(key) ? (key as RelationKind) : 'other';
}

function rowToPersonRelationship(row: PersonRelationshipsTable): PersonRelationship {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    relatedType: row.related_type,
    relatedId: row.related_id,
    relation: row.relation as RelationKind,
    confidence: row.confidence,
    status: row.status,
    source: row.source,
    provenance: row.provenance,
    createdAt: row.created_at,
  };
}

/**
 * Insert a relationship edge, deduping on the exact (subject, related,
 * relation) triple — the unique index backstops this, but checking first
 * avoids depending on a Kysely `onConflict().doNothing()` round-trip just to
 * discover nothing changed. No supersede: several relation kinds can coexist
 * between the same two subjects. Always defaults to `status:'proposed'` for
 * anything not `source:'explicit'` — relationship claims never get the
 * `memories` lighter bar (docs/notes/0189).
 */
export async function addPersonRelationship(
  db: Kysely<DB>,
  args: {
    ownerUserId: string;
    subjectType: RelationSubjectType;
    subjectId: string;
    relatedType: RelationSubjectType;
    relatedId: string;
    relation: string;
    confidence?: number;
    source: 'passive' | 'extracted' | 'explicit';
    provenance?: string | null;
  },
): Promise<PersonRelationship> {
  const relation = normalizeRelation(args.relation);
  const existing = await db
    .selectFrom('person_relationships')
    .selectAll()
    .where('owner_user_id', '=', args.ownerUserId)
    .where('subject_type', '=', args.subjectType)
    .where('subject_id', '=', args.subjectId)
    .where('related_type', '=', args.relatedType)
    .where('related_id', '=', args.relatedId)
    .where('relation', '=', relation)
    .executeTakeFirst();
  if (existing) return rowToPersonRelationship(existing);

  const row: PersonRelationshipsTable = {
    id: newId('rel'),
    owner_user_id: args.ownerUserId,
    subject_type: args.subjectType,
    subject_id: args.subjectId,
    related_type: args.relatedType,
    related_id: args.relatedId,
    relation,
    confidence: args.confidence ?? 0.6,
    status: args.source === 'explicit' ? 'confirmed' : 'proposed',
    source: args.source,
    provenance: args.provenance ?? null,
    created_at: new Date().toISOString(),
  };
  await db
    .insertInto('person_relationships')
    .values(row)
    .onConflict((oc) =>
      oc
        .columns(['owner_user_id', 'subject_type', 'subject_id', 'related_type', 'related_id', 'relation'])
        .doNothing(),
    )
    .execute();
  return rowToPersonRelationship(row);
}

/** Every edge touching this subject, either as `subject` or as `related`. */
export async function listRelationshipEdges(
  db: Kysely<DB>,
  ownerUserId: string,
  subjectType: RelationSubjectType,
  subjectId: string,
): Promise<PersonRelationship[]> {
  const rows = await db
    .selectFrom('person_relationships')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .where((eb) =>
      eb.or([
        eb.and([eb('subject_type', '=', subjectType), eb('subject_id', '=', subjectId)]),
        eb.and([eb('related_type', '=', subjectType), eb('related_id', '=', subjectId)]),
      ]),
    )
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(rowToPersonRelationship);
}

export async function confirmPersonRelationship(
  db: Kysely<DB>,
  ownerUserId: string,
  id: string,
): Promise<PersonRelationship | null> {
  const row = await db
    .selectFrom('person_relationships')
    .selectAll()
    .where('id', '=', id)
    .where('owner_user_id', '=', ownerUserId)
    .executeTakeFirst();
  if (!row) return null;
  if (row.status !== 'confirmed') {
    await db.updateTable('person_relationships').set({ status: 'confirmed' }).where('id', '=', id).execute();
  }
  return rowToPersonRelationship({ ...row, status: 'confirmed' });
}

export async function rejectPersonRelationship(
  db: Kysely<DB>,
  ownerUserId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('person_relationships')
    .where('id', '=', id)
    .where('owner_user_id', '=', ownerUserId)
    .where('status', '=', 'proposed')
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}

async function displayNameFor(
  db: Kysely<DB>,
  type: RelationSubjectType,
  id: string,
): Promise<string> {
  if (type === 'person') {
    const p = await db.selectFrom('people').select('display_name').where('id', '=', id).executeTakeFirst();
    return p?.display_name ?? 'Someone';
  }
  if (type === 'persona') {
    const p = await db.selectFrom('personas').select('name').where('id', '=', id).executeTakeFirst();
    return p?.name ?? 'Someone';
  }
  const u = await db
    .selectFrom('users')
    .select(['display_name', 'username'])
    .where('id', '=', id)
    .executeTakeFirst();
  return u?.display_name ?? u?.username ?? 'Someone';
}

/** Confirmed edges only, both ends' names resolved — see kernel's
 *  `ResolvedRelationship` doc comment for why direction is never inverted. */
async function resolvedRelationshipsFor(
  db: Kysely<DB>,
  ownerUserId: string,
  subjectType: RelationSubjectType,
  subjectId: string,
): Promise<ResolvedRelationship[]> {
  const edges = await listRelationshipEdges(db, ownerUserId, subjectType, subjectId);
  const confirmed = edges.filter((e) => e.status === 'confirmed');
  const out: ResolvedRelationship[] = [];
  for (const e of confirmed) {
    out.push({
      relation: e.relation,
      subjectName: await displayNameFor(db, e.subjectType, e.subjectId),
      subjectType: e.subjectType,
      relatedName: await displayNameFor(db, e.relatedType, e.relatedId),
      relatedType: e.relatedType,
      status: e.status,
    });
  }
  return out;
}

/** Bounded, live-queried recent activity for a person — never stored, always
 *  derived (ADR 0135/0138's render-don't-restate rule). Only reaches trips/
 *  tasks/events through a `personas` row `linked_person_id`-ing back to this
 *  private contact; a person with no group presence simply has none. */
async function recentActivityFor(
  db: Kysely<DB>,
  ownerUserId: string,
  personId: string,
  limit = 8,
): Promise<PersonActivityMention[]> {
  const personas = await db
    .selectFrom('personas')
    .select('id')
    .where('linked_person_id', '=', personId)
    .execute();
  const personaIds = personas.map((p) => p.id);
  if (personaIds.length === 0) return [];

  const ownGroupIds = db
    .selectFrom('group_members')
    .select('group_id')
    .where('user_id', '=', ownerUserId);

  const legs = await db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .where('travel_legs.persona_id', 'in', personaIds)
    .where('trips.group_id', 'in', ownGroupIds)
    .where('trips.cancelled_at', 'is', null)
    .where('trips.deleted_at', 'is', null)
    .select(['trips.id as id', 'trips.name as title', 'travel_legs.depart_at as at'])
    // Nearest to today either way: newest-first let a far-future leg or event
    // crowd out this week's.
    .orderBy(sql`abs(extract(epoch from (${textInstant('travel_legs.depart_at')} - now())))`, 'asc')
    .limit(limit)
    .execute();

  const tasks = await db
    .selectFrom('tasks')
    .where('assignee_persona_id', 'in', personaIds)
    .where('group_id', 'in', ownGroupIds)
    .select(['id', 'title', 'due_at as at'])
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();

  const events = await db
    .selectFrom('events')
    .where('assignee_persona_id', 'in', personaIds)
    .where('group_id', 'in', ownGroupIds)
    // The viewer's own live copy (ADR 0040 fan-out) - not every member's,
    // and not one deleted or cancelled.
    .where('owner_user_id', '=', ownerUserId)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .select(['id', 'title', 'starts_at as at'])
    .orderBy(sql`abs(extract(epoch from (${textInstant('events.starts_at')} - now())))`, 'asc')
    .limit(limit)
    .execute();

  const out: PersonActivityMention[] = [
    ...legs.map((l) => ({ kind: 'trip' as const, id: l.id, title: l.title, at: l.at })),
    ...tasks.map((t) => ({ kind: 'task' as const, id: t.id, title: t.title, at: t.at })),
    ...events.map((e) => ({ kind: 'event' as const, id: e.id, title: e.title, at: e.at })),
  ];
  // Newest first by instant (legs, tasks and events store different shapes);
  // an undated task sorts last.
  const at = (m: PersonActivityMention) => (m.at ? instantMs(m.at) : Number.NEGATIVE_INFINITY);
  out.sort((a, b) => at(b) - at(a) || 0);
  return out.slice(0, limit);
}

/**
 * "Tell me about X" — one read, assembled from three cheap queries (same
 * `Promise.all` + in-memory-composition shape `family-profile.service.ts`'s
 * `getGroupProfile` already uses), never a bigger stored blob.
 */
export async function getPersonProfile(
  db: Kysely<DB>,
  ownerUserId: string,
  personId: string,
): Promise<PersonProfile | null> {
  const person = await db
    .selectFrom('people')
    .selectAll()
    .where('id', '=', personId)
    .where('owner_user_id', '=', ownerUserId)
    .executeTakeFirst();
  if (!person) return null;

  const [dates, relationships, factRows, recentActivity] = await Promise.all([
    db.selectFrom('important_dates').selectAll().where('person_id', '=', personId).execute(),
    resolvedRelationshipsFor(db, ownerUserId, 'person', personId),
    db
      .selectFrom('memories')
      .select(['key', 'value'])
      .where('subject_type', '=', 'person')
      .where('subject_id', '=', personId)
      .where('status', '=', 'confirmed')
      .where('superseded_by', 'is', null)
      .execute(),
    recentActivityFor(db, ownerUserId, personId),
  ]);

  const facts: PersonFact[] = factRows.map((f) => ({ key: f.key, value: f.value }));

  return {
    person: {
      id: person.id as PersonId,
      ownerUserId: person.owner_user_id as UserId,
      displayName: person.display_name,
      notes: person.notes,
      email: person.email ?? null,
      phone: person.phone ?? null,
      facts,
      createdAt: person.created_at,
      updatedAt: person.updated_at,
      importantDates: dates.map((d) => ({
        id: d.id as ImportantDateId,
        personId: d.person_id as PersonId,
        kind: d.kind as ImportantDateKind,
        date: d.date,
        recurs: Number(d.recurs) === 1,
      })),
    },
    relationships,
    facts,
    recentActivity,
  };
}

// ---------------------------------------------------------------------------
// docs/notes/0191 — provisional people: an id to attach facts to before the
// user has confirmed the person exists. Never `people`, so no existing reader
// can see one.
// ---------------------------------------------------------------------------

export interface ProvisionalPerson {
  id: string;
  ownerUserId: string;
  displayName: string;
  email: string | null;
  notes: string | null;
  proposalId: string | null;
}

function rowToProvisional(r: ProvisionalPeopleTable): ProvisionalPerson {
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    displayName: r.display_name,
    email: r.email,
    notes: r.notes,
    proposalId: r.proposal_id,
  };
}

export async function createProvisionalPerson(
  db: Kysely<DB>,
  args: { ownerUserId: string; displayName: string; email?: string | null; notes?: string | null },
): Promise<ProvisionalPerson> {
  const row: ProvisionalPeopleTable = {
    // Same prefix as `people` ids: this id becomes people.id on promote.
    id: newId('p'),
    owner_user_id: args.ownerUserId,
    display_name: args.displayName.trim(),
    email: args.email?.trim().toLowerCase() || null,
    notes: args.notes?.trim() || null,
    proposal_id: null,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('provisional_people').values(row).execute();
  return rowToProvisional(row);
}

/** Email first, then exact name — the same rule `findPersonByEmail`/`findPersonByName` apply. */
export async function findProvisionalPerson(
  db: Kysely<DB>,
  ownerUserId: string,
  match: { email?: string | null; name: string },
): Promise<ProvisionalPerson | null> {
  const rows = await db
    .selectFrom('provisional_people')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .execute();
  const email = match.email?.trim().toLowerCase();
  const name = match.name.trim().toLowerCase();
  const hit =
    (email ? rows.find((r) => (r.email ?? '').toLowerCase() === email) : undefined) ??
    rows.find((r) => r.display_name.trim().toLowerCase() === name);
  return hit ? rowToProvisional(hit) : null;
}

export async function linkProvisionalToProposal(
  db: Kysely<DB>,
  provisionalId: string,
  proposalId: string,
): Promise<void> {
  await db
    .updateTable('provisional_people')
    .set({ proposal_id: proposalId })
    .where('id', '=', provisionalId)
    .execute();
}

/** Proposed facts attached to provisional people, for the confirm card's detail line. */
export async function provisionalFactsFor(
  db: Kysely<DB>,
  ids: string[],
): Promise<Map<string, Array<{ key: string; value: string }>>> {
  const out = new Map<string, Array<{ key: string; value: string }>>();
  if (ids.length === 0) return out;
  const rows = await db
    .selectFrom('memories')
    .select(['subject_id', 'key', 'value'])
    .where('subject_type', '=', 'person')
    .where('subject_id', 'in', ids)
    .where('status', '=', 'proposed')
    .where('superseded_by', 'is', null)
    .orderBy('created_at', 'asc')
    .execute();
  for (const r of rows) {
    const list = out.get(r.subject_id!) ?? [];
    list.push({ key: r.key, value: r.value });
    out.set(r.subject_id!, list);
  }
  return out;
}

/**
 * The user tapped the card: make the person real. Runs inside the caller's
 * commit transaction. Normally the provisional id simply becomes `people.id`,
 * so attached facts and the edge need no re-point. If a real person already
 * exists by the time of the tap (a race, or a duplicate mention), the facts
 * and edge move onto that person instead of being dropped.
 */
export async function promoteProvisionalPerson(
  db: Kysely<DB>,
  ownerUserId: string,
  provisionalId: string,
  provenance: string | null = null,
): Promise<{ person: Person; merged: boolean } | null> {
  const row = await db
    .selectFrom('provisional_people')
    .selectAll()
    .where('id', '=', provisionalId)
    .where('owner_user_id', '=', ownerUserId)
    .executeTakeFirst();
  if (!row) return null;

  const facts = await db
    .selectFrom('memories')
    .selectAll()
    .where('subject_type', '=', 'person')
    .where('subject_id', '=', provisionalId)
    .where('status', '=', 'proposed')
    .where('superseded_by', 'is', null)
    .execute();

  const existing =
    (row.email ? await findPersonByEmail(db, ownerUserId, row.email) : null) ??
    (await findPersonByName(db, ownerUserId, row.display_name));

  let person: Person;
  const merged = existing !== null;
  if (existing) {
    person = existing;
    if (row.email && !existing.email) {
      await db
        .updateTable('people')
        .set({ email: row.email, updated_at: new Date().toISOString() })
        .where('id', '=', existing.id)
        .execute();
    }
    for (const f of facts) {
      await upsertMemory(db, {
        groupId: f.group_id,
        scope: f.scope,
        key: f.key,
        value: f.value,
        source: f.source,
        confidence: f.confidence,
        status: 'confirmed',
        subjectType: 'person',
        subjectId: existing.id,
        category: f.category,
        provenance: f.provenance,
        datedAt: f.dated_at,
      });
      await db.deleteFrom('memories').where('id', '=', f.id).execute();
    }
  } else {
    person = await createPerson(db, {
      id: row.id,
      ownerUserId,
      displayName: row.display_name,
      notes: row.notes,
      email: row.email,
      provenance,
    });
    for (const f of facts) await confirmMemory(db, f.id);
  }

  const edges = await db
    .selectFrom('person_relationships')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .where('related_type', '=', 'person')
    .where('related_id', '=', provisionalId)
    .execute();
  for (const e of edges) {
    if (!merged) {
      await db.updateTable('person_relationships').set({ status: 'confirmed' }).where('id', '=', e.id).execute();
      continue;
    }
    const dupe = await db
      .selectFrom('person_relationships')
      .select('id')
      .where('owner_user_id', '=', ownerUserId)
      .where('subject_type', '=', e.subject_type)
      .where('subject_id', '=', e.subject_id)
      .where('related_type', '=', 'person')
      .where('related_id', '=', existing!.id)
      .where('relation', '=', e.relation)
      .executeTakeFirst();
    if (dupe) {
      await db.deleteFrom('person_relationships').where('id', '=', e.id).execute();
      await db.updateTable('person_relationships').set({ status: 'confirmed' }).where('id', '=', dupe.id).execute();
    } else {
      await db
        .updateTable('person_relationships')
        .set({ related_id: existing!.id, status: 'confirmed' })
        .where('id', '=', e.id)
        .execute();
    }
  }

  await db.deleteFrom('provisional_people').where('id', '=', provisionalId).execute();
  return { person, merged };
}

/** The proposal ended without a tap: drop the provisional person and everything attached to it. */
export async function discardProvisionalPerson(db: Kysely<DB>, provisionalId: string): Promise<void> {
  await db
    .deleteFrom('memories')
    .where('subject_type', '=', 'person')
    .where('subject_id', '=', provisionalId)
    .where('status', '=', 'proposed')
    .execute();
  await db
    .deleteFrom('person_relationships')
    .where('related_type', '=', 'person')
    .where('related_id', '=', provisionalId)
    .where('status', '=', 'proposed')
    .execute();
  await db.deleteFrom('provisional_people').where('id', '=', provisionalId).execute();
}

/**
 * A pending add_person can end by reject, by expiry (72h), or by its source
 * email being deleted; all three just flip `proposals.status`, so one sweep
 * keyed on "the proposal is no longer pending" covers them. A row whose
 * proposal was never linked is only swept after a grace period, so a sweeper
 * on another process can't take a row mid-creation.
 */
export async function sweepOrphanProvisionalPeople(db: Kysely<DB>): Promise<number> {
  const graceCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const orphans = await db
    .selectFrom('provisional_people as pp')
    .leftJoin('proposals as pr', 'pr.id', 'pp.proposal_id')
    .select('pp.id as id')
    .where((eb) =>
      eb.or([
        eb.and([
          eb('pp.proposal_id', 'is not', null),
          eb.or([eb('pr.id', 'is', null), eb('pr.status', '!=', 'pending')]),
        ]),
        eb.and([eb('pp.proposal_id', 'is', null), eb('pp.created_at', '<', graceCutoff)]),
      ]),
    )
    .execute();
  for (const o of orphans) await discardProvisionalPerson(db, o.id);
  return orphans.length;
}
