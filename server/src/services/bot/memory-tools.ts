/**
 * ADR 0281 — `correct_memory` / `forget_memory`. Both act only on facts the
 * asker can already see in this chat (`visibleMemoriesForTurn`, the rule
 * `list_memories` uses), so a tool call cannot reach another member's private
 * facts. A fact is named by id (from `list_memories` in the same turn) or by
 * words; every word must appear in its subject, key or value. One match acts,
 * several ask, none says so.
 */
import type { Kysely } from 'kysely';

import { SSE, type BotCard, type Memory } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { isSelfReference } from '../../utils/self-reference.js';
import { wordSet } from '../../utils/whole-words.js';
import { factSubjectCandidates, peopleNamed, resolveFactSubject } from '../fact-subject.js';
import { ensurePersonalGroup } from '../groups.service.js';
import {
  deleteFact,
  rejectMemory,
  visibleMemoriesForTurn,
  writeMemory,
  type UpsertMemoryInput,
} from '../memory.service.js';
import { listPeopleForUser } from '../people.service.js';
import { listPersonas } from '../personas.service.js';
import { broadcastFact, humanKey, labelMemorySubjects, memoryCard, refreshMemoryNotice } from '../memory-notices.service.js';
import { semanticFactMatches } from '../search/fact-semantic.js';
import { fuseRanks } from '../search/semantic.js';
import { sseHub } from '../sse.hub.js';

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'for', 'about', 'what', 'from', 'with', 'our', 'your', 'you',
  'his', 'her', 'their', 'its', 'fact', 'memory', 'remember', 'forget', 'saved', 'thing',
]);

