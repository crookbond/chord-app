/**
 * "Invite wins" convergence (ADR 0074 addendum). A meeting agreed in plain
 * email often becomes a Chord event (magics → confirm) BEFORE one party sends
 * the real calendar invite. The two share no UID and rarely share a title, so
 * key-based dedup can't link them — but the user meant ONE appointment. When
 * a real calendar item arrives for the agreed slot:
 *   - a still-pending email-derived event proposal is retracted, and
 *   - an already-created email-derived event is ADOPTED (the caller stamps
 *     the real identity onto it) instead of inserting a same-slot twin.
 *
 * Leaf module on purpose: only db access, so the two-way sync, the executor,
 * and the magics pass can all use it without an import cycle. The one reach
 * outside — marking a retracted proposal's source mail read — is a dynamic
 * `import()` for exactly that reason.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import { transactionThen } from '../db/after-commit.js';

import { logger } from '../config/logging.js';
import type { DB, EventsTable } from '../db/schema.js';
import { textInstant } from '../db/text-instant.js';
import { hasStarted, isPastEventStart } from '../utils/tz.js';
import { isSameEvent } from './events/same-event.js';

/** How far the invite's start may drift from the email-agreed time. */
export const INVITE_ADOPT_WINDOW_MS = 60 * 60 * 1000;

/**
 * How far apart two email-derived suggestions may start and still mean the
 * same thing. Booking mail arrives as several Gmail threads (confirmation,
 * reminder, "your stay is coming up"), each read independently, and the LLM's
 * time reading can drift hours between them — so this window is deliberately
 * much wider than the invite-adopt one. Two REAL same-title events this close
 * together are rare in email-derived suggestions; two extractions of the same
 * booking are the norm.
 */
export const PROPOSAL_DUP_WINDOW_MS = 12 * 60 * 60 * 1000;

const normalizeTitle = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Normalized equality or containment ("test" vs "Invitation: test"). */
function titlesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTitle(a ?? '');
  const nb = normalizeTitle(b ?? '');
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

interface SuggestedEvent {
  title: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
  externalUid?: string;
  /** Addresses the card will invite (ADR 0315 addendum). */
  invitees?: string[];
}

/** The card as the same-event rule sees it: its invitees are its people. */
const asEventLike = (e: SuggestedEvent) => ({ ...e, guestEmails: e.invitees ?? null });

/**
 * Same booking extracted twice? Titles must match after normalization —
 * exactly, or one containing the other ("Stay at X" vs "Stay at X, Nairobi")
 * — and the starts must fall inside the dup window. A shared invite UID is a
 * match on its own.
 */
export function isSameSuggestedEvent(a: SuggestedEvent, b: SuggestedEvent): boolean {
  if (a.externalUid && b.externalUid) return a.externalUid === b.externalUid;
  // The creation-time rule, applied before a card is even shown: two emails
  // about one flight word it differently but agree on the exact times.
  if (!a.externalUid && !b.externalUid && isSameEvent(asEventLike(a), asEventLike(b))) return true;
  if (!titlesMatch(a.title, b.title)) return false;
  const sa = Date.parse(a.startsAt);
  const sb = Date.parse(b.startsAt);
  return Number.isFinite(sa) && Number.isFinite(sb) && Math.abs(sa - sb) <= PROPOSAL_DUP_WINDOW_MS;
}

/** More identity + more detail wins when picking which duplicate to keep. */
export function suggestedEventRichness(e: SuggestedEvent): number {
  return (e.externalUid ? 4 : 0) + (e.location ? 2 : 0) + (e.endsAt ? 1 : 0);
}

export interface PendingEventProposalRow {
  id: string;
  created_at: string;
  provenance: string | null;
  args: SuggestedEvent;
}

export async function pendingEmailEventProposals(
  db: Kysely<DB>,
  userId: string,
): Promise<PendingEventProposalRow[]> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'args_json', 'created_at', 'provenance'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', 'create_event')
    .where('status', '=', 'pending')
    .where('provenance', 'like', 'gmail:%')
    .execute();
  const out: PendingEventProposalRow[] = [];
  for (const r of rows) {
    try {
      const args = JSON.parse(r.args_json) as SuggestedEvent;
      if (typeof args.title === 'string' && typeof args.startsAt === 'string') {
        out.push({ id: r.id, created_at: r.created_at, provenance: r.provenance, args });
      }
    } catch {
      /* unparseable proposal — not our problem here */
    }
  }
  return out;
}

/**
 * A convergence retraction means the obligation really was met — the meeting
 * is on the calendar, or the invite was cancelled — so the source mail stops
 * claiming anything and must go read with the badge it just dropped. Without
 * this, the tile count and the mailbox disagree about whether the thread was
 * dealt with, which is the failure decision-counts replaced unread to prevent.
 *
 * Deliberately NOT inside `expireProposals`: consolidation also expires rows,
 * and there the obligation is not satisfied, only re-homed onto the surviving
 * card. Only the three convergence paths call this.
 *
 * Dynamically imported — this module is a db-only leaf, and `thread-read`
 * reaches `gmail.service`, which reaches back here through the magics pass.
 * Best-effort: a dead token must never fail the retraction that triggered it.
 */
async function markRetractedSourcesRead(
  db: Kysely<DB>,
  userId: string,
  provenances: Array<string | null>,
): Promise<void> {
  if (provenances.length === 0) return;
  try {
    const { markSourceThreadsRead } = await import('./email/thread-read.js');
    await markSourceThreadsRead(db, userId, provenances);
  } catch (err) {
    logger.warn('marking retracted proposal sources read failed', { err, userId });
  }
}

export async function expireProposals(db: Kysely<DB>, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable('proposals')
    .set({ status: 'expired', resolved_at: new Date().toISOString() })
    .where('id', 'in', ids)
    // Ids were read as pending a moment ago; a confirm that landed since has
    // already run its tool and must stay confirmed.
    .where('status', '=', 'pending')
    .execute();
}

