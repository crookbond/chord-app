/**
 * ADR 0076 — learn people + family facts from the Gmail mirror. Modeled on
 * magics.service.ts: bounded per-sync batch, injectable extractor seam,
 * once-ever `person_processed_at` marker, per-thread failure never aborts
 * the batch.
 *
 * Two sinks, both existing consent surfaces:
 *   - structured entities (person + relationship, dated facts) → staged
 *     `add_person` / `add_important_date` proposals (ADR 0009), provenance
 *     `gmail:<threadId>` — confirm writes through the normal tool path.
 *   - soft prompt facts (spouse_name, kid_name, …) → memory proposals in
 *     the personal group, exactly like About-Me extraction.
 * Bootstrap (owner decision 2026-07-18): a user's FIRST pass auto-writes
 * high-confidence facts directly (capped) so the People screen and memories
 * start with critical mass; steady state is proposals-only.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { minablePredicate } from './bulk-gate.js';
import { parseJsonObject } from '../../utils/json-repair.js';
import { bodyForModel, cleanBodyText, cleanSnippet } from '../../utils/email-text.js';
import { toolSchemas } from '../bot/tools.js';
import {
  consolidateDuplicateDateProposals,
  consolidateDuplicatePersonProposals,
  importantDateKey,
  withEmailStagingLocks,
} from '../event-convergence.service.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { getLlmForUser } from '../llm/factory.js';
import { isAiRefusal } from '../llm/refusal.js';
import { upsertMemory } from '../memory.service.js';
import {
  addImportantDate,
  addPersonRelationship,
  createPerson,
  createProvisionalPerson,
  findPersonByEmail,
  findPersonByName,
  findProvisionalPerson,
  linkProvisionalToProposal,
  listPeopleForUser,
  normalizeRelation,
  sweepOrphanProvisionalPeople,
  type ImportantDateKind,
} from '../people.service.js';
import { createProposal } from '../proposals.service.js';
import { hasPendingPersonProposal } from './person-proposal.js';
import { isDangerousSender } from './sender-check/prompt.js';
import { sseHub } from '../sse.hub.js';
import { categoryForKey, SSE } from '@chord/kernel';
import { deterministicPathFor } from './llm-classifier.js';
import { trackPassCost } from './pass-cost.js';
import {
  crossAccountMarkQuery,
  extractionMarkQuery,
  markThreadExtracted,
} from './magics.service.js';

const BATCH_LIMIT = 15;
const BOOTSTRAP_CONFIDENCE = 0.8;
const BOOTSTRAP_PERSON_CAP = 12;
const MIN_CONFIDENCE = 0.6;
/** Most people ONE thread may yield. The bootstrap cap above bounds a whole
 *  pass and only guards auto-writes, so the propose path was unbounded: an
 *  announcement listing every teacher became that many Action Items rows from
 *  a single email. Family mail names a handful; more than this is a bulletin. */
const THREAD_PERSON_CAP = 5;

/** Senders that are automation, not people. Exported so the dogfood script
 *  (`scripts/dogfood-persons.ts`) classifies skipped threads the same way. */
export const NOREPLY_RE = /no-?reply|donotreply|notifications?@|mailer-daemon|postmaster/i;

const FACT_KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
/** Booking/account identifiers describe a trip or an account, not a person, and
 *  are sensitive. The prompt asks the model not to emit them; this is the backstop. */
const IDENTIFIER_KEY_RE =
  /(?:^|_)(?:ticket|booking|confirmation|reservation|pnr|ffn|frequent_flyer|loyalty)(?:_|$)|(?:^|_)account_(?:number|no|num|id)(?:_|$)/;
const MAX_FACTS_PER_PERSON = 8;
const MAX_FACT_VALUE_CHARS = 200;

/**
 * Facts come out of untrusted email text and land in memory, so bound them:
 * snake_case keys only (anything else is dropped, not repaired into something
 * misleading), clipped values, no repeats, and a per-person cap.
 */
export function sanitizeFacts(
  facts: Array<{ key: string; value: string }> | undefined,
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  for (const f of facts ?? []) {
    const key = f.key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const value = f.value.trim().slice(0, MAX_FACT_VALUE_CHARS);
    if (!FACT_KEY_RE.test(key) || IDENTIFIER_KEY_RE.test(key) || !value) continue;
    const dedupe = JSON.stringify([key, value]);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ key, value });
    if (out.length >= MAX_FACTS_PER_PERSON) break;
  }
  return out;
}

