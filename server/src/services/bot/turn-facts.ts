/**
 * ADR 0333 — the saved facts a chat turn is shown, each naming who it is
 * about. A chat with up to ALL_FACTS_UP_TO facts gets every one. Above that,
 * the turn gets every fact about a person the user named, every fact whose
 * name shares a word with what they asked, the closest facts by meaning, and
 * the newest few — and the model is told to call list_memories for the rest.
 */
import type { Kysely } from 'kysely';

import type { Memory } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { instantMs } from '../../db/text-instant.js';
import { hasWord, wordSet } from '../../utils/whole-words.js';
import { peopleNamed } from '../fact-subject.js';
import { visibleMemoriesForTurn } from '../memory.service.js';
import { humanKey, labelMemorySubjects } from '../memory-notices.service.js';
import { semanticFactMatches } from '../search/fact-semantic.js';
import { factLine, matchWords } from './memory-tools.js';

/** Every fact is shown when the chat holds this many or fewer. */
export const ALL_FACTS_UP_TO = 80;
/** How many facts closest in meaning are added above that. */
const BY_MEANING = 25;
/** How many of the newest facts are always added above that. */
const NEWEST = 15;
/** The most facts read for a turn at all. */
const READ_AT_MOST = 2000;

/** Words that name a kind of value, not what the fact is about. */
const GENERIC_KEY_WORDS = new Set([
  'number', 'name', 'date', 'info', 'detail', 'details', 'code', 'type', 'list', 'note', 'notes', 'what', 'when', 'where',
]);

export interface TurnFact {
  memory: Memory;
  /** Who the fact is about, as a person reads it: "Ben", "Family". */
  about: string;
}

export interface TurnFacts {
  facts: TurnFact[];
  /** How many confirmed facts the chat holds in all. */
  total: number;
}

/** A word the user asked with appears in the fact's name ("global entry"). */
export function keyShares(asked: readonly string[], key: string): boolean {
  const keyWords = wordSet(humanKey(key));
  return asked.some((w) => w.length >= 4 && !GENERIC_KEY_WORDS.has(w) && hasWord(keyWords, w));
}

export async function factsForTurn(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; text: string },
): Promise<TurnFacts> {
  const rows = (
    await visibleMemoriesForTurn(db, { groupId: opts.groupId, triggeringUserId: opts.userId, limit: READ_AT_MOST })
  ).filter((m) => m.status === 'confirmed');
  const labels = await labelMemorySubjects(db, rows);
  const about = (m: Memory) => labels.get(m.id) ?? 'Someone';
  const all = rows.map((m) => ({ memory: m, about: about(m) }));
  if (rows.length <= ALL_FACTS_UP_TO) return { facts: sortFacts(all), total: rows.length };

  const textWords = wordSet(opts.text);
  const asked = matchWords(opts.text);
  const named = peopleNamed(textWords, all.map((f) => f.about));
  const pick = new Set<string>();
  for (const m of rows) {
    if (named.has(about(m)) || keyShares(asked, m.key)) pick.add(m.id);
  }
  const near = await semanticFactMatches(
    db,
    opts.userId,
    rows.map((m) => ({ id: m.id, text: factLine(about(m), m) })),
    opts.text,
    { limit: BY_MEANING },
  );
  for (const h of near) pick.add(h.id);
  for (const m of rows.slice(0, NEWEST)) pick.add(m.id);

  return { facts: sortFacts(all.filter((f) => pick.has(f.memory.id))), total: rows.length };
}

/** How recent the user's previous message must be to count with this one. */
const FOLLOWUP_MS = 10 * 60_000;

/**
 * The words facts are picked by: the triggering message, plus the same
 * user's previous message in this chat when it is under ten minutes older,
 * so a follow-up ("and his passport?") keeps the person it was about. Bot
 * replies are not read (ADR 0322's reason: they name everything).
 */
export async function turnFactText(db: Kysely<DB>, groupId: string, triggerMessageId: string): Promise<string> {
  const trigger = await db
    .selectFrom('messages')
    .select(['body', 'sender_id', 'created_at'])
    .where('id', '=', triggerMessageId)
    .where('group_id', '=', groupId)
    .executeTakeFirst();
  if (!trigger) return '';
  if (!trigger.sender_id) return trigger.body;
  const prev = await db
    .selectFrom('messages')
    .select(['body', 'created_at'])
    .where('group_id', '=', groupId)
    .where('sender_id', '=', trigger.sender_id)
    .where('kind', 'not in', ['bot', 'system'])
    .where('id', '!=', triggerMessageId)
    .where('created_at', '<=', trigger.created_at)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const gap = prev ? instantMs(trigger.created_at) - instantMs(prev.created_at) : Infinity;
  return gap >= 0 && gap <= FOLLOWUP_MS ? `${prev!.body}\n${trigger.body}` : trigger.body;
}

/** `factsForTurn` for a stored triggering message. */
export async function factsForMessage(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; triggerMessageId: string },
): Promise<TurnFacts> {
  const text = await turnFactText(db, opts.groupId, opts.triggerMessageId);
  return factsForTurn(db, { groupId: opts.groupId, userId: opts.userId, text });
}

/** One person's facts together, people in name order, the family's first. */
function sortFacts(facts: TurnFact[]): TurnFact[] {
  const rank = (a: string) => (a === 'Family' ? 0 : a === 'Someone' ? 2 : 1);
  return [...facts].sort(
    (a, b) =>
      rank(a.about) - rank(b.about) ||
      a.about.localeCompare(b.about) ||
      a.memory.key.localeCompare(b.memory.key),
  );
}

/** The prompt block: one line per fact, each starting with whose it is. */
export function turnFactsBlock(found: TurnFacts, opts: { isPersonal: boolean }): string {
  if (found.facts.length === 0) return '';
  const lines = found.facts.map(({ memory: m, about }) => {
    const privateTag = !opts.isPersonal && m.scope === 'persona' ? ' [private to the person asking]' : '';
    return `- ${factLine(about, m)}${privateTag}`;
  });
  const head =
    'Saved facts. Each line starts with WHO the fact is about. Answer a question about a person only from that ' +
    "person's lines: never give one person's fact (an ID, a number, a date) as another's. If the person asked " +
    'about has no line for it, say Chord has nothing saved for them rather than using someone else\'s.';
  const more =
    found.facts.length < found.total
      ? `\n${found.total - found.facts.length} more saved facts are not shown here. If the fact you need is not ` +
        'listed, call list_memories with a query (the person and what is asked) before saying it is not saved.'
      : '';
  return `${head}\n${lines.join('\n')}${more}`;
}