/**
 * Staging-time dedup for the magics pass. Returns whether the candidate
 * should be staged; when the candidate is strictly richer than every pending
 * duplicate (e.g. it now carries the location or the invite UID), the stale
 * ones are expired so the richer card replaces them instead of stacking.
 *
 * ADR 0137 — a start the user has already lived through is never staged. The
 * backfill window is 30 days, so connecting a mailbox reads a month of settled
 * mail: last month's gym booking is a confirmation, not a plan. Unlike a bot
 * turn (ADR 0100) there is nobody to ask, and unlike a typo there is nothing
 * ambiguous — the date is simply over, so the answer is silence, not a card.
 */
export async function shouldStageEventProposal(
  db: Kysely<DB>,
  userId: string,
  candidate: SuggestedEvent,
  opts: { tzOffset?: string; provenance?: string | null } = {},
): Promise<boolean> {
  if (isPastEventStart(candidate.startsAt, opts.tzOffset)) return false;
  // ADR 0348 - someone on the thread already sent the invitation (prod: the
  // assistant's invite was on the calendar, and a card for the same call
  // invited the whole thread a second time).
  if (opts.provenance && candidate.invitees?.length) {
    const { meetingAlreadyOnCalendar } = await import('./events/calendar-fit.service.js');
    if (await meetingAlreadyOnCalendar(db, userId, { args: { ...candidate }, provenance: opts.provenance })) return false;
  }
  // ADR 0347 — a meeting card that would invite people to a time already gone
  // earlier today: the invitation is for nothing.
  if (candidate.invitees?.length && hasStarted(candidate.startsAt)) return false;
  // ADR 0223 addendum — the meeting is already on the calendar at these
  // times with these people (prod: a card for Mark's call staged 11 seconds
  // after his invite synced in under another title).
  if (!candidate.externalUid && candidate.invitees?.length) {
    const t = Date.parse(candidate.startsAt);
    if (Number.isFinite(t)) {
      const onCalendar = await db
        .selectFrom('events')
        .select(['title', 'starts_at', 'ends_at', 'location', 'guest_emails'])
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .where('status', '!=', 'cancelled')
        .where('all_day', '=', 0)
        .where(sql<boolean>`${textInstant('events.starts_at')} = ${new Date(t).toISOString()}::timestamptz`)
        .execute();
      const covered = onCalendar.some((e) =>
        isSameEvent(
          { title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, location: e.location, guestEmails: e.guest_emails },
          asEventLike(candidate),
        ),
      );
      if (covered) return false;
    }
  }
  const pending = await pendingEmailEventProposals(db, userId);
  const dups = pending.filter((p) => isSameSuggestedEvent(p.args, candidate));
  if (dups.length === 0) return true;
  const score = suggestedEventRichness(candidate);
  if (dups.some((d) => suggestedEventRichness(d.args) >= score)) return false;
  await expireProposals(
    db,
    dups.map((d) => d.id),
  );
  return true;
}

interface PendingListItemProposalRow {
  id: string;
  created_at: string;
  listName: string;
  items: string[];
}

async function pendingEmailListItemProposals(
  db: Kysely<DB>,
  userId: string,
): Promise<PendingListItemProposalRow[]> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'args_json', 'created_at'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', 'add_list_item')
    .where('status', '=', 'pending')
    .where('provenance', 'like', 'gmail:%')
    .execute();
  const out: PendingListItemProposalRow[] = [];
  for (const r of rows) {
    try {
      const args = JSON.parse(r.args_json) as { listName?: string; items?: unknown[] };
      if (typeof args.listName === 'string' && Array.isArray(args.items)) {
        out.push({
          id: r.id,
          created_at: r.created_at,
          listName: args.listName,
          items: args.items.filter((i): i is string => typeof i === 'string'),
        });
      }
    } catch {
      /* unparseable proposal — not our problem here */
    }
  }
  return out;
}

/**
 * Trailing padding the extractor sometimes bolts onto a to-do ("… and take
 * action accordingly"). It says nothing the action doesn't already say, but it
 * turns one to-do written twice into two cards, because list-item identity is
 * exact normalized equality — deliberately so (see below).
 *
 * The fix canonicalizes the TEXT rather than loosening the match: both
 * readings reduce to the same item and the existing rule catches them
 * unchanged. Narrow on purpose — it needs the conjunction AND a terminal
 * "accordingly" / "as appropriate", which no real to-do ends with. Applied
 * both at extraction (so what's stored is clean) and inside the comparison
 * below (so cards staged before this existed still collapse on the sweep).
 */
const FILLER_TAIL_RE = /[\s,]+and\s+[\w\s]{0,30}?(?:accordingly|as appropriate)\s*[.!]?\s*$/i;

export function stripFillerTail(item: string): string {
  const stripped = item.replace(FILLER_TAIL_RE, '').trim();
  return stripped.length > 0 ? stripped : item.trim();
}

/**
 * Same to-do extracted twice? A LinkedIn invite + its reminder are separate
 * Gmail threads that both yield "Add Stephen Walker on LinkedIn". Items have
 * no time axis, so identity is exact normalized equality of list name + item
 * text — containment would over-merge real to-dos ("buy milk" / "buy milk
 * and eggs").
 */
export function isSameSuggestedListItem(
  a: { listName: string; item: string },
  b: { listName: string; item: string },
): boolean {
  const ia = normalizeTitle(stripFillerTail(a.item));
  const ib = normalizeTitle(stripFillerTail(b.item));
  return normalizeTitle(a.listName) === normalizeTitle(b.listName) && ia !== '' && ia === ib;
}

/** Staging-time dedup for list-item magics: skip when any pending email-derived
 *  proposal already carries the same item on the same list. */
export async function shouldStageListItemProposal(
  db: Kysely<DB>,
  userId: string,
  candidate: { listName: string; item: string },
): Promise<boolean> {
  const pending = await pendingEmailListItemProposals(db, userId);
  return !pending.some((p) =>
    p.items.some((item) => isSameSuggestedListItem({ listName: p.listName, item }, candidate)),
  );
}

