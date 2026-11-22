/**
 * ADR 0346 - what a scheduling email says about the meeting it is arranging.
 *
 * Read by the model in the email suggestion pass (what the email does, who is
 * writing, who sends the invite, the format, which times are on offer) and
 * finished in code (dates and times, links, addresses, how the user is
 * addressed). Stored per thread; nothing acts on it by itself.
 */

import type { PersonOffer } from './common-times';

export type SchedulingAct = 'offer_slots' | 'ask_times' | 'agree' | 'counter' | 'reschedule' | 'cancel' | 'fyi';
export type SchedulingWriter = 'principal' | 'assistant' | 'me';
export type InviteSender = 'them' | 'me' | 'unknown';
export type MeetingFormat = 'in_person' | 'video' | 'phone' | 'unknown';
export type Addressed = 'to' | 'cc' | 'sender' | 'none';

export interface SlotFact {
  /** The words the email used, as the model quoted them. */
  text: string;
  /** Local day, read in code from `text`; absent when no date was readable. */
  day?: string;
  minutes?: number;
  endMinutes?: number;
  /** IANA zone the email wrote the time in, when it named one. */
  timeZone?: string;
}

export interface SchedulingFacts {
  act: SchedulingAct;
  writer: SchedulingWriter;
  /** For an assistant: the person they write for, as the email names them. */
  onBehalfOf?: string;
  inviteBy: InviteSender;
  /** A few words from the email that say who sends the invite. */
  inviteEvidence?: string;
  format: MeetingFormat;
  place?: string;
  /** A join link found in the email, and its provider. */
  link?: { provider: string; url: string };
  phone?: string;
  offered: SlotFact[];
  /** ADR 0346 phase 7 - times the writer said they CANNOT do. */
  unavailable: SlotFact[];
  /** Times the writer passed on for other people ("Sam can do Tuesday"). */
  others: Array<{ person: string; offered: SlotFact[]; unavailable: SlotFact[] }>;
  agreed?: SlotFact;
  /** What the meeting is FOR, not the email subject. */
  title?: string;
  /** Addresses that never decide anything: the assistant, rooms. */
  notCore: string[];
  /** How the user was addressed on the message this was read from. */
  addressed: Addressed;
  /** When that message was sent. */
  sentAt?: string;
}

export type MeetingState = 'offered' | 'proposed' | 'agreed' | 'invited' | 'answered' | 'cancelled';

/** What the thread has said about the meeting so far (sealed on the record). */
export interface MeetingFacts {
  title?: string;
  format: MeetingFormat;
  place?: string;
  link?: { provider: string; url: string };
  phone?: string;
  /** The latest times on the table, and who put them there. */
  offered: SlotFact[];
  offeredBy?: 'them' | 'me';
  /** ADR 0346 phase 7 - each person's own offers, newest message per person. */
  offers?: PersonOffer[];
  agreed?: SlotFact;
  onBehalfOf?: string;
  inviteEvidence?: string;
}

/**
 * ADR 0346 phase 4 - a slot kept free in Chord while the other side's
 * invitation is on its way. Read off the meeting record; never an event.
 */
export interface MeetingHold {
  meetingId: string;
  threadKey: string;
  title: string;
  /** First name of the person the meeting is with, when known. */
  withName: string | null;
  people: string[];
  startsAt: string;
  endsAt: string;
}

export interface MeetingCardPlan {
  /** No card: the other side sends the invite, and the slot is held instead. */
  skip: boolean;
  /** Unknown who sends: the card asks "Send an invite, or wait for theirs?". */
  whoSends?: 'ask';
  location?: string;
  /** The user sends and the email asked for a call with no link: the
   *  calendar's own video call (ADR 0319). */
  videoCall?: boolean;
}

/**
 * ADR 0346 phase 5 - what a meeting's event card does, from the user's side.
 * `sender` is who sends the invite as the USER sees it; an assistant
 * arranging it means their side sends. A link already in the email is the
 * call (never a second one added); a place or a number is the location.
 */
export function meetingCardPlan(
  m: {
    sender: InviteSender;
    viaAssistant?: boolean;
    format: MeetingFormat;
    link?: { url: string };
    place?: string;
    phone?: string;
  },
  location?: string,
): MeetingCardPlan {
  if (m.sender === 'them' || (m.sender === 'unknown' && m.viaAssistant)) return { skip: true };
  const where =
    location || m.link?.url || (m.format === 'in_person' ? m.place : undefined) || (m.format === 'phone' ? m.phone : undefined);
  return {
    skip: false,
    ...(m.sender === 'unknown' ? { whoSends: 'ask' as const } : {}),
    ...(where ? { location: where } : {}),
    ...(m.format === 'video' && !m.link ? { videoCall: true } : {}),
  };
}

/**
 * ADR 0346 phase 6 - what the reply drafter is told about the meeting this
 * thread is arranging: who sends the invite, the format, and an agreed time.
 * Empty when there is nothing to say.
 */
