/**
 * ADR 0346 phase 2 - the scheduling block, read off the same reply as the
 * email's suggestions and finished in code.
 *
 * The model says what the email does, who writes, who sends the invite, the
 * format and WHICH phrases are times on offer. Code reads those phrases into
 * dates and times (`mentionedSlots`, the same reader the reply drafter uses),
 * finds a join link in the body, turns the assistants it named into addresses
 * from the headers, and decides how the user was addressed. Stored only.
 */
import type { Kysely } from 'kysely';

import {
  eventJoinLinks,
  splitQuotedText,
  readSchedulingBlock,
  type Addressed,
  type SchedulingBlock,
  type SchedulingFacts,
  type SlotFact,
} from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { mentionedSlots } from '../../utils/date-mentions.js';
import { sealThreadJsonFor } from './content-seal.js';

/** The optional `scheduling` key of the extractor's reply. */
export function parseScheduling(raw: string): SchedulingBlock | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return readSchedulingBlock((JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>).scheduling);
  } catch {
    return null;
  }
}

export interface SchedulingMessage {
  bodyText: string | null;
  fromEmail: string | null;
  fromName: string | null;
  toEmails: readonly string[];
  ccEmails: readonly string[];
  /** The message's sent day in the user's zone, `YYYY-MM-DD`: relative dates
   *  ("tomorrow") are read from it. */
  sentDay: string;
  sentAt?: string | null;
}

export function addressedOn(m: SchedulingMessage, own: readonly string[]): Addressed {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const has = (l: readonly string[]) => l.some((a) => mine.has(a.toLowerCase()));
  if (m.fromEmail && mine.has(m.fromEmail.toLowerCase())) return 'sender';
  if (has(m.toEmails)) return 'to';
  if (has(m.ccEmails)) return 'cc';
  return 'none';
}

/** Words that talk about sending the calendar invite. */
const INVITE_WORDS = /\b(invit\w*|calendar|cal|send\w*|sent|meeting request|set (?:it|this|one)? ?up|book\w*|schedul\w*|zoom|teams|meet link|hold)\b/i;

const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Where a phrase the model quoted sits: in this message's own words, only in
 * the history it quotes, or nowhere we can find (paraphrased).
 */
function phrasePlace(phrase: string, visible: string, whole: string): 'own' | 'quoted' | 'unknown' {
  const p = squash(phrase).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!p) return 'unknown';
  if (squash(visible).includes(p)) return 'own';
  return squash(whole).includes(p) ? 'quoted' : 'unknown';
}

/**
 * The slots a phrase names. A phrase with no date of its own ("anytime
 * between 2-4p est") takes the date said earlier on its line ("how is noon
 * est tomorrow? Or anytime between 2-4p est?"): the line up to the phrase is
 * read with and without it, and only the phrase's own times are kept.
 */
function slotsOf(phrase: string, day: string, visible = ''): SlotFact[] {
  let read = mentionedSlots(phrase, day);
  if (read.length === 0 && visible) {
    const flat = visible.replace(/[^\S\r\n]+/g, ' ');
    const at = flat.toLowerCase().indexOf(squash(phrase));
    if (at > 0) {
      const lineStart = flat.lastIndexOf('\n', at) + 1;
      const before = flat.slice(lineStart, at);
      const known = new Set(mentionedSlots(before, day).map((s) => `${s.day}@${s.minutes}`));
      read = mentionedSlots(before + flat.slice(at, at + squash(phrase).length), day).filter((s) => !known.has(`${s.day}@${s.minutes}`));
    }
  }
  if (read.length === 0) return [{ text: phrase }];
  return read.map((s) => ({
    text: phrase,
    day: s.day,
    ...(s.minutes !== undefined ? { minutes: s.minutes } : {}),
    ...(s.endMinutes !== undefined ? { endMinutes: s.endMinutes } : {}),
    ...(s.timeZone ? { timeZone: s.timeZone } : {}),
  }));
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);

/**
 * The header address a name the email uses stands for: an address as
 * written, the sender by their display name, or an address whose local part
 * carries the name. Null when none or several fit (never a guess).
 */
export function addressForName(name: string, m: SchedulingMessage, own: readonly string[]): string | null {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const all = [...new Set([m.fromEmail, ...m.toEmails, ...m.ccEmails].filter((a): a is string => !!a).map((a) => a.toLowerCase()))].filter(
    (a) => !mine.has(a),
  );
  const n = name.trim().toLowerCase();
  if (n.includes('@')) return all.includes(n) ? n : null;
  const ws = words(n);
  if (ws.length === 0) return null;
  if (m.fromName && m.fromEmail && words(m.fromName).some((w) => ws.includes(w)) && !mine.has(m.fromEmail.toLowerCase())) {
    return m.fromEmail.toLowerCase();
  }
  const hits = all.filter((a) => words(a.split('@')[0]!).some((w) => w.length >= 3 && ws.includes(w)));
  return hits.length === 1 ? hits[0]! : null;
}