/**
 * ADR 0132 - the same guard for a task. Two cards asking to create the same
 * task is the duplicate-suggestion problem ADR 0095 solved for the bot, in the
 * one place a user sees them side by side.
 *
 * Title-only, ignoring the due date: "return the form" proposed twice with
 * different deadlines is still one obligation, and the newer card wins by
 * being the one that survives.
 */
export async function shouldStageTaskProposal(
  db: Kysely<DB>,
  userId: string,
  candidate: { title: string; dueAt?: string },
  opts: { tzOffset?: string } = {},
): Promise<boolean> {
  // ADR 0158 — a to-do whose stated deadline has already passed is noise, not
  // an obligation: "confirm attendance for the Sep 5 reservation" staged on
  // Sep 11 has nothing left to act on. Same guard as `shouldStageEventProposal`.
  if (candidate.dueAt && isPastEventStart(candidate.dueAt, opts.tzOffset)) return false;
  const rows = await db
    .selectFrom('proposals')
    .select('args_json')
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', 'create_task')
    .where('status', '=', 'pending')
    .where('provenance', 'like', 'gmail:%')
    .execute();
  const wanted = normalizeTitle(stripFillerTail(candidate.title));
  return !rows.some((r) => {
    try {
      const args = JSON.parse(r.args_json) as { title?: unknown };
      return (
        typeof args.title === 'string' &&
        normalizeTitle(stripFillerTail(args.title)) === wanted
      );
    } catch {
      return false;
    }
  });
}

/** List-item counterpart of the event sweep below: one card per distinct
 *  (list, item), newest kept. */
export async function consolidateDuplicateListItemProposals(
  db: Kysely<DB>,
  userId: string,
): Promise<number> {
  const pending = await pendingEmailListItemProposals(db, userId);
  if (pending.length < 2) return 0;
  const keep = new Map<string, PendingListItemProposalRow>();
  const toExpire: string[] = [];
  for (const row of [...pending].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const key = row.items
      .map((i) => `${normalizeTitle(row.listName)}::${normalizeTitle(stripFillerTail(i))}`)
      .join('|');
    if (keep.has(key)) toExpire.push(row.id);
    else keep.set(key, row);
  }
  await expireProposals(db, toExpire);
  return toExpire.length;
}

async function pendingEmailProposalArgs(
  db: Kysely<DB>,
  userId: string,
  toolName: 'add_person' | 'add_important_date',
): Promise<Array<{ id: string; created_at: string; args: Record<string, unknown> }>> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'args_json', 'created_at'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', toolName)
    .where('status', '=', 'pending')
    .where('provenance', 'like', 'gmail:%')
    .execute();
  const out: Array<{ id: string; created_at: string; args: Record<string, unknown> }> = [];
  for (const r of rows) {
    try {
      const args = JSON.parse(r.args_json) as Record<string, unknown>;
      out.push({ id: r.id, created_at: r.created_at, args });
    } catch {
      /* unparseable proposal — not our problem here */
    }
  }
  return out;
}

/** One pending card per person name, newest kept. Identity is the normalized
 *  display name — the same key the staging-time guard uses. */
export async function consolidateDuplicatePersonProposals(
  db: Kysely<DB>,
  userId: string,
): Promise<number> {
  const pending = await pendingEmailProposalArgs(db, userId, 'add_person');
  if (pending.length < 2) return 0;
  const seen = new Set<string>();
  const toExpire: string[] = [];
  for (const row of [...pending].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const name = typeof row.args.displayName === 'string' ? normalizeTitle(row.args.displayName) : '';
    if (!name) continue;
    if (seen.has(name)) toExpire.push(row.id);
    else seen.add(name);
  }
  await expireProposals(db, toExpire);
  return toExpire.length;
}

/** Person + date counterpart. Identity ignores the YEAR: an unknown-year date
 *  arrives as `0000-MM-DD` (and birthdays recur), so the same birthday read
 *  from two threads must collapse even when one of them guessed a year. */
export async function consolidateDuplicateDateProposals(
  db: Kysely<DB>,
  userId: string,
): Promise<number> {
  const pending = await pendingEmailProposalArgs(db, userId, 'add_important_date');
  if (pending.length < 2) return 0;
  const seen = new Set<string>();
  const toExpire: string[] = [];
  for (const row of [...pending].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const key = importantDateKey(row.args);
    if (!key) continue;
    if (seen.has(key)) toExpire.push(row.id);
    else seen.add(key);
  }
  await expireProposals(db, toExpire);
  return toExpire.length;
}

/** Identity for an `add_important_date` proposal: person + kind + month/day. */
export function importantDateKey(args: {
  personName?: unknown;
  kind?: unknown;
  date?: unknown;
}): string | null {
  const person = typeof args.personName === 'string' ? normalizeTitle(args.personName) : '';
  const kind = typeof args.kind === 'string' ? args.kind : '';
  const date = typeof args.date === 'string' ? args.date : '';
  if (!person || !kind || date.length < 10) return null;
  return `${person}::${kind}::${date.slice(5)}`;
}

/**
 * Cross-thread consolidation sweep: cluster the user's pending email-derived
 * event proposals by same-event identity and keep ONE per cluster (richest,
 * then newest), expiring the rest. Heals duplicates that accumulated before
 * staging-time dedup existed; cheap enough to run every magics pass.
 */
