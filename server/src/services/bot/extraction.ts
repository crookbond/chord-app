import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Memory, Message, Persona } from '@chord/kernel';
import { categoryForKey, SSE } from '@chord/kernel';

import { logger } from '../../config/logging.js';
import { parseJsonArray } from '../../utils/json-repair.js';
import type { DB } from '../../db/schema.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { getLlmForUser } from '../llm/factory.js';
import type { LlmMessage } from '../llm/types.js';
import { queueAiWork } from '../ai-backlog.service.js';
import { canUseAi, isAiRefusal } from '../llm/refusal.js';
import { queryForTurn, writeMemory } from '../memory.service.js';
import {
  attachMemoryNotices,
  broadcastFact,
  labelMemorySubjects,
  memoryCards,
  postPersonalMemoryNotice,
} from '../memory-notices.service.js';
import { listPeopleForUser, type PersonWithDates } from '../people.service.js';
import { listPersonas } from '../personas.service.js';
import { factSubjectCandidates, resolveFactSubject } from '../fact-subject.js';

/**
 * Well-known keys extracted with consistent naming. Listed in the prompt as
 * examples; the LLM may freely invent additional snake_case keys for anything
 * else durable.
 */
const WELL_KNOWN = [
  { key: 'allergy',              scope: 'persona', desc: 'a specific food or substance the person is allergic to' },
  { key: 'dietary_preference',   scope: 'persona', desc: 'vegan, vegetarian, kosher, halal, pescatarian, etc.' },
  { key: 'regular_meals',        scope: 'persona', desc: 'meals/dishes the person eats almost every day or most weeknights — comma-separated (e.g. "rice, daal, subzi, khichdi"). Used when answering "what should we have for dinner".' },
  { key: 'favorite_cuisine',     scope: 'persona', desc: 'cuisines the person/family enjoys — comma-separated (e.g. "italian, thai, indian"). Used to cluster restaurant picks.' },
  { key: 'home_airport',         scope: 'persona', desc: "person's home airport (IATA code or city)" },
  { key: 'kid_school',           scope: 'persona', desc: "name of a school one of the person's children attends" },
  { key: 'global_entry_number',  scope: 'persona', desc: 'Global Entry / TSA PreCheck / Known Traveler number' },
  { key: 'phone_number',         scope: 'persona', desc: "person's phone number" },
  { key: 'home_address',         scope: 'group',   desc: "group/family's street address" },
  { key: 'pet',                  scope: 'group',   desc: 'a family pet — include name and species if known' },
  { key: 'insurance_provider',   scope: 'group',   desc: 'health-insurance provider/company shared by the family (e.g. "Aetna PPO", "Blue Cross Blue Shield")' },
  { key: 'insurance_member_id',  scope: 'group',   desc: "primary subscriber's member/policy ID (numeric or alphanumeric)" },
  { key: 'insurance_group',      scope: 'group',   desc: 'employer/group number for the insurance plan' },
  { key: 'insurance_subscriber', scope: 'group',   desc: 'name of the primary insurance subscriber (typically a parent)' },
] as const;

// Snake-case key: starts with a letter, only lowercase letters/digits/underscores, max 60 chars.
const snakeCaseKey = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, 'key must be snake_case');

const ExtractionRow = z.object({
  key: snakeCaseKey,
  value: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1),
  scope: z.enum(['persona', 'group']),
  // "self" = triggering user; any other string = the username of the person the fact is about
  subject: z.string().min(1).max(80),
});
const ExtractionResponse = z.array(ExtractionRow).max(20);

const MIN_CONFIDENCE = 0.6;

interface GroupMember {
  userId: string;
  username: string;
  displayName: string | null;
}