export interface ExtractedDate {
  kind: ImportantDateKind;
  /** YYYY-MM-DD; 0000-MM-DD when the year is unknown (recurs). */
  date: string;
}

export interface ExtractedPerson {
  name: string;
  relationship?: string;
  email?: string;
  confidence: number;
  dates?: ExtractedDate[];
  facts?: Array<{ key: string; value: string }>;
}

export interface PersonThreadInput {
  subject: string;
  snippet: string;
  bodyText: string | null;
  fromName: string | null;
  fromEmail: string | null;
  toEmails: string[];
  userName: string | null;
  userEmail: string | null;
  knownPeople: string[];
  /**
   * docs/notes/0189 — already-extracted attachment text/summary for this
   * thread (ADR 0071's `attachments.summary`/`extracted_text`, joined via
   * `origin_email_thread_id`). Reused, never re-derived: a permission slip
   * photo or a PDF itinerary is just more text in the same prompt, no second
   * LLM call and no new extraction mark (ADR 0110's precedent for body text).
   */
  attachmentText: string | null;
  /** ADR 0193 — present only when the caller wants this call's tokens
   *  recorded to the per-user usage counter. Optional so no existing test
   *  double constructing a `PersonThreadInput` needs to change. */
  userId?: string;
  db?: Kysely<DB>;
}

export interface PersonExtractor {
  extract(input: PersonThreadInput): Promise<ExtractedPerson[]>;
}

const EXTRACT_SYSTEM = `You build a household knowledge graph from ONE email. Extract people who matter PERSONALLY to the user (family, friends, kids, their teachers/coaches/doctors) — never businesses, brands, or mailing-list senders. Reply with STRICT JSON only:

{"persons":[{"name":"...","relationship":"spouse|partner|kid|parent|sibling|friend|teacher|coach|doctor|other (optional)","email":"... (optional)","confidence":0.0-1.0,"dates":[{"kind":"birthday|anniversary","date":"YYYY-MM-DD or 0000-MM-DD when the year is unknown"}],"facts":[{"key":"role|organization|subject|phone|allergy|hobby|kid_school|...","value":"..."}]}]}

Rules:
- Only durable facts (still true in a year). No transient plans.
- When the email states the person's organization (a school, employer or club) in a signature or letterhead, include it as {"key":"organization","value":"..."}. Only when stated; never guess it from the email domain alone.
- Facts describe the PERSON (role, organization, subject, allergy, dietary need, hobby, phone). Never record identifiers that belong to a booking or account: ticket, booking, confirmation or reservation numbers, frequent-flyer or loyalty numbers, account numbers. Those live with the trip, not the person.
- The relationship is TO THE USER. Use the exact enum word when one fits.
- confidence: 0.9 = directly stated ("my wife Alice"), 0.7 = strongly implied, 0.6 = minimum worth reporting.
- Dates only when the email states them ("Aarav turns 8 on May 12" → 0000-05-12 birthday if the year is unknown).
- An empty {"persons":[]} is the correct answer for most email. Output JSON only.`;