/** Minimal union-find over `[0, size)`, path-compressing on find. */
function makeUnionFind(size: number): { find: (x: number) => number; union: (a: number, b: number) => void } {
  const parent = Array.from({ length: size }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  return { find, union };
}

/**
 * `isSameSuggestedEvent(a, b)` can only be true two ways: a shared non-empty
 * `externalUid` (no time bound at all — an invite's own date may have been
 * corrected since), or a title match within `PROPOSAL_DUP_WINDOW_MS`. Rather
 * than checking every pair (O(n²) on the user's whole pending pile every
 * magics pass), find edges from each source directly — an O(n) hash bucket
 * for the UID case, and a sorted sliding window for the time-bounded case —
 * and union them. Same result, no pair outside those two shapes is ever
 * compared, because none could match anyway.
 */
export async function consolidateDuplicateEventProposals(
  db: Kysely<DB>,
  userId: string,
): Promise<number> {
  const pending = await pendingEmailEventProposals(db, userId);
  if (pending.length < 2) return 0;

  const uf = makeUnionFind(pending.length);

  const byUid = new Map<string, number[]>();
  pending.forEach((row, i) => {
    if (!row.args.externalUid) return;
    const idxs = byUid.get(row.args.externalUid) ?? [];
    idxs.push(i);
    byUid.set(row.args.externalUid, idxs);
  });
  for (const idxs of byUid.values()) {
    for (let k = 1; k < idxs.length; k++) uf.union(idxs[0], idxs[k]);
  }

  const byTime = pending
    .map((row, i) => ({ i, t: Date.parse(row.args.startsAt) }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
  for (let a = 0; a < byTime.length; a++) {
    for (let b = a + 1; b < byTime.length; b++) {
      if (byTime[b].t - byTime[a].t > PROPOSAL_DUP_WINDOW_MS) break; // sorted — nothing further can be closer
      if (isSameSuggestedEvent(pending[byTime[a].i].args, pending[byTime[b].i].args)) {
        uf.union(byTime[a].i, byTime[b].i);
      }
    }
  }

  const clusters = new Map<number, PendingEventProposalRow[]>();
  pending.forEach((row, i) => {
    const root = uf.find(i);
    const arr = clusters.get(root) ?? [];
    arr.push(row);
    clusters.set(root, arr);
  });

  const toExpire: string[] = [];
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue;
    const [, ...rest] = cluster.sort(
      (a, b) =>
        suggestedEventRichness(b.args) - suggestedEventRichness(a.args) ||
        b.created_at.localeCompare(a.created_at),
    );
    toExpire.push(...rest.map((r) => r.id));
  }
  await expireProposals(db, toExpire);
  return toExpire.length;
}

/**
 * Does an email-derived thing (proposal or event) at `emailStart` mean the
 * same appointment as a real calendar item (`title` @ `t`)? Within ±60 min,
 * yes regardless of title (the original invite-adopt net). Beyond that, up to
 * ±12 h when the titles match — an LLM parse of an invite email can be hours
 * off (timezone drift), but "test" at 9am and "test" at 3pm the same day are
 * one meeting far more often than two.
 */
function coversEmailDerived(
  t: number,
  title: string | undefined,
  emailStart: string,
  emailTitle: string | undefined,
): boolean {
  const s = Date.parse(emailStart);
  if (!Number.isFinite(s)) return false;
  const gap = Math.abs(s - t);
  if (gap <= INVITE_ADOPT_WINDOW_MS) return true;
  return gap <= PROPOSAL_DUP_WINDOW_MS && titlesMatch(title, emailTitle);
}

/** The user's own addresses: sign-in email and every connected mailbox. */
async function ownAddressSet(db: Kysely<DB>, userId: string): Promise<Set<string>> {
  const [user, accounts] = await Promise.all([
    db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirst(),
    db.selectFrom('email_accounts').select('email_address').where('user_id', '=', userId).execute(),
  ]);
  return new Set(
    [user?.email, ...accounts.map((a) => a.email_address)]
      .filter((e): e is string => !!e)
      .map((e) => e.toLowerCase()),
  );
}

/** Everyone on the email thread a `gmail:` provenance points at. */
export async function emailThreadPeopleOf(
  db: Kysely<DB>,
  userId: string,
  provenance: string | null | undefined,
): Promise<string[]> {
  if (!provenance?.startsWith('gmail:')) return [];
  const gid = provenance.slice('gmail:'.length).trim();
  if (!gid) return [];
  const rows = await db
    .selectFrom('email_messages')
    .select(['from_email', 'to_emails', 'cc_emails'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gid)
    .limit(50)
    .execute();
  const out: string[] = [];
  for (const r of rows) {
    if (r.from_email) out.push(r.from_email);
    for (const list of [r.to_emails, r.cc_emails]) {
      if (Array.isArray(list)) out.push(...list.filter((e): e is string => typeof e === 'string'));
    }
  }
  return out;
}

function otherPeople(addresses: Iterable<string | null | undefined>, own: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const a of addresses) {
    const e = a?.trim().toLowerCase();
    if (e && e.includes('@') && !own.has(e)) out.add(e);
  }
  return out;
}

/**
 * Does an email-derived thing share evidence with a calendar item beyond
 * being near it in time? A matching title, or someone other than the user who
 * is on both: the email thread it came from or its guests, against the
 * item's organizer and guests. Time alone is not evidence (ADR 0344): an
 * unrelated meeting an hour away cancelled a real call with a guest on it.
 */
async function sharesEvidence(
  db: Kysely<DB>,
  userId: string,
  own: Set<string>,
  incoming: { title?: string; people?: string[] },
  emailDerived: { title: string | undefined; provenance: string | null | undefined; guests?: unknown },
): Promise<boolean> {
  if (titlesMatch(incoming.title, emailDerived.title)) return true;
  const theirs = otherPeople(incoming.people ?? [], own);
  if (theirs.size === 0) return false;
  const guests = Array.isArray(emailDerived.guests)
    ? emailDerived.guests.filter((g): g is string => typeof g === 'string')
    : [];
  const ours = otherPeople([...guests, ...(await emailThreadPeopleOf(db, userId, emailDerived.provenance))], own);
  for (const p of theirs) if (ours.has(p)) return true;
  return false;
}

/**
 * An event created from a plain EMAIL agreement that a real calendar item
 * looks like the real version of: same owner, timed, provenance
 * `gmail:<threadId>`, no external identity of its own (no invite UID — that
 * reconciles by key), within ±60 min sharing a person, or within ±12 h with a
 * matching title.
 *
 * Finding one changes nothing by itself (ADR 0344): callers add the calendar
 * item as its own event and ask in chat (`askAboutEmailTwin`) whether to
 * remove Chord's. Deleting a pushed event with guests sends them a
 * cancellation, which is not a guess Chord gets to make. A repeating twin is
 * never matched — one invite covers one occurrence.
 */
export async function findEmailEventTwin(
  db: Kysely<DB>,
  ownerUserId: string,
  startsAtIso: string,
  title?: string,
  people?: string[],
): Promise<Selectable<EventsTable> | undefined> {
  const t = Date.parse(startsAtIso);
  if (!Number.isFinite(t)) return undefined;
  // `coversEmailDerived` can only return true within PROPOSAL_DUP_WINDOW_MS of
  // `t` (its widest branch) — every match is inside this range, so bounding
  // the scan here is safe and turns "every gmail-derived event this owner has
  // ever had" into a same-day slice, regardless of calendar history length.
  // `starts_at` is stored exactly as the caller supplied it (ADR 0074 — a
  // bare datetime gets a real offset, but that offset is never normalized to
  // UTC), so a plain text `>=`/`<=` against a `.toISOString()` (always `Z`)
  // bound compares apples to oranges — cast both sides to `timestamptz` so
  // Postgres compares true instants, not raw text.
  const lo = new Date(t - PROPOSAL_DUP_WINDOW_MS).toISOString();
  const hi = new Date(t + PROPOSAL_DUP_WINDOW_MS).toISOString();
  const rows = await db
    .selectFrom('events')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .where('deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('gcal_event_id', 'is', null),
        eb.and([eb('chord_uid', 'is not', null), eb('series_id', 'is', null)]),
      ]),
    )
    .where('external_uid', 'is', null)
    .where('all_day', '=', 0)
    .where('source_raw_context', 'like', 'gmail:%')
    .where(sql<boolean>`${textInstant('events.starts_at')} >= ${lo}::timestamptz`)
    .where(sql<boolean>`${textInstant('events.starts_at')} <= ${hi}::timestamptz`)
    .execute();
  const near = rows.filter(
    (r) => r.status !== 'cancelled' && coversEmailDerived(t, title, r.starts_at, r.title),
  );
  if (near.length === 0) return undefined;
  const own = await ownAddressSet(db, ownerUserId);
  for (const r of near) {
    const evidence = await sharesEvidence(
      db,
      ownerUserId,
      own,
      { title, people },
      { title: r.title, provenance: r.source_raw_context, guests: r.guest_emails },
    );
    if (evidence) return r;
  }
  return undefined;
}