async function fetchGroupMembers(db: Kysely<DB>, groupId: string): Promise<GroupMember[]> {
  const rows = await db
    .selectFrom('group_members')
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .where('group_members.group_id', '=', groupId)
    .select(['users.id as userId', 'users.username', 'users.display_name as displayName'])
    .execute();
  return rows.map((r) => ({ userId: r.userId, username: r.username, displayName: r.displayName }));
}

type ResolvedSubject =
  | { kind: 'user'; id: string }
  | { kind: 'persona'; id: string }
  | { kind: 'person'; id: string }
  | null;

/**
 * Resolve a named subject to a group member (a user), a managed persona on
 * the family roster (a kid, a grandparent), or — docs/notes/0189 — the
 * sender's own private `people` contact, through the one rule every fact
 * writer shares (ADR 0333, `resolveFactSubject`): an exact name, else a
 * first name that only one person has. `null` when nobody or several people
 * match — the caller then saves nothing. Exported for unit testing — pure,
 * no DB access itself (its callers prefetch `members`/`personas`/`people`).
 */
export function resolveSubject(
  subject: string,
  senderId: string,
  members: GroupMember[],
  personas: Persona[],
  people: PersonWithDates[],
): ResolvedSubject {
  if (subject.toLowerCase().trim() === 'self') return { kind: 'user', id: senderId };
  const r = resolveFactSubject(subject, factSubjectCandidates({ members, personas, people }));
  return r.kind === 'one' ? { kind: r.subject.kind, id: r.subject.id } : null;
}

function wellKnownList(): string {
  return WELL_KNOWN.map((w) => `  - ${w.key} (${w.scope}) — ${w.desc}`).join('\n');
}