/** Production extractor — one LLM call per thread. */
export function llmPersonExtractor(): PersonExtractor {
  return {
    async extract(input) {
      const llm = await getLlmForUser(input.db, input.userId, 'email_persons');
      const user = [
        `User: ${input.userName ?? 'unknown'}${input.userEmail ? ` <${input.userEmail}>` : ''}`,
        input.knownPeople.length
          ? `Already known people (report NEW facts about them, not their existence): ${input.knownPeople.join(', ')}`
          : '',
        `From: ${input.fromName ?? ''} <${input.fromEmail ?? ''}>`,
        input.toEmails.length ? `To: ${input.toEmails.join(', ')}` : '',
        `Subject: ${cleanSnippet(input.subject)}`,
        `Preview: ${cleanSnippet(input.snippet)}`,
        input.bodyText ? `Body: ${cleanBodyText(input.bodyText).slice(0, 2000)}` : '',
        input.attachmentText ? `Attachment: ${cleanBodyText(input.attachmentText).slice(0, 2000)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const cost = trackPassCost();
      const startedAt = Date.now();
      const raw = await llm.complete(
        [
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: user },
        ],
        { temperature: 0, maxTokens: 600, onUsage: cost.onUsage },
      );
      cost.report({
        pass: 'persons',
        threads: 1,
        model: llm.defaultModel,
        ms: Date.now() - startedAt,
        userId: input.userId,
      });
      return parsePersonExtraction(raw);
    },
  };
}

/** Narrow a model reply to well-formed persons; drop everything else. */
export function parsePersonExtraction(raw: string): ExtractedPerson[] {
  const obj = parseJsonObject(raw) as { persons?: unknown } | null;
  if (!obj || !Array.isArray(obj.persons)) return [];
  const out: ExtractedPerson[] = [];
  for (const p of obj.persons) {
    const r = p as Record<string, unknown>;
    if (typeof r.name !== 'string' || !r.name.trim()) continue;
    const confidence = typeof r.confidence === 'number' ? r.confidence : 0;
    if (confidence < MIN_CONFIDENCE) continue;
    const dates: ExtractedDate[] = [];
    if (Array.isArray(r.dates)) {
      for (const d of r.dates) {
        const dd = d as Record<string, unknown>;
        if (
          (dd.kind === 'birthday' || dd.kind === 'anniversary') &&
          typeof dd.date === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(dd.date)
        ) {
          dates.push({ kind: dd.kind, date: dd.date });
        }
      }
    }
    const facts: Array<{ key: string; value: string }> = [];
    if (Array.isArray(r.facts)) {
      for (const f of r.facts) {
        const ff = f as Record<string, unknown>;
        if (typeof ff.key === 'string' && ff.key.trim() && typeof ff.value === 'string' && ff.value.trim()) {
          facts.push({ key: ff.key.trim(), value: ff.value.trim() });
        }
      }
    }
    out.push({
      name: r.name.trim().slice(0, 100),
      relationship: typeof r.relationship === 'string' ? r.relationship.trim().toLowerCase() : undefined,
      email: typeof r.email === 'string' && r.email.includes('@') ? r.email.trim().toLowerCase() : undefined,
      confidence,
      ...(dates.length ? { dates } : {}),
      ...(facts.length ? { facts } : {}),
    });
  }
  return out;
}

/** Relationship → the memory key vocabulary extraction.ts already uses. */
const RELATION_MEMORY_KEY: Record<string, string> = {
  spouse: 'spouse_name',
  wife: 'spouse_name',
  husband: 'spouse_name',
  partner: 'partner_name',
  kid: 'kid_name',
  child: 'kid_name',
  son: 'kid_name',
  daughter: 'kid_name',
  parent: 'parent_name',
  mother: 'parent_name',
  father: 'parent_name',
  sibling: 'sibling_name',
  brother: 'sibling_name',
  sister: 'sibling_name',
  friend: 'friend_name',
};

/**
 * ADR 0333 — relations a person can have several of. Their fact holds every
 * name ("Ben, Nolan"): one value per key meant a second child's name
 * replaced the first.
 */
const MANY_PEOPLE_KEYS = new Set(['kid_name', 'parent_name', 'sibling_name', 'friend_name']);

/**
 * `existing` plus `name`, once each, in the order learned. A short form of a
 * name already listed is the same person ("Ben" with "Ben Doe"), and a
 * fuller form replaces the short one in place. Two names that differ in a
 * word ("Ben Doe", "Ben Rao") are two people and both stay.
 */
export function addToNameList(existing: string | null | undefined, name: string): string {
  const names = (existing ?? '')
    .split(/\s*(?:,|;|\band\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
  const wordsOf = (n: string) => n.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const within = (a: string[], b: string[]) => a.length > 0 && a.every((w) => b.includes(w));
  const added = name.trim();
  const addedWords = wordsOf(added);
  if (addedWords.length === 0) return names.join(', ');
  for (let i = 0; i < names.length; i++) {
    const have = wordsOf(names[i]);
    if (within(addedWords, have)) return names.join(', ');
    if (within(have, addedWords)) {
      names[i] = added;
      return [...new Set(names)].join(', ');
    }
  }
  names.push(added);
  return names.join(', ');
}

// ADR 0158 — moved to `person-proposal.ts` (breaks a would-be import cycle);
// re-exported so existing importers of `person-extraction.js` keep working.
export { stagePersonProposal } from './person-proposal.js';

export interface PersonExtractionResult {
  processed: number;
  personProposals: number;
  dateProposals: number;
  memoryProposals: number;
  bootstrapped: number;
}

/**
 * Bootstrap detection: this user's very first pass — no people yet and no
 * email-derived person proposals staged before.
 */
async function isBootstrapPass(db: Kysely<DB>, userId: string): Promise<boolean> {
  const person = await db
    .selectFrom('people')
    .select('id')
    .where('owner_user_id', '=', userId)
    .limit(1)
    .executeTakeFirst();
  if (person) return false;
  const prior = await db
    .selectFrom('proposals')
    .select('id')
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', 'in', ['add_person', 'add_important_date'])
    .where('provenance', 'like', 'gmail:%')
    .limit(1)
    .executeTakeFirst();
  return !prior;
}

export async function runPersonExtraction(
  db: Kysely<DB>,
  userId: string,
  opts: { extractor?: PersonExtractor; limit?: number } = {},
): Promise<PersonExtractionResult> {
  const extractor = opts.extractor ?? llmPersonExtractor();
  const limit = Math.min(Math.max(opts.limit ?? BATCH_LIMIT, 1), 100);
  const personal = await ensurePersonalGroup(db, userId);
  // docs/notes/0191 — a provisional person whose card was rejected, expired or
  // retracted must be gone before this pass looks one up, or its facts would
  // be attached to a person nobody is being asked about any more.
  await sweepOrphanProvisionalPeople(db);
  const me = await db
    .selectFrom('users')
    .select(['display_name', 'email'])
    .where('id', '=', userId)
    .executeTakeFirst();

  const threads = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id as gid', 'subject', 'snippet', 'from_name', 'from_email'])
    .where('user_id', '=', userId)
    .where((eb) => eb.not(eb.exists(extractionMarkQuery(eb, userId, 'person'))))
    // ...nor under another mailbox's copy of the same message (bug 12).
    .where((eb) => eb.not(eb.exists(crossAccountMarkQuery(eb, userId, 'person'))))
    .where('is_archived', '=', 0)
    // ADR 0127. NOREPLY_RE below stays: the regex asks whether a human wrote
    // this, the gate asks whether it went to a list — different axes, and
    // ADR 0109 says so explicitly.
    .where(minablePredicate(userId))
    .orderBy('last_message_at', 'desc')
    .limit(limit)
    .execute();

  const now = new Date().toISOString();
  const result: PersonExtractionResult = {
    processed: 0,
    personProposals: 0,
    dateProposals: 0,
    memoryProposals: 0,
    bootstrapped: 0,
  };
  if (threads.length === 0) return sweepDuplicates(db, userId, result);

  let bootstrap = await isBootstrapPass(db, userId);
  let bootstrapWrites = 0;
  const knownPeople = (await listPeopleForUser(db, userId)).map((p) => p.displayName);

  for (const t of threads) {
    result.processed += 1;
    try {
      // All non-bulk mail (owner decision): skip bulk-domain + automation
      // senders without spending an LLM call.
      if (deterministicPathFor(t.from_email) !== null || NOREPLY_RE.test(t.from_email ?? '')) {
        continue;
      }
      // ADR 0294 addendum — a sender impersonating someone is not a person to
      // learn about, and nothing it says about the family is a fact.
      if (await isDangerousSender(db, userId, t.id)) continue;
      const msg = await db
        .selectFrom('email_messages')
        .select(['body_text', 'body_html', 'body_excerpt', 'to_emails'])
        .where('thread_id', '=', t.id)
        .where((eb) =>
          eb.or([eb('body_text', 'is not', null), eb('body_html', 'is not', null), eb('body_excerpt', 'is not', null)]),
        )
        .orderBy('internal_date', 'desc')
        .limit(1)
        .executeTakeFirst();
      // docs/notes/0189 — ADR 0071 already imports this thread's Gmail
      // attachments and extracts their text/summary once, at index time;
      // reuse it rather than re-deriving anything. Sync order already
      // guarantees it's populated before this pass runs (gmail.service.ts).
      const attachmentRows = await db
        .selectFrom('attachments')
        .select(['summary', 'extracted_text'])
        .where('origin_email_thread_id', '=', t.id)
        .where('blob_missing_at', 'is', null)
        .execute();
      const attachmentText =
        attachmentRows
          .map((a) => a.extracted_text || a.summary || '')
          .filter(Boolean)
          .join('\n')
          .trim() || null;
      const persons = await extractor.extract({
        subject: t.subject,
        snippet: t.snippet,
        bodyText: msg ? bodyForModel({ html: msg.body_html, text: msg.body_text, excerpt: msg.body_excerpt }) || null : null,
        fromName: t.from_name,
        fromEmail: t.from_email,
        toEmails: Array.isArray(msg?.to_emails) ? (msg.to_emails as string[]) : [],
        userName: me?.display_name ?? null,
        userEmail: me?.email ?? null,
        knownPeople,
        attachmentText,
        userId,
        db,
      });
      const provenance = `gmail:${t.gid}`;

      if (persons.length > THREAD_PERSON_CAP) {
        logger.info(
          `person extraction: thread ${t.gid} yielded ${persons.length} people, keeping ${THREAD_PERSON_CAP}`,
          { userId },
        );
      }
      for (const p of persons.slice(0, THREAD_PERSON_CAP)) {
        const notes = p.relationship ? `${p.relationship} (from email)` : undefined;

        const autoWrite =
          bootstrap && p.confidence >= BOOTSTRAP_CONFIDENCE && bootstrapWrites < BOOTSTRAP_PERSON_CAP;

        // The id this iteration's attribute facts / relationship edge attach
        // to: a real people.id for a known or bootstrapped person, else (docs/
        // notes/0191) the id of a PROVISIONAL person that lives until the user
        // taps the add_person card. Provisional facts stay proposed and never
        // auto-confirm; the card is the only way they confirm.
        let resolvedPersonId: string | null = null;
        let resolvedIsProvisional = false;
        // Whether this person or date is already known or pending from ANOTHER
        // email is checked and acted on under the thread's and the user's
        // staging lock (ADR 0244 addendum), so two emails naming the same new
        // person, read at once, cannot both create them or both stage a card.
        // After the model call, never across it.
        await withEmailStagingLocks(db, userId, provenance, async (trx) => {
          const known =
            (p.email ? await findPersonByEmail(trx, userId, p.email) : null) ??
            (await findPersonByName(trx, userId, p.name));
          resolvedPersonId = known?.id ?? null;

          if (!known) {
            if (autoWrite) {
              const person = await createPerson(trx, {
                ownerUserId: userId,
                displayName: p.name,
                notes,
                email: p.email,
                provenance,
              });
              resolvedPersonId = person.id;
              for (const d of p.dates ?? []) {
                await addImportantDate(trx, {
                  personId: person.id,
                  kind: d.kind,
                  date: d.date,
                  recurs: d.date.startsWith('0000-') || d.kind === 'birthday',
                });
              }
              bootstrapWrites += 1;
              result.bootstrapped += 1;
              knownPeople.push(p.name);
            } else {
              const args = {
                displayName: p.name,
                ...(notes ? { notes } : {}),
                ...(p.email ? { email: p.email } : {}),
              };
              const pending = await hasPendingPersonProposal(trx, userId, p.name);
              let provisional = await findProvisionalPerson(trx, userId, { email: p.email, name: p.name });
              if (!pending && toolSchemas.add_person.safeParse(args).success) {
                provisional ??= await createProvisionalPerson(trx, {
                  ownerUserId: userId,
                  displayName: p.name,
                  email: p.email,
                  notes,
                });
                const proposal = await createProposal(trx, {
                  groupId: personal.id,
                  proposedByUserId: userId,
                  proposedByMessageId: null,
                  toolName: 'add_person',
                  args: { ...args, provisionalPersonId: provisional.id },
                  provenance,
                });
                await linkProvisionalToProposal(trx, provisional.id, proposal.id);
                result.personProposals += 1;
              }
              if (provisional) {
                resolvedPersonId = provisional.id;
                resolvedIsProvisional = true;
              }
              for (const d of p.dates ?? []) {
                const dateArgs = {
                  personName: p.name,
                  kind: d.kind,
                  date: d.date,
                  recurs: d.date.startsWith('0000-') || d.kind === 'birthday',
                };
                if (await hasPendingDateProposal(trx, userId, dateArgs)) continue;
                if (toolSchemas.add_important_date.safeParse(dateArgs).success) {
                  await createProposal(trx, {
                    groupId: personal.id,
                    proposedByUserId: userId,
                    proposedByMessageId: null,
                    toolName: 'add_important_date',
                    args: dateArgs,
                    provenance,
                  });
                  result.dateProposals += 1;
                }
              }
            }
          } else {
            // Known person: only NEW dates (dedup on kind + month/day).
            const existingDates = await trx
              .selectFrom('important_dates')
              .select(['kind', 'date'])
              .where('person_id', '=', known.id)
              .execute();
            for (const d of p.dates ?? []) {
              const dup = existingDates.some(
                (e) => e.kind === d.kind && e.date.slice(5) === d.date.slice(5),
              );
              if (dup) continue;
              if (autoWrite) {
                await addImportantDate(trx, {
                  personId: known.id,
                  kind: d.kind,
                  date: d.date,
                  recurs: d.date.startsWith('0000-') || d.kind === 'birthday',
                });
                result.bootstrapped += 1;
              } else {
                const dateArgs = {
                  personName: known.displayName,
                  kind: d.kind,
                  date: d.date,
                  recurs: d.date.startsWith('0000-') || d.kind === 'birthday',
                };
                if (await hasPendingDateProposal(trx, userId, dateArgs)) continue;
                if (toolSchemas.add_important_date.safeParse(dateArgs).success) {
                  await createProposal(trx, {
                    groupId: personal.id,
                    proposedByUserId: userId,
                    proposedByMessageId: null,
                    toolName: 'add_important_date',
                    args: dateArgs,
                    provenance,
                  });
                  result.dateProposals += 1;
                }
              }
            }
          }
        });

        // Relationship-vocabulary fact (spouse_name/kid_name/…) describes the
        // ASKER's relationship to this person — that's correctly a fact about
        // the asker, unchanged. docs/notes/0189 adds the structural mirror: a
        // `person_relationships` edge, so the same information is also
        // queryable from the person's own side ("tell me about Alice").
        // Relationship edges are NEVER lighter-barred (always `proposed`
        // unless explicit) regardless of `autoWrite` — an identity/relation
        // claim stays a real consent decision even during bootstrap.
        // Only mapped relationships get a memory fact. An unmapped one ("other",
        // teacher, coach, …) has no asker-side vocabulary key, and inventing one
        // (`other_name = Julia`) stages a fact that says nothing.
        const relKey = p.relationship ? RELATION_MEMORY_KEY[p.relationship] : undefined;
        if (relKey) {
          try {
            let value = p.name;
            if (MANY_PEOPLE_KEYS.has(relKey)) {
              const held = await db
                .selectFrom('memories')
                .select(['value', 'status'])
                .where('group_id', '=', personal.id)
                .where('key', '=', relKey)
                .where('subject_type', '=', 'user')
                .where('subject_id', '=', userId)
                .where('superseded_by', 'is', null)
                .execute();
              const base = held.find((h) => h.status === 'confirmed') ?? held[0];
              value = addToNameList(base?.value, p.name);
            }
            const memory = await upsertMemory(db, {
              groupId: personal.id,
              personaId: userId,
              scope: 'persona',
              key: relKey,
              value,
              source: 'extracted',
              confidence: p.confidence,
              status: autoWrite ? 'confirmed' : 'proposed',
              subjectType: 'user',
              subjectId: userId,
              category: categoryForKey(relKey),
              // ADR 0312 — the mailbox's disconnect removes it.
              provenance,
            });
            if (!autoWrite) sseHub.broadcast(personal.id, SSE.memoryProposed, memory);
            result.memoryProposals += 1;
          } catch (err) {
            logger.warn('person extraction: memory upsert failed', { err, key: relKey });
          }
        }
        // An "other" edge carries no information, so it isn't written either.
        if (p.relationship && resolvedPersonId && normalizeRelation(p.relationship) !== 'other') {
          try {
            await addPersonRelationship(db, {
              ownerUserId: userId,
              subjectType: 'user',
              subjectId: userId,
              relatedType: 'person',
              relatedId: resolvedPersonId,
              relation: p.relationship,
              confidence: p.confidence,
              source: 'extracted',
              provenance,
            });
          } catch (err) {
            logger.warn('person extraction: relationship edge failed', { err, relation: p.relationship });
          }
        }

        // Arbitrary attribute facts (e.g. "loves sushi") describe THIS
        // person, not the asker — docs/notes/0189 fixes the bug where these
        // were force-attached to the asker's own memory row. Only writable
        // once a real people.id exists (see `resolvedPersonId` above).
        if (resolvedPersonId) {
          for (const f of sanitizeFacts(p.facts)) {
            try {
              const memory = await upsertMemory(db, {
                groupId: personal.id,
                scope: 'group',
                key: f.key,
                value: f.value,
                source: 'extracted',
                confidence: p.confidence,
                status: autoWrite ? 'confirmed' : 'proposed',
                subjectType: 'person',
                subjectId: resolvedPersonId,
                category: categoryForKey(f.key),
                provenance,
                // docs/notes/0191 — confirm only via the card's tap.
                ...(resolvedIsProvisional ? { autoConfirm: false } : {}),
              });
              // A provisional person's facts are shown on its card, not
              // broadcast into the live Memory tab.
              if (!autoWrite && !resolvedIsProvisional) {
                sseHub.broadcast(personal.id, SSE.memoryProposed, memory);
              }
              result.memoryProposals += 1;
            } catch (err) {
              logger.warn('person extraction: memory upsert failed', { err, key: f.key });
            }
          }
        }
      }
    } catch (err) {
      // Refused before anything was sent: this thread and the rest wait, unmarked.
      if (isAiRefusal(err)) {
        logger.info('person extraction stopped: model refused', { reason: err.message, userId });
        break;
      }
      logger.warn('person extraction failed for thread', {
        err: (err as Error).message,
        threadId: t.id,
      });
    }
    await markThreadExtracted(db, userId, t.gid, 'person', now);
    // Bootstrap only spans a single pass — later threads in the same batch
    // keep auto-writing until the cap, then everything proposes.
    if (bootstrap && bootstrapWrites >= BOOTSTRAP_PERSON_CAP) bootstrap = false;
  }

  await sweepDuplicates(db, userId, result);

  if (result.personProposals || result.dateProposals || result.memoryProposals || result.bootstrapped) {
    logger.info(
      `person extraction user=${userId} bootstrapped=${result.bootstrapped} persons=${result.personProposals} dates=${result.dateProposals} memories=${result.memoryProposals} processed=${result.processed}`,
    );
  }
  return result;
}

/**
 * Mirror of the magics sweep: heal duplicates that predate the staging-time
 * guards (and any that slip past them when two syncs race). Runs even on a
 * pass with no new threads — the rows it exists to clean up are already
 * sitting in Action Items, and waiting for new mail would never reach a user
 * whose whole mailbox is mined.
 */
async function sweepDuplicates(
  db: Kysely<DB>,
  userId: string,
  result: PersonExtractionResult,
): Promise<PersonExtractionResult> {
  const consolidated =
    (await consolidateDuplicatePersonProposals(db, userId)) +
    (await consolidateDuplicateDateProposals(db, userId));
  if (consolidated) {
    logger.info(`person extraction consolidated ${consolidated} duplicate proposals`, { userId });
  }
  return result;
}

/**
 * Date twin of `hasPendingPersonProposal`. Deliberately NOT folded into that
 * guard: a person already pending from an earlier thread can still be the
 * subject of a genuinely NEW date here, so the dates are screened one by one
 * rather than skipped wholesale with their person.
 */
async function hasPendingDateProposal(
  db: Kysely<DB>,
  userId: string,
  candidate: { personName: string; kind: string; date: string },
): Promise<boolean> {
  const rows = await db
    .selectFrom('proposals')
    .select('args_json')
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', 'add_important_date')
    .where('status', '=', 'pending')
    .execute();
  const wanted = importantDateKey(candidate);
  if (!wanted) return false;
  return rows.some((r) => {
    try {
      return importantDateKey(JSON.parse(r.args_json) as Record<string, unknown>) === wanted;
    } catch {
      return false;
    }
  });
}