/**
 * Retract (expire) still-pending email-derived `create_event` proposals the
 * arriving calendar item covers (near in time AND a matching title or a
 * person in common, ADR 0344). UID-keyed invite proposals are left alone —
 * they reconcile by key. Returns how many were retracted.
 */
export async function retractPendingEmailEventProposalsNear(
  db: Kysely<DB>,
  userId: string,
  startsAtIso: string,
  title?: string,
  people?: string[],
): Promise<number> {
  const t = Date.parse(startsAtIso);
  if (!Number.isFinite(t)) return 0;
  const pending = await pendingEmailEventProposals(db, userId);
  const near = pending.filter(
    (p) => !p.args.externalUid && coversEmailDerived(t, title, p.args.startsAt, p.args.title),
  );
  const own = near.length > 0 ? await ownAddressSet(db, userId) : new Set<string>();
  const hits: typeof near = [];
  for (const p of near) {
    const evidence = await sharesEvidence(
      db,
      userId,
      own,
      { title, people },
      { title: p.args.title, provenance: p.provenance, guests: p.args.invitees },
    );
    if (evidence) hits.push(p);
  }
  await expireProposals(db, hits.map((p) => p.id));
  await markRetractedSourcesRead(db, userId, hits.map((p) => p.provenance));
  return hits.length;
}

/**
 * Apply an iTIP cancellation (METHOD:CANCEL / STATUS:CANCELLED) by UID:
 * expire the pending UID-keyed proposal, and cancel the owner's event copy
 * carrying that UID. `local_dirty` is set so a Chord-pushed copy propagates
 * the cancel to Google on the next push; a Google-synced copy converges from
 * the Google side too — cancelling both ways is idempotent.
 */
/** Expire pending UID-keyed invite proposals for `uid`. Returns the count. */
export async function retractPendingProposalsByUid(
  db: Kysely<DB>,
  userId: string,
  uid: string,
): Promise<number> {
  const pending = await pendingEmailEventProposals(db, userId);
  const hits = pending.filter((p) => p.args.externalUid === uid);
  await expireProposals(db, hits.map((p) => p.id));
  await markRetractedSourcesRead(db, userId, hits.map((p) => p.provenance));
  return hits.length;
}