/** Words worth matching: possessive 's dropped, punctuation and short words gone. */
export function matchWords(match: string): string[] {
  return match
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Facts whose subject + key + value contain every word of `match`. */
export function matchMemories(
  rows: Memory[],
  labels: Map<string, string>,
  match: string,
): Memory[] {
  const words = matchWords(match);
  if (words.length === 0) return [];
  return rows.filter((m) => {
    const hay = `${labels.get(m.id) ?? ''} ${humanKey(m.key)} ${m.value}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface MemoryCandidate {
  memoryId: string;
  about: string;
  key: string;
  value: string;
}

export type MemoryTarget =
  | { kind: 'one'; memory: Memory; about: string }
  | { kind: 'ambiguous'; candidates: MemoryCandidate[] }
  /** ADR 0284 — no word match; these are closest by meaning. Never acted on. */
  | { kind: 'suggested'; candidates: MemoryCandidate[] }
  | { kind: 'not_found' };

/** The line a person reads, and what a fact's vector is made from. */
export function factLine(about: string, m: Pick<Memory, 'key' | 'value'>): string {
  return `${about} · ${humanKey(m.key)}: ${m.value}`;
}

const candidate = (m: Memory, labels: Map<string, string>): MemoryCandidate => ({
  memoryId: m.id,
  about: labels.get(m.id) ?? 'Someone',
  key: humanKey(m.key),
  value: m.value,
});

async function resolveTarget(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; memoryId?: string; match?: string },
): Promise<MemoryTarget> {
  const rows = await visibleMemoriesForTurn(db, { groupId: opts.groupId, triggeringUserId: opts.userId });
  // A personal 1:1 also holds the asker's private contacts' facts (written to
  // the personal group, docs/notes/0189); a shared chat sees only its own.
  const labels = await labelMemorySubjects(db, rows);
  let hits: Memory[];
  if (opts.memoryId) hits = rows.filter((m) => m.id === opts.memoryId);
  else if (opts.match) hits = matchMemories(rows, labels, opts.match);
  else hits = [];
  if (hits.length === 1) return { kind: 'one', memory: hits[0], about: labels.get(hits[0].id) ?? 'Someone' };
  if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.slice(0, 8).map((m) => candidate(m, labels)) };
  if (opts.match) {
    const near = await semanticFactMatches(
      db,
      opts.userId,
      rows.map((m) => ({ id: m.id, text: factLine(labels.get(m.id) ?? 'Someone', m) })),
      opts.match,
      { limit: 3 },
    );
    const byId = new Map(rows.map((m) => [m.id, m]));
    const close = near.map((h) => byId.get(h.id)).filter((m): m is Memory => !!m);
    if (close.length > 0) return { kind: 'suggested', candidates: close.map((m) => candidate(m, labels)) };
  }
  return { kind: 'not_found' };
}

export interface MemoryToolResult {
  summary: string;
  data: Record<string, unknown>;
  card?: BotCard;
}

// `updated`/`deleted: false` is what marks the chat's tool pill as declined
// rather than a success (bot.service.ts `declinedOutcome`).
function unresolved(
  target: Exclude<MemoryTarget, { kind: 'one' }>,
  verb: 'correct_memory' | 'forget_memory',
): MemoryToolResult {
  const flag = verb === 'correct_memory' ? { updated: false } : { deleted: false };
  if (target.kind === 'suggested') {
    return {
      summary: `${verb}: no fact uses those words; ${target.candidates.length} may be meant`,
      data: {
        ...flag,
        result: 'suggested',
        candidates: target.candidates,
        instruction:
          'No saved fact uses those words; these are the closest in meaning. Ask "Did you mean …?" naming the fact. ' +
          'Change nothing until the user says yes, then call again with its memoryId, or with match = its about + key. Nothing was changed.',
      },
    };
  }
  if (target.kind === 'ambiguous') {
    return {
      summary: `${verb}: ${target.candidates.length} facts match — ask which one`,
      data: {
        ...flag,
        result: 'ambiguous',
        candidates: target.candidates,
        instruction: 'Several saved facts match. Ask the user which one they mean, then call again with its memoryId. Nothing was changed.',
      },
    };
  }
  return {
    summary: `${verb}: no saved fact matches`,
    data: {
      ...flag,
      result: 'not_found',
      instruction: 'Chord has no saved fact like that in this chat. Say so plainly. Nothing was changed.',
    },
  };
}

export async function correctMemoryForTurn(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; memoryId?: string; match?: string; value: string },
): Promise<MemoryToolResult> {
  const target = await resolveTarget(db, opts);
  if (target.kind !== 'one') return unresolved(target, 'correct_memory');
  const old = target.memory;

  // A proposed fact was never in use; its correction replaces it outright.
  if (old.status === 'proposed') await rejectMemory(db, old.id);
  const { memory, created } = await writeMemory(db, {
    groupId: old.groupId,
    personaId: old.personaId,
    scope: old.scope,
    key: old.key,
    value: opts.value,
    source: 'explicit',
    status: 'confirmed',
    confidence: 1,
    subjectType: old.subjectType,
    subjectId: old.subjectId,
    category: old.category,
    provenance: 'chat_correction',
  });
  if (old.status === 'proposed') {
    sseHub.broadcast(old.groupId, SSE.memoryResolved, { id: old.id, status: 'rejected' });
  } else if (created) {
    sseHub.broadcast(old.groupId, SSE.memoryResolved, { id: old.id, status: 'rejected' });
  }
  if (created) broadcastFact(SSE.memoryCreated, memory);
  await refreshMemoryNotice(db, old.id);

  if (!created) {
    return {
      summary: `correct_memory: ${target.about} ${humanKey(old.key)} was already "${memory.value}"`,
      data: { updated: false, result: 'unchanged', about: target.about, key: humanKey(old.key), value: memory.value },
    };
  }
  return {
    summary: `corrected ${target.about} · ${humanKey(old.key)}: "${old.value}" → "${memory.value}"`,
    data: {
      updated: true,
      result: 'corrected',
      about: target.about,
      key: humanKey(old.key),
      oldValue: old.value,
      newValue: memory.value,
    },
    card: memoryCard(memory, target.about, opts.userId),
  };
}

export async function forgetMemoryForTurn(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; memoryId?: string; match?: string },
): Promise<MemoryToolResult> {
  const target = await resolveTarget(db, opts);
  if (target.kind !== 'one') return unresolved(target, 'forget_memory');
  const m = target.memory;
  if (m.status === 'proposed') await rejectMemory(db, m.id);
  else await deleteFact(db, m.id);
  sseHub.broadcast(m.groupId, SSE.memoryResolved, { id: m.id, status: 'rejected' });
  await refreshMemoryNotice(db, m.id);
  return {
    summary: `forgot ${target.about} · ${humanKey(m.key)}: "${m.value}"`,
    data: { deleted: true, result: 'forgotten', about: target.about, key: humanKey(m.key), value: m.value },
  };
}

/**
 * ADR 0284 — `list_memories` with a `query`: the asker's visible confirmed
 * facts matching by words or by meaning, merged by rank. `matched: false`
 * when nothing matches, with the plain list so the model can still answer.
 */
export async function findMemoriesForTurn(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; query: string; limit: number },
): Promise<{ matched: boolean; memories: Memory[]; labels: Map<string, string> }> {
  const rows = (await visibleMemoriesForTurn(db, { groupId: opts.groupId, triggeringUserId: opts.userId })).filter(
    (m) => m.status === 'confirmed',
  );
  const labels = await labelMemorySubjects(db, rows);
  const byWords = matchMemories(rows, labels, opts.query).map((m) => m.id);
  const byMeaning = (
    await semanticFactMatches(
      db,
      opts.userId,
      rows.map((m) => ({ id: m.id, text: factLine(labels.get(m.id) ?? 'Someone', m) })),
      opts.query,
      { limit: opts.limit },
    )
  ).map((h) => h.id);
  let ranked = fuseRanks([byWords, byMeaning]);
  // ADR 0333 — a question naming a person is answered only from that
  // person's facts (or the household's). A meaning match on someone else's
  // Global Entry number is not an answer about this one's.
  const askedWords = wordSet(opts.query);
  const named = peopleNamed(askedWords, labels.values());
  if (named.size > 0) {
    const forNamed = (id: string) => {
      const l = labels.get(id) ?? 'Someone';
      return named.has(l) || l === 'Family';
    };
    ranked = ranked.filter(forNamed);
    if (ranked.length === 0) {
      return {
        matched: false,
        memories: rows.filter((m) => named.has(labels.get(m.id) ?? '')).slice(0, opts.limit),
        labels,
      };
    }
  }
  if (ranked.length === 0) return { matched: false, memories: rows.slice(0, opts.limit), labels };
  const byId = new Map(rows.map((m) => [m.id, m]));
  return { matched: true, memories: ranked.slice(0, opts.limit).map((id) => byId.get(id)!), labels };
}

const HOUSEHOLD_WORDS = new Set(['family', 'household', 'home', 'us', 'we', 'our', 'everyone']);

/**
 * ADR 0333 — `remember_fact`: save the fact for the person it is about. The
 * name goes through the same rule as chat extraction (`resolveFactSubject`);
 * when nobody, or several people, have that name nothing is saved and the
 * result says so. A fact about another member stays the speaker's private
 * fact (they told it; the member is not shown it), filed under that member.
 */
export async function rememberFactForTurn(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; about?: string; key: string; value: string },
): Promise<MemoryToolResult & { memory?: Memory }> {
  const about = opts.about?.trim() ?? '';
  const words = about.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let write: Pick<UpsertMemoryInput, 'groupId' | 'scope' | 'personaId' | 'subjectType' | 'subjectId'>;

  if (!about || isSelfReference(about)) {
    write = { groupId: opts.groupId, scope: 'persona', personaId: opts.userId, subjectType: 'user', subjectId: opts.userId };
  } else if (words.length > 0 && words.every((w) => HOUSEHOLD_WORDS.has(w) || w === 'the' || w === 'whole')) {
    write = { groupId: opts.groupId, scope: 'group', personaId: null, subjectType: 'household', subjectId: null };
  } else {
    const [members, personas, people] = await Promise.all([
      db
        .selectFrom('group_members')
        .innerJoin('users', 'users.id', 'group_members.user_id')
        .where('group_members.group_id', '=', opts.groupId)
        .select(['users.id as userId', 'users.username', 'users.display_name as displayName'])
        .execute(),
      listPersonas(db, opts.groupId),
      listPeopleForUser(db, opts.userId),
    ]);
    const found = resolveFactSubject(about, factSubjectCandidates({ members, personas, people }));
    if (found.kind !== 'one') {
      const ambiguous = found.kind === 'ambiguous';
      return {
        summary: `remember_fact: ${ambiguous ? 'several people are' : 'nobody is'} called "${about}" — nothing saved`,
        data: {
          saved: false,
          result: ambiguous ? 'ambiguous' : 'not_found',
          ...(ambiguous ? { candidates: found.candidates.map((c) => c.name) } : {}),
          instruction: ambiguous
            ? 'Several people have that name. Ask which one (name the candidates), then call again with that full name. NOTHING was saved.'
            : 'Chord has nobody by that name in the user\'s saved people or this chat\'s family. Ask who they mean, or offer add_person first. NOTHING was saved; never say it was remembered.',
        },
      };
    }
    const s = found.subject;
    if (s.kind === 'user') {
      write = { groupId: opts.groupId, scope: 'persona', personaId: opts.userId, subjectType: 'user', subjectId: s.id };
    } else if (s.kind === 'persona') {
      write = { groupId: opts.groupId, scope: 'group', personaId: null, subjectType: 'persona', subjectId: s.id };
    } else {
      // A saved person is the speaker's own contact: their facts live in the
      // speaker's personal chat (docs/notes/0189), never a shared one.
      const personal = await ensurePersonalGroup(db, opts.userId);
      write = { groupId: personal.id, scope: 'group', personaId: null, subjectType: 'person', subjectId: s.id };
    }
  }

  const { memory } = await writeMemory(db, {
    ...write,
    key: opts.key,
    value: opts.value,
    source: 'explicit',
    status: 'confirmed',
    confidence: 1,
  });
  const label = (await labelMemorySubjects(db, [memory])).get(memory.id) ?? 'You';
  return {
    summary: `remembered for ${label}: ${opts.key}`,
    data: { saved: true, about: label, key: humanKey(opts.key), value: opts.value },
    card: memoryCard(memory, label, opts.userId),
    memory,
  };
}