function buildExtractionPrompt(opts: {
  triggerUserName: string;
  triggerBody: string;
  botReply: string;
  groupMembers: GroupMember[];
  /** ADR 0333 — the roster and the sender's saved people, by name. */
  otherPeople: string[];
  /** ADR 0281 — facts already held, as "key = value" lines. */
  known?: string[];
}): LlmMessage[] {
  const roster = opts.groupMembers
    .map((m) => (m.displayName ? `${m.username} (${m.displayName})` : m.username))
    .join(', ');

  const system = [
    'You build a personal knowledge and preference graph by extracting durable personal facts from chat.',
    'A fact is durable if it will still be true in a year: allergies, home city, dietary needs, skills.',
    'Return only those facts as a JSON array.',
    '',
    'Well-known keys (use these when they fit):',
    wellKnownList(),
    '',
    'For anything else, invent a concise snake_case key. Examples:',
    '  sport_fan, cricket_fan, music_genre, favorite_team, car_model,',
    '  speaks_language, night_owl, skill_programming, relationship_to_sender, birthday_month',
    '',
    `Group members: ${roster}`,
    ...(opts.otherPeople.length > 0 ? [`Family and saved people: ${opts.otherPeople.join(', ')}`] : []),
    '',
    'DO NOT extract:',
    '  - Trip-specific data: flight numbers, hotel names, confirmation codes, itinerary fees,',
    '    unaccompanied minor fees, baggage fees, or any one-trip cost or detail.',
    '  - Task or reminder details, event RSVPs, shopping list items.',
    '  - Anything that only applies to a single booking or transaction.',
    'If the conversation is only about a trip or task, return [].',
    '',
    'Scope rules:',
    '  - "persona" — fact is about a specific person (a member, a family member or a saved person)',
    '  - "group"   — fact is about the group or family as a whole',
    '',
    'Subject rules:',
    '  - Set "subject" to "self" if the fact is about the triggering user.',
    '  - Set "subject" to that person\'s name exactly as listed above if about someone else',
    "    (a member's username, or a family or saved person's name). A fact about a person",
    '    is NEVER "self" or "group" just because the person is not listed: use their name.',
    '  - Set "subject" to "group" for group-scoped facts.',
    '',
    'Confidence: 0.9 = directly stated, 0.7 = strongly implied, 0.6 = minimum threshold.',
    'Only emit facts that are durable and clearly present. If nothing qualifies, return [].',
    ...(opts.known && opts.known.length > 0
      ? [
          '',
          'Already known (do NOT emit these again unless the user says something different;',
          'when the user changes or corrects one, emit it with the SAME key and the new value):',
          ...opts.known.map((k) => `  - ${k}`),
        ]
      : []),
    '',
    'Output ONLY a JSON array — no prose, no markdown fences.',
    'Schema: [{ "key": string, "value": string, "confidence": number, "scope": "persona"|"group", "subject": string }]',
  ].join('\n');

  const user = [
    `Triggering user: ${opts.triggerUserName}`,
    '',
    'User said:',
    opts.triggerBody,
    '',
    opts.botReply.trim()
      ? `Assistant replied:\n${opts.botReply}`
      : '(No assistant reply — the bot is in passive listening mode. Extract durable facts from the user message alone, if any.)',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Fire-and-forget: run an extraction LLM call on the just-completed turn and
 * persist any high-confidence facts. Swallows errors — extraction is best-effort.
 */
export async function extractMemoriesFromTurn(
  db: Kysely<DB>,
  opts: {
    triggerMsg: Message;
    triggerUserName: string;
    /** Empty string is allowed — passive mode (PR-D.2 / ADR 0018) calls
     *  this with no bot reply so we extract from the user message alone. */
    botReply: string;
    group: { id: string; kind: 'group' | 'personal' };
    /**
     * ADR 0281 — where to say what was learned. A message id = the bot reply
     * of this turn, visible in Chord: the cards go under it. `null` = no
     * visible reply (passive listening, a silent bridge turn): the cards go to
     * the sayer's personal chat. Omitted = no notice (callers that predate it).
     */
    noticeMessageId?: string | null;
  },
): Promise<Memory[]> {
  if (!opts.triggerMsg.senderId) return [];
  if (!opts.triggerMsg.body.trim() && !opts.botReply.trim()) return [];
  const senderId = opts.triggerMsg.senderId;
  // ADR 0283 / 0079 / 0325 — nothing goes to a model without the sayer's
  // consent and allowance. Passive listening reaches here with no turn, and the
  // after-reply pass can follow a turn that spent the last tokens. Skipped work
  // is held back, never dropped: it runs once both are met (ai-backlog).
  if (!(await canUseAi(db, senderId))) {
    await queueAiWork(db, { userId: senderId, kind: 'memory_message', ref: opts.triggerMsg.id });
    return [];
  }

  const [llm, members, personas, people, personalGroup, known] = await Promise.all([
    getLlmForUser(db, senderId, 'memory_extract'),
    fetchGroupMembers(db, opts.group.id),
    opts.group.kind === 'group' ? listPersonas(db, opts.group.id) : Promise.resolve([]),
    listPeopleForUser(db, senderId),
    ensurePersonalGroup(db, senderId),
    queryForTurn(db, { groupId: opts.group.id, triggeringUserId: senderId, limit: 200 }),
  ]);
  const knownLabels = await labelMemorySubjects(db, known);

  let raw: string;
  try {
    raw = await llm.complete(
      buildExtractionPrompt({
        triggerUserName: opts.triggerUserName,
        triggerBody: opts.triggerMsg.body,
        botReply: opts.botReply,
        groupMembers: members,
        otherPeople: [
          ...personas.filter((p) => p.isManaged).map((p) => p.name),
          ...people.map((p) => p.displayName),
        ].slice(0, 60),
        known: known.map((m) => `${knownLabels.get(m.id) ?? 'Someone'} · ${m.key} = ${m.value.slice(0, 120)}`),
      }),
      { maxTokens: 600, temperature: 0 },
    );
  } catch (err) {
    if (isAiRefusal(err)) {
      // Refused before anything was sent (the allowance ran out since the
      // check above): hold it back like the gate does.
      await queueAiWork(db, { userId: senderId, kind: 'memory_message', ref: opts.triggerMsg.id });
      return [];
    }
    logger.warn('memory extraction: llm call failed', { err });
    return [];
  }

  const parsed = parseJsonArray(raw);
  if (!parsed) return [];

  const rows = ExtractionResponse.safeParse(parsed);
  if (!rows.success) {
    logger.warn('memory extraction: invalid JSON shape', { issues: rows.error.issues });
    return [];
  }

  const learned: Memory[] = [];
  for (const r of rows.data) {
    if (r.confidence < MIN_CONFIDENCE) continue;

    let personaId: string | null = null;
    let scope = r.scope;
    // Family-profile subject identity (Phase 2). Derived from the resolution
    // below; a household fact and an unresolved persona fact both land as
    // 'household', matching the pre-Phase-2 group-scoped fallback.
    let subjectType: 'user' | 'persona' | 'household' | 'person' = 'household';
    let subjectId: string | null = null;
    // docs/notes/0189 — a 'person' subject writes to the sender's PERSONAL
    // group, never the shared group the chat happened in: a private
    // contact's facts are the sender's own, same privacy line
    // `family-profile.service.ts` already draws around `people`.
    let targetGroupId = opts.group.id;

    if (scope === 'persona') {
      const resolved = resolveSubject(r.subject, opts.triggerMsg.senderId, members, personas, people);
      if (resolved?.kind === 'user') {
        personaId = resolved.id;
        subjectType = 'user';
        subjectId = resolved.id;
      } else if (resolved?.kind === 'persona') {
        // A fact about a managed roster member (a kid). `memories.persona_id`
        // is a users FK, so the personas.id lives only in `subject_id`; the
        // legacy columns stay a valid group-scoped combination.
        scope = 'group';
        personaId = null;
        subjectType = 'persona';
        subjectId = resolved.id;
      } else if (resolved?.kind === 'person') {
        scope = 'group';
        personaId = null;
        subjectType = 'person';
        subjectId = resolved.id;
        targetGroupId = personalGroup.id;
      } else if (r.subject.trim().toLowerCase() === 'group') {
        scope = 'group';
      } else {
        // ADR 0333 — a fact about a person we cannot place (nobody, or
        // several people, has that name) is not saved. Filing it under the
        // whole family let a second child's number replace the first's.
        logger.warn(`memory extraction: unresolved subject for key ${r.key}, not saved`);
        continue;
      }
    } else if (scope === 'group') {
      subjectType = 'household';
    }

    try {
      const { memory, created } = await writeMemory(db, {
        groupId: targetGroupId,
        personaId,
        scope,
        key: r.key,
        value: r.value,
        source: 'passive',
        confidence: r.confidence,
        status: 'proposed',
        subjectType,
        subjectId,
        category: categoryForKey(r.key),
      });
      if (!created) continue;
      learned.push(memory);
      broadcastFact(SSE.memoryProposed, memory);
      logger.info(
        `memory proposed: ${r.key} -> ${subjectType}:${subjectId ?? '-'} (${r.confidence})`,
      );
    } catch (err) {
      logger.warn('memory upsert failed', { err, key: r.key });
    }
  }

  if (learned.length > 0 && opts.noticeMessageId !== undefined) {
    try {
      const cards = await memoryCards(db, learned, senderId);
      if (opts.noticeMessageId) {
        await attachMemoryNotices(db, { messageId: opts.noticeMessageId, groupId: opts.group.id, cards });
      } else {
        const fromGroupName =
          opts.group.kind === 'personal'
            ? null
            : ((
                await db.selectFrom('groups').select('name').where('id', '=', opts.group.id).executeTakeFirst()
              )?.name ?? 'a chat');
        await postPersonalMemoryNotice(db, { userId: senderId, fromGroupName, cards });
      }
    } catch (err) {
      logger.warn('memory notice failed', { err });
    }
  }
  return learned;
}