export async function applyInviteCancellation(
  db: Kysely<DB>,
  userId: string,
  uid: string,
): Promise<{ proposalsRetracted: number; eventsCancelled: number }> {
  const retracted = await retractPendingProposalsByUid(db, userId, uid);

  const cancelled = await db
    .updateTable('events')
    .set({ status: 'cancelled', local_dirty: 1, updated_at: new Date().toISOString() })
    .where('owner_user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .where((eb) => eb.or([eb('ical_uid', '=', uid), eb('external_uid', '=', uid)]))
    .executeTakeFirst();

  return { proposalsRetracted: retracted, eventsCancelled: Number(cancelled.numUpdatedRows) };
}

/**
 * Sweep half of "invite wins": a pending email-derived event proposal whose
 * slot is ALREADY covered by a real event on the user's calendar (matching
 * UID, or covered per the window rules above) is stale — the appointment
 * exists. Runs with the magics consolidation sweep, so a proposal orphaned by
 * an earlier miss (e.g. the invite arrived while its proposal drifted hours
 * off) still clears on the next sync.
 */
export async function retractProposalsCoveredByExistingEvents(
  db: Kysely<DB>,
  userId: string,
): Promise<number> {
  const pending = await pendingEmailEventProposals(db, userId);
  if (pending.length === 0) return 0;

  // A UID-keyed proposal matches an event by UID alone, with no time bound
  // (the invite's own date may have been corrected since), so that branch
  // needs a targeted-but-unbounded lookup. Everything else can only match
  // within PROPOSAL_DUP_WINDOW_MS of its own startsAt (coversEmailDerived's
  // widest branch), so THAT scan is bounded to the pending set's date range —
  // together, neither query reads the user's whole event history, which
  // otherwise grows unboundedly over the life of the account.
  const uids = [...new Set(pending.map((p) => p.args.externalUid).filter((u): u is string => !!u))];
  const starts = pending
    .filter((p) => !p.args.externalUid)
    .map((p) => Date.parse(p.args.startsAt))
    .filter((n) => Number.isFinite(n));

  const eventsByUid =
    uids.length > 0
      ? await db
          .selectFrom('events')
          .select(['title', 'starts_at', 'ends_at', 'location', 'ical_uid', 'external_uid', 'status', 'guest_emails'])
          .where('owner_user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .where('all_day', '=', 0)
          .where((eb) => eb.or([eb('external_uid', 'in', uids), eb('ical_uid', 'in', uids)]))
          .execute()
      : [];
  const eventsInRange =
    starts.length > 0
      ? await db
          .selectFrom('events')
          .select(['title', 'starts_at', 'ends_at', 'location', 'ical_uid', 'external_uid', 'status', 'guest_emails'])
          .where('owner_user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .where('all_day', '=', 0)
          // Cast both sides to timestamptz — `starts_at` is stored with
          // whatever offset the caller gave it (ADR 0074), never normalized
          // to UTC, so a raw text compare against a `.toISOString()` (`Z`)
          // bound is not reliably chronological. See findEmailEventTwin.
          .where(
            sql<boolean>`${textInstant('events.starts_at')} >= ${new Date(Math.min(...starts) - PROPOSAL_DUP_WINDOW_MS).toISOString()}::timestamptz`,
          )
          .where(
            sql<boolean>`${textInstant('events.starts_at')} <= ${new Date(Math.max(...starts) + PROPOSAL_DUP_WINDOW_MS).toISOString()}::timestamptz`,
          )
          .execute()
      : [];
  const events = [...eventsByUid, ...eventsInRange];
  const live = events.filter((e) => e.status !== 'cancelled');
  const hits = pending
    .filter((p) =>
      live.some((e) => {
        // A UID-keyed invite proposal retracts ONLY on its UID (the event is
        // already on the calendar — e.g. accepted Google-side); fuzzy title
        // matching must not kill it, since a keyless same-title event may be
        // the twin it is meant to ADOPT at confirm.
        if (p.args.externalUid) {
          return p.args.externalUid === e.external_uid || p.args.externalUid === e.ical_uid;
        }
        const t = Date.parse(e.starts_at);
        if (!Number.isFinite(t)) return false;
        // Confirming this card would only merge into the event already there.
        if (
          isSameEvent(
            { title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, location: e.location, guestEmails: e.guest_emails },
            asEventLike(p.args),
          )
        ) {
          return true;
        }
        // Title must match here — bare 60-min proximity to an UNRELATED
        // existing event must not kill a legitimate new suggestion.
        return (
          titlesMatch(e.title, p.args.title) &&
          coversEmailDerived(t, e.title, p.args.startsAt, p.args.title)
        );
      }),
    );
  // ADR 0348 - a meeting card whose meeting arrived as someone else's
  // invitation after it was staged.
  const meetingCards = pending.filter((p) => !hits.includes(p) && !!p.args.invitees?.length && !p.args.externalUid);
  if (meetingCards.length > 0) {
    const { calendarFitFor } = await import('./events/calendar-fit.service.js');
    const fits = await calendarFitFor(
      db,
      userId,
      meetingCards.map((p) => ({
        id: p.id,
        tool_name: 'create_event',
        args_json: JSON.stringify(p.args),
        provenance: p.provenance,
        status: 'pending',
      })),
    );
    for (const p of meetingCards) if (fits.get(p.id)?.already) hits.push(p);
  }
  await expireProposals(db, hits.map((p) => p.id));
  await markRetractedSourcesRead(db, userId, hits.map((p) => p.provenance));
  return hits.length;
}

/**
 * The staging guard's companion sweep (ADR 0137): a pending email-derived
 * event proposal whose start has since passed is retracted.
 *
 * Two things need it. Proposals staged before that guard existed sit on the
 * Action Items tab until their ADR 0009 TTL runs out, and a proposal staged
 * for tomorrow is still pending the day after — a card can outlive its own
 * date, which the staging check alone cannot cover.
 *
 * Deliberately does NOT mark the source mail read, unlike
 * `retractProposalsCoveredByExistingEvents`. That sweep retracts because the
 * appointment EXISTS, so the thread is dealt with; here nothing was ever
 * handled, the moment simply went by, and the mail is still the user's to read.
 */
export async function retractPastEventProposals(
  db: Kysely<DB>,
  userId: string,
  tzOffset?: string,
): Promise<number> {
  const pending = await pendingEmailEventProposals(db, userId);
  const stale = pending.filter(
    (p) => isPastEventStart(p.args.startsAt, tzOffset) || (!!p.args.invitees?.length && hasStarted(p.args.startsAt)),
  );
  await expireProposals(db, stale.map((p) => p.id));
  return stale.length;
}

/**
 * ADR 0158 — the `create_task` twin of `retractPastEventProposals`. A dated
 * to-do proposal whose `dueAt` has already gone by ("confirm attendance for
 * the Sep 5 reservation" surfacing on Sep 11) has nothing left to act on.
 * Undated proposals are never touched, matching ADR 0092's rule that an
 * undated task is never auto-archived either — an absent date isn't a lapsed
 * one.
 */
export async function retractPastTaskProposals(
  db: Kysely<DB>,
  userId: string,
  tzOffset?: string,
): Promise<number> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'args_json'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', 'create_task')
    .where('status', '=', 'pending')
    .where('provenance', 'like', 'gmail:%')
    .execute();
  const stale: string[] = [];
  for (const r of rows) {
    try {
      const args = JSON.parse(r.args_json) as { dueAt?: unknown };
      if (typeof args.dueAt === 'string' && isPastEventStart(args.dueAt, tzOffset)) {
        stale.push(r.id);
      }
    } catch {
      /* unparseable proposal — not our problem here */
    }
  }
  await expireProposals(db, stale);
  return stale.length;
}

interface PendingTripProposalRow {
  id: string;
  toolName: 'create_trip' | 'add_travel_leg' | 'add_accommodation';
  bundleId: string | null;
  args: Record<string, unknown>;
}

async function pendingEmailTripProposals(
  db: Kysely<DB>,
  userId: string,
): Promise<PendingTripProposalRow[]> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'bundle_id', 'args_json'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', 'in', ['create_trip', 'add_travel_leg', 'add_accommodation'])
    .where('status', '=', 'pending')
    .where('provenance', 'like', 'gmail:%')
    .execute();
  const out: PendingTripProposalRow[] = [];
  for (const r of rows) {
    try {
      out.push({
        id: r.id,
        toolName: r.tool_name as PendingTripProposalRow['toolName'],
        bundleId: r.bundle_id,
        args: JSON.parse(r.args_json) as Record<string, unknown>,
      });
    } catch {
      /* unparseable proposal — not our problem here */
    }
  }
  return out;
}

function isTripRowPast(row: PendingTripProposalRow, tzOffset: string | undefined): boolean {
  if (row.toolName === 'add_travel_leg') {
    const departAt = row.args.departAt;
    return typeof departAt === 'string' && isPastEventStart(departAt, tzOffset);
  }
  if (row.toolName === 'add_accommodation') {
    const checkout = row.args.checkoutDate;
    return typeof checkout === 'string' && isPastEventStart(`${checkout}T00:00:00`, tzOffset);
  }
  return false; // create_trip carries no instant of its own — judged by its legs/stays
}

/**
 * ADR 0158 — a staged trip bundle can go stale between staging and confirm (a
 * flight proposed yesterday, still unconfirmed today). Bundle-aware: when
 * EVERY leg/stay in a bundle is past, the whole bundle (including its
 * `create_trip` lead) is retracted — a dangling accommodation confirm with no
 * trip left to attach to is worse than losing the proposal. When only SOME are
 * (a straddling itinerary drifting into its outbound date), only the past
 * rows drop and the bundle keeps its still-ahead members, same as staging time.
 */
export async function retractPastTripProposals(
  db: Kysely<DB>,
  userId: string,
  tzOffset?: string,
): Promise<number> {
  const rows = await pendingEmailTripProposals(db, userId);
  if (rows.length === 0) return 0;

  const byBundle = new Map<string, PendingTripProposalRow[]>();
  const standalone: PendingTripProposalRow[] = [];
  for (const r of rows) {
    if (!r.bundleId) {
      standalone.push(r);
      continue;
    }
    const arr = byBundle.get(r.bundleId) ?? [];
    arr.push(r);
    byBundle.set(r.bundleId, arr);
  }

  const toExpire: string[] = [];
  for (const members of byBundle.values()) {
    const timeBearing = members.filter((m) => m.toolName !== 'create_trip');
    if (timeBearing.length === 0) continue; // nothing staged yet to judge by
    const past = timeBearing.filter((m) => isTripRowPast(m, tzOffset));
    if (past.length === timeBearing.length) {
      toExpire.push(...members.map((m) => m.id)); // whole trip is over
    } else if (past.length > 0) {
      toExpire.push(...past.map((m) => m.id)); // keep the trip, drop the stale legs
    }
  }
  for (const r of standalone) {
    if (isTripRowPast(r, tzOffset)) toExpire.push(r.id);
  }

  await expireProposals(db, toExpire);
  return toExpire.length;
}

/**
 * Has this exact thread already produced a proposal — pending OR already
 * confirmed? Of any tool, or of `toolName` when one is given.
 *
 * A thread is staged from ONCE (ADR 0243). It may yield several suggestions,
 * but they are staged together in one pass, so a proposal already carrying
 * the thread's provenance means a later pass is a re-mine — and a re-mine
 * rephrases. The magics pass asks without a tool for that reason: with
 * several to-dos per thread, "one per tool" would let a second pass add a
 * reworded copy of the second or third.
 *
 * The title-equality checks above cannot see this. Prod mined one Amex email
 * twice inside 2.3 seconds and the model phrased the same obligation two ways
 * — "Confirm income information WITH American Express" and "…FOR American
 * Express credit card" — so two cards asked for one thing. Normalized equality
 * is deliberately exact (ADR 0132's list-item rule) and no amount of loosening
 * catches a rephrase without also merging genuinely different to-dos.
 *
 * Confirmed counts too (ADR 0187): the read-time pass (ADR 0180) and the
 * background sweep both funnel through this gate, each marked to run at most
 * once per thread — but the marks answer "did extraction run", not "is the
 * obligation still open". Checking pending alone meant a thread whose
 * proposal was already confirmed (the user added the task/event) looked
 * exactly like a thread that had never been mined, so any re-run — an
 * extraction-mark wipe, a second server process, a future pass added without
 * remembering this one — would stage and let the user re-confirm a genuine
 * duplicate. Rejected/expired proposals are deliberately NOT included here:
 * "not now" or "too late" both leave the obligation open, unlike "done".
 *
 * The double-mining itself is fixed at its source (the per-user `afterSync`
 * coalescer). This is the invariant that holds regardless: a re-mine after an
 * extraction-mark wipe, or a second server process, would rephrase just the
 * same.
 */
export async function threadAlreadyProposed(
  db: Kysely<DB>,
  userId: string,
  provenance: string,
  toolName?: string,
  /** ADR 0315 — only cards staged at or after this instant (the newest
   *  message read) count: a card from earlier in the conversation answers an
   *  earlier message, not this one. */
  since?: string | null,
): Promise<boolean> {
  const row = await db
    .selectFrom('proposals')
    .select('id')
    .where('proposed_by_user_id', '=', userId)
    .$if(!!since, (qb) =>
      qb.where(sql<boolean>`${textInstant('proposals.created_at')} >= ${since}::timestamptz`),
    )
    .$if(toolName !== undefined, (qb) => qb.where('tool_name', '=', toolName!))
    // Asked without a tool, the question is "has this email's ASK been
    // staged" (ADR 0244). A person or date learned from the same email
    // (ADR 0076) is a different pass answering a different question, and
    // must not read as the email already having its suggestion.
    .$if(toolName === undefined, (qb) => qb.where('tool_name', 'in', [...EMAIL_SUGGESTION_TOOLS]))
    .where('status', 'in', ['pending', 'confirmed'])
    .where('provenance', '=', provenance)
    .executeTakeFirst();
  return !!row;
}

/**
 * The tools an email's own ask is staged as (ADR 0244): what the general
 * extractor emits, and the trip bundle the travel classifier emits instead.
 * One thread gets its suggestions from ONE of those, once.
 */
export const EMAIL_GENERAL_TOOLS = ['create_event', 'create_task', 'add_list_item'] as const;
export const EMAIL_TRIP_TOOLS = ['create_trip', 'add_travel_leg', 'add_accommodation'] as const;
export const EMAIL_SUGGESTION_TOOLS = [...EMAIL_GENERAL_TOOLS, ...EMAIL_TRIP_TOOLS] as const;

/**
 * Run `fn` holding this thread's staging lock (ADR 0244).
 *
 * "Is anything staged from this thread?" followed by "then stage" is a
 * check-then-insert, and the sweep and the read-time pass reach the same
 * thread from two processes. Without the lock both read "nothing yet" and
 * both stage. Transaction-scoped, the only advisory-lock form that survives
 * transaction-mode pooling (ADR 0038); two-int form for ADR 0165's reason.
 * Held only around the check and the inserts, never across a model call.
 */
export async function withThreadStagingLock<T>(
  db: Kysely<DB>,
  userId: string,
  provenance: string,
  fn: (trx: Kysely<DB>) => Promise<T>,
): Promise<T> {
  const run = async (trx: Kysely<DB>): Promise<T> => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${provenance}))`.execute(trx);
    return fn(trx);
  };
  return transactionThen(db, run);
}

/**
 * Run `fn` holding the thread's staging lock AND this user's (ADR 0244
 * addendum). The thread lock stops two passes over ONE email both staging;
 * the user lock stops two DIFFERENT emails with the same ask (a confirmation
 * and its reminder, one message in two mailboxes) both reading "no card for
 * this yet" before either wrote one. The duplicate checks that compare
 * against other threads' cards must therefore run inside `fn`.
 *
 * Always thread first, then user, so it cannot deadlock against a caller
 * holding only the thread lock. Never held across a model call.
 */
export async function withEmailStagingLocks<T>(
  db: Kysely<DB>,
  userId: string,
  provenance: string,
  fn: (trx: Kysely<DB>) => Promise<T>,
): Promise<T> {
  return withThreadStagingLock(db, userId, provenance, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext('email-staging:user'))`.execute(trx);
    return fn(trx);
  });
}