/** The header addresses the model's assistant names stand for. */
function assistantAddresses(block: SchedulingBlock, m: SchedulingMessage, own: readonly string[]): string[] {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const all = [m.fromEmail, ...m.toEmails, ...m.ccEmails]
    .filter((a): a is string => !!a)
    .map((a) => a.toLowerCase())
    .filter((a) => !mine.has(a));
  const out = new Set<string>();
  if (block.writer === 'assistant' && m.fromEmail && !mine.has(m.fromEmail.toLowerCase())) {
    out.add(m.fromEmail.toLowerCase());
  }
  for (const name of block.assistants) {
    const n = name.toLowerCase();
    if (n.includes('@')) {
      if (all.includes(n)) out.add(n);
      continue;
    }
    const ws = words(n);
    if (ws.length === 0) continue;
    if (m.fromName && m.fromEmail && words(m.fromName).some((w) => ws.includes(w))) {
      out.add(m.fromEmail.toLowerCase());
      continue;
    }
    // A bare address carries no name; its local part often does.
    for (const a of all) if (words(a.split('@')[0]!).some((w) => w.length >= 3 && ws.includes(w))) out.add(a);
  }
  return [...out];
}

export function finishScheduling(
  block: SchedulingBlock,
  m: SchedulingMessage,
  own: readonly string[],
  opts: { askedOfUser?: boolean } = {},
): SchedulingFacts {
  const link = eventJoinLinks({ description: m.bodyText ?? '' })[0];
  let act = block.act;
  // A time is the WRITER's only when it is in their own words: a time quoted
  // from earlier in the thread belongs to whoever wrote it there (prod
  // 2026-11-17: the user's "noon est tomorrow" was stored as Arthur's offer).
  const whole = m.bodyText ?? '';
  const visible = whole ? splitQuotedText(whole).visible : '';
  const theirs = (p: string): boolean => !whole || phrasePlace(p, visible, whole) !== 'quoted';
  const read = (p: string): SlotFact[] => slotsOf(p, m.sentDay, visible);
  let offered = block.offered.filter(theirs).flatMap(read);
  // "I'm free tomorrow from 10-1. Anything work?" reads to a model as a
  // question; when it quotes no time, the message's own text (not the quoted
  // history) is read for one. A time named there is an offer.
  if (act === 'ask_times' && offered.length === 0) {
    const own = splitQuotedText(m.bodyText).visible;
    const read = mentionedSlots(own, m.sentDay).filter((s) => s.minutes !== undefined);
    if (read.length > 0) {
      act = 'offer_slots';
      offered = read.map((s) => ({
        text: own.slice(0, 120),
        day: s.day,
        minutes: s.minutes,
        ...(s.endMinutes !== undefined ? { endMinutes: s.endMinutes } : {}),
        ...(s.timeZone ? { timeZone: s.timeZone } : {}),
      }));
    }
  } else if (act === 'ask_times' && offered.some((s) => s.minutes !== undefined)) {
    act = 'offer_slots';
  }
  const agreed = block.agreed && theirs(block.agreed) ? read(block.agreed)[0] : undefined;
  const unavailable = block.unavailable.filter(theirs).flatMap(read);
  // Who sends the invite has to be said in this message, in words we can
  // find: agreeing a time says nothing about it, and a guess here decides
  // whether the user is offered an invite card at all.
  // Kept only when this message's own words talk about the invite at all:
  // "2:00 works, I am in Seattle so 11:00 PST" does not, and the live model
  // still answered "them" and cited those very words as its evidence. The
  // model often gives no evidence when it is right ("Can you send an
  // invite?"), so the message is read, not the evidence.
  const ownWords = whole ? visible : (block.inviteEvidence ?? '');
  const inviteBy = block.inviteBy !== 'unknown' && INVITE_WORDS.test(ownWords) ? block.inviteBy : 'unknown';
  // Times passed on for others: kept under the address the name stands for,
  // or under the name itself when no header address fits.
  const others = block.others.map((o) => ({
    person: addressForName(o.person, m, own) ?? o.person.toLowerCase(),
    offered: o.offered.filter(theirs).flatMap(read),
    unavailable: o.unavailable.filter(theirs).flatMap(read),
  }));
  const addressed = addressedOn(m, own);
  // On Cc only, the scheduling is someone else's unless the pass kept an ask
  // of the user's own from this email (the same askedOf rule as the cards).
  if ((addressed === 'cc' || addressed === 'none') && !opts.askedOfUser) act = 'fyi';
  return {
    act,
    writer: block.writer,
    ...(block.onBehalfOf ? { onBehalfOf: block.onBehalfOf } : {}),
    inviteBy,
    ...(block.inviteEvidence ? { inviteEvidence: block.inviteEvidence } : {}),
    // A join link in the email settles the format, whatever the model said.
    format: link ? 'video' : block.format,
    ...(block.place ? { place: block.place } : {}),
    ...(link ? { link: { provider: link.provider, url: link.url } } : {}),
    ...(block.phone ? { phone: block.phone } : {}),
    offered,
    unavailable,
    others,
    ...(agreed ? { agreed } : {}),
    ...(block.title ? { title: block.title } : {}),
    notCore: assistantAddresses(block, m, own),
    addressed,
    ...(m.sentAt ? { sentAt: m.sentAt } : {}),
  };
}

export async function recordScheduling(
  db: Kysely<DB>,
  threadId: string,
  facts: SchedulingFacts,
): Promise<void> {
  await db
    .updateTable('email_threads')
    .set({ scheduling_json: await sealThreadJsonFor(db, threadId, 'scheduling_json', facts) })
    .where('id', '=', threadId)
    .execute();
}