export function meetingReplyNote(m: {
  state: MeetingState;
  inviteBy: InviteSender;
  facts: MeetingFacts | null;
  /** The agreed time, already written for the reader ("Tue, Nov 18, 11:00 AM"). */
  agreedText?: string | null;
}): string {
  if (m.state === 'cancelled' || m.state === 'answered') return '';
  const f = m.facts;
  const lines: string[] = [];
  if (m.state === 'agreed' && m.agreedText) {
    lines.push(`A time is already agreed: ${m.agreedText}. Do not reopen it unless the instruction asks to.`);
  }
  if (m.state === 'invited') {
    lines.push('Their calendar invitation has arrived: answer it from the invitation, not by proposing times.');
  } else if (m.inviteBy === 'them') {
    lines.push('The other side said THEY will send the calendar invite: do not offer to send one.');
  } else if (m.inviteBy === 'me') {
    lines.push('The user is the one sending the calendar invite: when a time is settled, say they will send it ("I\'ll send over an invite").');
  } else if (f?.onBehalfOf) {
    lines.push(`An assistant is arranging this for ${f.onBehalfOf}: write to the assistant, and let them send the invite.`);
  } else {
    lines.push('Nobody has said who sends the calendar invite: when a time is settled, offer it lightly ("happy to send an invite, or feel free to send one").');
  }
  if (f?.link) lines.push('A video link is already in the thread: use it; never propose a different call link.');
  else if (f?.format === 'in_person' && f.place) lines.push(`It is in person, at ${f.place}.`);
  else if (f?.format === 'in_person') lines.push('It is in person; the place is not settled yet.');
  else if (f?.format === 'video') lines.push('It is a video call; no link has been shared yet.');
  else if (f?.format === 'phone') lines.push(`It is a phone call${f.phone ? ` (${f.phone})` : ''}.`);
  return lines.join(' ');
}

/** A slot whose day and time were both read. */
export function slotIsTimed(s: SlotFact | undefined): s is SlotFact & { day: string; minutes: number } {
  return !!s && !!s.day && typeof s.minutes === 'number';
}

/**
 * The meeting's next state after one more message. `side` is who wrote it.
 * Returns null when the message says nothing that moves the meeting (an FYI,
 * or an "agree" whose time could not be read).
 */
export function nextMeetingState(
  prev: MeetingState | null,
  act: SchedulingAct,
  side: 'them' | 'me',
  agreedTimed: boolean,
): MeetingState | null {
  if (act === 'cancel') return prev ? 'cancelled' : null;
  if (act === 'fyi') return null;
  if ((act === 'agree' || act === 'reschedule') && agreedTimed) return 'agreed';
  if (act === 'agree') return null;
  // Once invited, only a cancellation or a newly agreed time moves it.
  if (prev === 'invited' || prev === 'answered') return null;
  return side === 'them' ? 'offered' : 'proposed';
}

const ACTS: readonly SchedulingAct[] = ['offer_slots', 'ask_times', 'agree', 'counter', 'reschedule', 'cancel', 'fyi'];
const WRITERS: readonly SchedulingWriter[] = ['principal', 'assistant', 'me'];
const SENDERS: readonly InviteSender[] = ['them', 'me', 'unknown'];
const FORMATS: readonly MeetingFormat[] = ['in_person', 'video', 'phone', 'unknown'];

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;

const text = (v: unknown, cap: number): string | undefined => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, cap) : '';
  return s || undefined;
};

/** The model's block, shape-checked. Dates, links and people are filled in by
 *  the caller; anything malformed becomes "unknown", never a guess. */
export interface SchedulingBlock {
  act: SchedulingAct;
  writer: SchedulingWriter;
  onBehalfOf?: string;
  inviteBy: InviteSender;
  inviteEvidence?: string;
  format: MeetingFormat;
  place?: string;
  phone?: string;
  offered: string[];
  /** Phrases the writer said they cannot do ("not Wednesday"). */
  unavailable: string[];
  /** Times passed on for others, by the name or address the email uses. */
  others: Array<{ person: string; offered: string[]; unavailable: string[] }>;
  agreed?: string;
  title?: string;
  /** Names or addresses the model marked as assistants. */
  assistants: string[];
}

export function readSchedulingBlock(raw: unknown): SchedulingBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const act = oneOf(ACTS, o.act, 'fyi');
  if (!(ACTS as readonly string[]).includes(String(o.act))) return null;
  const list = (v: unknown, n: number, cap: number): string[] =>
    Array.isArray(v)
      ? v.map((x) => text(x, cap)).filter((x): x is string => !!x).slice(0, n)
      : [];
  return {
    act,
    writer: oneOf(WRITERS, o.writer, 'principal'),
    ...(text(o.onBehalfOf, 80) ? { onBehalfOf: text(o.onBehalfOf, 80) } : {}),
    inviteBy: oneOf(SENDERS, o.inviteBy, 'unknown'),
    ...(text(o.inviteEvidence, 120) ? { inviteEvidence: text(o.inviteEvidence, 120) } : {}),
    format: oneOf(FORMATS, o.format, 'unknown'),
    ...(text(o.place, 160) ? { place: text(o.place, 160) } : {}),
    ...(text(o.phone, 40) ? { phone: text(o.phone, 40) } : {}),
    offered: list(o.offered, 12, 120),
    ...(text(o.agreed, 120) ? { agreed: text(o.agreed, 120) } : {}),
    ...(text(o.title, 100) ? { title: text(o.title, 100) } : {}),
    assistants: list(o.assistants, 4, 120),
    unavailable: list(o.unavailable, 12, 120),
    others: Array.isArray(o.others)
      ? o.others
          .map((x) => {
            const r = (x ?? {}) as Record<string, unknown>;
            const person = text(r.person, 120);
            return person
              ? { person, offered: list(r.offered, 12, 120), unavailable: list(r.unavailable, 12, 120) }
              : null;
          })
          .filter((x): x is { person: string; offered: string[]; unavailable: string[] } => !!x)
          .slice(0, 8)
      : [],
  };
}