/**
 * ADR 0315 — the conversation moved on. A newer message in this thread just
 * produced its own card, so a still-pending event / to-do / list card staged
 * from an earlier message ("Reply to Irene with times" once he has
 * agreed to 10 AM Thursday) answers a question nobody is asking any more.
 * Pending only, same reasoning as the trip-wins retraction below. Runs inside
 * the caller's staging lock.
 */
export async function retractSupersededEmailProposals(
  trx: Kysely<DB>,
  userId: string,
  provenance: string,
  before: string,
): Promise<number> {
  const res = await trx
    .updateTable('proposals')
    .set({ status: 'expired', resolved_at: new Date().toISOString() })
    .where('proposed_by_user_id', '=', userId)
    .where('provenance', '=', provenance)
    .where('status', '=', 'pending')
    .where('bundle_id', 'is', null)
    .where('tool_name', 'in', [...EMAIL_GENERAL_TOOLS])
    .where(sql<boolean>`${textInstant('proposals.created_at')} < ${before}::timestamptz`)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/**
 * "Trip wins" (ADR 0244): the travel classifier has claimed this thread, so
 * a still-pending event / to-do / list card the general extractor staged
 * from the SAME email is the same booking in a worse shape, and goes.
 *
 * Pending only. A card the user already confirmed is a real calendar event
 * now, and the trip's own flight event folds into it (ADR 0223) rather than
 * anything here deleting what a person approved. Keyed on the thread, so a
 * to-do from a different email about the same trip is untouched.
 */
export async function retractGeneralProposalsForThread(
  db: Kysely<DB>,
  userId: string,
  provenance: string,
): Promise<number> {
  return withThreadStagingLock(db, userId, provenance, async (trx) => {
    const res = await trx
      .updateTable('proposals')
      .set({ status: 'expired', resolved_at: new Date().toISOString() })
      .where('proposed_by_user_id', '=', userId)
      .where('provenance', '=', provenance)
      .where('status', '=', 'pending')
      .where('bundle_id', 'is', null)
      .where('tool_name', 'in', [...EMAIL_GENERAL_TOOLS])
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  });
}
