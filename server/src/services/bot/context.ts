import { describeAnswers, eventGuestAnswers, eventsWithGuestAnswers, waitingInvitations } from '../events/guest-answers.js';
import type { Kysely } from 'kysely';

import { flightDesignator } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import type { LlmMessage } from '../llm/types.js';
import { getDefaultPersona } from '../bot-personas.service.js';
import {
  listEvents,
  listRsvpsForEvents,
} from '../events.service.js';
import { openItemSamples } from '../lists.service.js';
import { loadRecordCounts } from '../record-counts.service.js';
import { familyFactsForContext, type ContextFact } from '../memory.service.js';
import { listImportantDayOccurrences, listPeopleForUser } from '../people.service.js';
import { listSaves, listSavesForUser } from '../saves.service.js';
import { listTasks, listTasksForUser } from '../tasks.service.js';
import { findUpcomingLegs } from '../trips.service.js';
import { findCalendarFlights } from './calendar-flights.js';
import { cityFromTimezone } from '../geo/location.js';
import { localWhen, offsetScheduleNote, ownWhen, svWall, upcomingDatesTable, weekdayOf } from '../../utils/tz.js';
import { FULLTEXT_DOC_CAP, type AttachmentWithExcerpts } from './retrieval.js';
import { getPendingFanout } from './pending-fanout.js';
import { getLastEvent } from './pending-last-event.js';
import { listPendingTripTravelers } from './pending-trip-travelers.js';
import { listPendingInvitees } from './pending-invites.js';
import { activeSkillBlock, skillCatalogueBlock, skillTurnBlock } from './skills/prompt.js';
import type { SkillTurnNote } from './skills/reply.js';
import { factsForMessage, turnFactsBlock } from './turn-facts.js';
import { MAIL_QUESTION_RECIPES, NATIVE_TOOL_PROMPT, TEXT_FENCE_TOOL_PROMPT } from './tools.js';

const HISTORY_LIMIT = 30; // hard cap on messages pulled from the DB
const HISTORY_MAX_AGE_DAYS = 3; // drop messages older than this…
const HISTORY_MIN_MESSAGES = 20; // …but always keep at least this many
const GAP_MARKER_HOURS = 12; // gaps wider than this get a "[N later]" separator

type ConvoRow = {
  id: string;
  senderId: string | null;
  kind: string;
  body: string;
  createdAt: string;
  username: string | null;
  displayName: string | null;
};

/**
 * Recency window with a floor: keep messages newer than HISTORY_MAX_AGE_DAYS,
 * but never drop below the last HISTORY_MIN_MESSAGES so a group that's been
 * quiet for weeks doesn't strand the bot with no conversational state.
 * `rows` must be oldest→newest.
 */
function windowByRecency<T extends { createdAt: string }>(rows: T[], now = Date.now()): T[] {
  const cutoff = now - HISTORY_MAX_AGE_DAYS * 86_400_000;
  return rows.filter(
    (m, i) => i >= rows.length - HISTORY_MIN_MESSAGES || new Date(m.createdAt).getTime() >= cutoff,
  );
}

/** Coarse human label for a time gap, e.g. "3 days", "18 hours". */
function formatGap(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1) return `${hours} hours`;
  return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
}

/**
 * Render kept messages as LLM turns, oldest→newest. Inserts a system-role
 * separator before any message whose gap from the previous one exceeds
 * GAP_MARKER_HOURS, and marks the triggering message so the model answers the
 * latest turn rather than an older one that's still in the window.
 */
function buildConvo(rows: ConvoRow[], triggerMessageId: string): LlmMessage[] {
  const out: LlmMessage[] = [];
  let prevTime: number | null = null;
  for (const m of rows) {
    const t = new Date(m.createdAt).getTime();
    if (prevTime !== null) {
      const gap = t - prevTime;
      if (gap >= GAP_MARKER_HOURS * 3_600_000) {
        out.push({ role: 'system', content: `[${formatGap(gap)} later]` });
      }
    }
    prevTime = t;

    const isBot = m.kind === 'bot' || m.senderId === null;
    if (isBot) {
      out.push({ role: 'assistant', content: m.body });
      continue;
    }
    const name = m.displayName || m.username || 'user';
    const marker = m.id === triggerMessageId ? '→ (latest, respond to this) ' : '';
    out.push({ role: 'user', content: `${marker}${name}: ${m.body}` });
  }
  return out;
}

/**
 * ADR 0021 — render attachments as filename + summary + matched excerpts
 * (ts_rank_cd-ranked paragraph chunks). Replaces the front-of-file content dump.
 * Excerpts come pre-marked from ts_headline() with «match» / `…`
 * markers so the model can see what it was given vs. what was truncated.
 */
// The top few most-relevant docs get their full extracted text inlined (up to
// FULLTEXT_CHAR_BUDGET each) so content-level asks — "summarize it", "when did
// he get rubella" — work even when the query keywords don't snippet-match the
// exact line. Lower-ranked docs fall back to ranked excerpts to bound tokens.
// FULLTEXT_DOC_CAP is owned by retrieval.ts (it decides which docs to hydrate);
// imported here so the inlining cap and hydration cap stay in lockstep.
const FULLTEXT_CHAR_BUDGET = 24_000;

function attachmentBlock(atts: AttachmentWithExcerpts[]): string {
  if (atts.length === 0) return '';
  const blocks = atts.map((a, idx) => {
    const star = a.pinned ? '★ ' : '';
    const uploaded = a.created_at.slice(0, 10); // YYYY-MM-DD
    const body: string[] = [];
    if (a.blobMissing) {
      body.push(
        '(the ORIGINAL FILE is no longer stored on the server — content below is from before it was lost. You can still answer FROM this text, but never say the file is "on file"/available, never offer to send it, and never call send_file or reference_file on this id — tell the user it would need to be re-uploaded.)',
      );
    }
    if (a.indexedAt === null) {
      body.push(
        '(still indexing — content not yet available; tell the user the file is being read and ask them to retry in a moment)',
      );
    } else {
      const summary = a.summary?.trim();
      if (summary) body.push(`Summary: ${summary}`);
      const fullText = a.extractedText?.trim();
      if (idx < FULLTEXT_DOC_CAP && fullText) {
        const clipped =
          fullText.length > FULLTEXT_CHAR_BUDGET
            ? `${fullText.slice(0, FULLTEXT_CHAR_BUDGET)}\n…[text truncated]`
            : fullText;
        body.push('Full text (you CAN read this — answer and summarize directly from it):');
        body.push(clipped);
      } else if (a.excerpts.length > 0) {
        body.push('Excerpts (use these to answer; «match» markers show search hits):');
        for (const e of a.excerpts) {
          body.push(`  • ${e.snippet}`);
        }
      } else if (!summary) {
        body.push('(no extractable text)');
      }
    }
    const indented = body.join('\n').split('\n').map((l) => `  ${l}`).join('\n');
    return `- ${star}${a.filename} · uploaded ${uploaded} · id ${a.id}\n${indented}`;
  });
  return [
    'Files available in this chat (you CAN read the contents shown below):',
    'When a file answers the question, just answer it directly and naturally. Do NOT preface with "based on the file", "according to the document", "from the attachment", or similar meta-commentary — the user wants the answer, not a citation of where you looked.',
    'Only name a specific file when it genuinely helps — e.g. to disambiguate when two files disagree (then prefer the more recent upload date and say so briefly, like "per the May 2 itinerary…").',
    'When the user asks you to send / give / share a file ("give me the calendar PDF", "send me the file"), call send_file with that file\'s id. NEVER paste, build, or invent a URL/link for a file — there is no public link, and save_link is for external web pages, not files already in this chat.',
    'When you confirm that a SPECIFIC file exists or answer FROM one ("do you have my insurance cards?", "what does the lease say?"), also call reference_file with its id (unless it is noted as no longer stored, above) so a tappable card is attached to your reply — never just say a file is "on file"/available with nothing for the user to open. Skip this for a vague or multi-file answer where no one file is the point.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

export function localTimeBlock(tz: string | null | undefined): string {
  // Always emit today's date — even when no timezone is known. The LLM
  // hallucinates current-year off its training cutoff if we don't pin
  // it explicitly. tz-less callers (Telegram inbound from a user who's
  // never opened the app) fall back to UTC; the date will be correct
  // to within ~12h either side, which is enough to avoid 2024 hits.
  try {
    const effectiveTz = tz && tz.trim() ? tz : 'UTC';
    const now = new Date();
    // sv-SE gives "YYYY-MM-DD HH:MM:SS" wall-clock time in any IANA zone
    const localStr = svWall(now, effectiveTz);
    const utcStr = svWall(now, 'UTC');
    const offsetMin = Math.round(
      (Date.parse(localStr.replace(' ', 'T') + 'Z') - Date.parse(utcStr.replace(' ', 'T') + 'Z')) / 60000,
    );
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    const year = localStr.slice(0, 4);
    const todayDate = localStr.slice(0, 10);
    const tzLabel = tz && tz.trim() ? tz : 'UTC (no per-user timezone on record)';
    return [
      `**TODAY IS ${weekdayOf(todayDate)} ${todayDate}.** Today's year is ${year}. Do not infer "today" from your training data.`,
      `Weekday → date for the next two weeks: ${upcomingDatesTable(todayDate)}. For "Monday", "this Friday", "next Tuesday" etc., look the date up in this list; never compute a weekday or date yourself, and when you name a date also name its weekday exactly as listed.`,
      `The user's current local time is ${localStr.replace(' ', 'T')}${sign}${hh}:${mm} (${tzLabel}). Always include the user's timezone offset in datetime fields: the offset for THAT date, which is ${offsetScheduleNote(effectiveTz, now)}.`,
      `When the USER gives a bare date with no year ("June 7", "next Friday", "the 12th"), use the year from TODAY above. If the resulting date already passed this year, roll to the next occurrence (typically ${year} or ${Number(year) + 1}).`,
      `EXCEPTION: when you are quoting a date from a stored record (an event from the system prompt, an attachment summary, a memory, a saved item), use the year exactly as it appears in that source — historical dates stay historical. The current-year rule is for parsing user relative phrases, NOT for re-rooting facts.`,
    ].join(' ');
  } catch {
    return '';
  }
}

/**
 * PR-G — Group roster. Lists everyone in the room so the bot knows who it
 * can address by name without trawling the 30-message window. Marks the
 * triggering user with "(you)" so the model can disambiguate "I" vs.
 * other members. Shadow users (auto-created from imports / connectors)
 * are included since they're real participants in the bridged chat.
 */
async function groupRosterBlock(
  db: Kysely<DB>,
  groupId: string,
  triggeringUserId: string,
): Promise<string> {
  const rows = await db
    .selectFrom('group_members')
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .where('group_members.group_id', '=', groupId)
    .select([
      'users.id as id',
      'users.username as username',
      'users.display_name as displayName',
      'group_members.role as role',
    ])
    .execute();
  if (rows.length === 0) return '';
  const lines = rows.map((r) => {
    const name = r.displayName || r.username;
    const youTag = r.id === triggeringUserId ? ' (you, the speaker)' : '';
    const ownerTag = r.role === 'owner' ? ' [owner]' : '';
    return `  - ${name}${youTag}${ownerTag}`;
  });
  const out = ['Members of this group:', ...lines];

  // ADR 0151 — managed personas (a kid, a grandparent): not accounts, but they
  // can be the assignee of a task or the subject of a calendar item.
  const memberNames = new Map(rows.map((r) => [r.id, r.displayName || r.username]));
  const personas = await db
    .selectFrom('personas')
    .select(['name', 'household_role', 'managed_by'])
    .where('group_id', '=', groupId)
    .where('is_managed', '=', 1)
    .orderBy('created_at', 'asc')
    .execute();
  if (personas.length > 0) {
    out.push('Managed family members (can be given tasks / calendar items by name):');
    for (const p of personas) {
      const by = p.managed_by ? memberNames.get(p.managed_by) : null;
      out.push(`  - ${p.name} (${p.household_role}${by ? `, managed by ${by}` : ''})`);
    }
  }
  return out.join('\n');
}

/**
 * PR-G — Group snapshot. A terse one-line-per-bucket view of what the
 * group has on file, plus up to three sample titles per bucket. The
 * bot uses this to know whether it's worth calling list_tasks /
 * search_saves at all (ADR 0005's iterative loop makes the deeper
 * lookup cheap, but only if the bot knows what's there).
 *
 * Every NUMBER here is exact (counted in SQL over the whole scope, ADR
 * 0290); the titles beside them are samples. In the personal 1:1 the scope
 * is every group the user belongs to (ADR 0096's read rule) and each line
 * names its group; in a shared group it is that group only (ADR 0004).
 */
async function groupSnapshotBlock(
  db: Kysely<DB>,
  groupId: string,
  crossGroupUserId: string | null,
): Promise<string> {
  // Samples only: a turn cannot carry a family's whole record, which is why
  // the counts come from loadRecordCounts rather than these arrays.
  // Each sample query reads only as many rows as the block prints.
  const cross = crossGroupUserId !== null;
  const countsP = loadRecordCounts(db, cross ? { userId: crossGroupUserId } : { groupId });
  const [counts, tasks, itemSamples, saves, trips] = await Promise.all([
    countsP,
    // Open and active tasks sort first, so the first rows are the live ones.
    cross
      ? listTasksForUser(db, crossGroupUserId, { limit: TASK_SAMPLES })
      : listTasks(db, groupId, { withNames: false, limit: TASK_SAMPLES }),
    countsP.then((c) =>
      openItemSamples(db, c.lists.slice(0, LIST_LINES).map((l) => l.id), ITEM_SAMPLES),
    ),
    cross
      ? listSavesForUser(db, crossGroupUserId, { withNames: false, limit: SAVE_SAMPLES })
      : listSaves(db, groupId, { withNames: false, limit: SAVE_SAMPLES }),
    liveTripSamples(db, groupId),
  ]);
  const openTasks = tasks.filter((t) => t.status === 'open' || t.status === 'active');
  const groupNames = cross
    ? await groupNameMap(db, [...counts.lists.map((l) => l.groupId), ...saves.map((s) => s.groupId)])
    : new Map<string, string>();
  const where = (gid: string) => (cross ? ` [${clip(groupNames.get(gid) ?? 'another group', 40)}]` : '');

  const lines: string[] = [];
  if (counts.openTasks > 0) {
    const samples = openTasks.slice(0, 3).map((t) => `"${clip(t.title, 60)}"`).join(', ');
    lines.push(`Tasks (${counts.openTasks} open): ${samples}`);
  }
  if (counts.lists.length > 0) {
    lines.push(`Lists (${counts.lists.length}):`);
    for (const l of counts.lists.slice(0, LIST_LINES)) {
      const items = (itemSamples.get(l.id) ?? []).map((t) => clip(t, 60)).join(', ');
      const tally = `${l.open} open${l.done > 0 ? `, ${l.done} done` : ''}`;
      const more = l.open > ITEM_SAMPLES ? ` (+${l.open - ITEM_SAMPLES} more — call get_list)` : '';
      lines.push(`  - "${clip(l.name, 60)}"${where(l.groupId)} — ${tally}${items ? `: ${items}${more}` : ''}`);
    }
    if (counts.lists.length > LIST_LINES) {
      lines.push(`  - …and ${counts.lists.length - LIST_LINES} more lists (get_list with no name lists them all)`);
    }
  }
  if (counts.saves.total > 0) {
    // Render saves with kind + tags + city (when present) so questions
    // like "where should we go for date night" can match a place saved
    // with tags=['restaurant','date night'] without needing a tool call.
    lines.push(`Saves (${counts.saves.total}):`);
    lines.push(`  by kind: ${counts.saves.byKind.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    if (counts.saves.byTag.length > 0) {
      lines.push(
        `  by tag: ${counts.saves.byTag
          .slice(0, TAG_COUNTS)
          .map(([t, n]) => `${clip(t, 30)} ${n}`)
          .join(', ')}${counts.saves.byTag.length > TAG_COUNTS ? ', …' : ''}`,
      );
    }
    for (const s of saves) {
      const parts: string[] = [`[${s.kind}]`, `"${clip(s.title, 60)}"`];
      if (s.tripLabel) parts.push(`(${s.tripLabel})`);
      if (s.tags && s.tags.length > 0) parts.push(`tags: ${s.tags.slice(0, 5).join(', ')}`);
      if (s.note) parts.push(`— ${clip(s.note, 80)}`);
      lines.push(`  - ${parts.join(' ')}${where(s.groupId)}`);
    }
    if (counts.saves.total > SAVE_SAMPLES) {
      lines.push(`  - …${counts.saves.total - SAVE_SAMPLES} more saves (search_saves finds them)`);
    }
  }
  if (trips.total > 0) {
    const samples = trips.samples
      .map((t) => `"${clip(t.name, 50)}" (${t.start_date}→${t.end_date})`)
      .join(', ');
    lines.push(`Trips (${trips.total}): ${samples}`);
  }
  if (lines.length === 0) return '';
  return [
    "Group's record (every COUNT below is exact and complete — answer \"how many\" from the counts; the TITLES are samples, cut off and possibly stale. Never act on a whole list or every save from these samples: call get_list / search_saves, or move_list_to_saves to move a list. For recommendation questions — \"where should we go\", \"what should we watch\", \"any restaurants\" — treat the saved places/media/links and list items below as first-class candidates without needing a tool call. BUT when the user asks what is literally ON a specific list or what their tasks are (\"what's on my grocery list?\", \"what's left to buy?\", \"what tasks do I have?\"), do NOT answer from these samples or from the chat history — call get_list / list_tasks to read the live database, because items may have been added or checked off elsewhere and these samples are cut off):",
    ...lines,
  ].join('\n');
}

const LIST_LINES = 25;
const TAG_COUNTS = 15;
const TASK_SAMPLES = 3;
const ITEM_SAMPLES = 8;
const SAVE_SAMPLES = 30;
const TRIP_SAMPLES = 3;

/** The group's trips that are neither deleted nor cancelled: how many, and
 *  the first few by start date. */
async function liveTripSamples(
  db: Kysely<DB>,
  groupId: string,
): Promise<{ total: number; samples: Array<{ name: string; start_date: string; end_date: string }> }> {
  const live = db
    .selectFrom('trips')
    .where('group_id', '=', groupId)
    .where('deleted_at', 'is', null)
    .where('cancelled_at', 'is', null);
  const [count, samples] = await Promise.all([
    live.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst(),
    live.select(['name', 'start_date', 'end_date']).orderBy('start_date', 'asc').limit(TRIP_SAMPLES).execute(),
  ]);
  return { total: Number(count?.n ?? 0), samples };
}

async function groupNameMap(db: Kysely<DB>, groupIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(groupIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom('groups').select(['id', 'name']).where('id', 'in', ids).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * The family-profile facts that are shared with the whole group — household
 * facts and facts about a managed persona (a kid, a grandparent). Safe to use
 * in a reply to anyone in the group (unlike the per-member memories above).
 */
function familyFactsBlock(facts: ContextFact[]): string {
  if (facts.length === 0) return '';
  const lines = facts.map(
    (f) => `- ${f.subjectLabel} · ${f.category} · ${f.key}: ${f.value}`,
  );
  return `Facts about the family (from "About this family" — shared with the whole group, fine to use):\n${lines.join('\n')}`;
}

async function eventsBlock(
  db: Kysely<DB>,
  groupId: string,
  tz: string | null | undefined,
  viewerId: string | null,
): Promise<string> {
  const events = await listEvents(db, groupId);
  if (events.length === 0) return '';
  const now = Date.now();
  // Include events from the last 7 days through the future (covers recent potlucks etc.)
  const relevant = events.filter(
    (e) => new Date(e.startsAt).getTime() >= now - 7 * 24 * 60 * 60 * 1000,
  );
  if (relevant.length === 0) return '';
  // One batched RSVP query for all relevant events (was an N+1 — one query
  // per event inside the loop).
  const rsvpsByEvent = await listRsvpsForEvents(db, relevant.map((e) => e.id));
  // ADR 0328 — guests' own answers from the organizer's calendar, for the
  // few events that have any (one query finds them).
  const answered = await eventsWithGuestAnswers(db, relevant.map((e) => e.id));
  const answersByEvent = new Map<string, string>();
  for (const id of answered) {
    const a = await eventGuestAnswers(db, id, viewerId ?? '');
    if (a.length > 0) answersByEvent.set(id, describeAnswers(a));
  }
  const lines: string[] = [
    'Upcoming events in this group (use these IDs when calling record_rsvp). ' +
      "Times are already in the user's own time zone, with the weekday — quote " +
      'them as shown; never call a time UTC or work out a weekday yourself:',
  ];
  for (const e of relevant) {
    const rsvps = rsvpsByEvent.get(e.id) ?? [];
    const when = localWhen(e.startsAt, tz);
    const loc = e.location ? ` @ ${e.location}` : '';
    lines.push(`- [${e.id}] "${e.title}"${loc} — ${when}`);
    const answers = answersByEvent.get(e.id);
    if (answers) lines.push(`  Invitation answers: ${answers}`);
    if (rsvps.length > 0) {
      const summary = rsvps.map((r) => `${r.displayName}: ${r.status}${r.dish ? ` (${r.dish})` : ''}`).join(', ');
      lines.push(`  RSVPs: ${summary}`);
    } else {
      lines.push(`  RSVPs: none yet`);
    }
  }
  return lines.join('\n');
}

/**
 * ADR 0157 invitees still waiting on an email (ADR 0166). This exists
 * because a tool result does not survive a turn (ADR 0093 — `buildConvo`
 * replays prose only) — without a structural reminder here, a later plain
 * "Karl's email is x@y.com" has no imperative verb and nothing ties it back
 * to the bot's own earlier sentence, so the model has no forced reason to
 * call update_event at all.
 */
/**
 * ADR 0328 — invitations the asker was sent to family members' group events,
 * with their answer so far, so "I can't make it" lands on the right one
 * through `answer_invitation`.
 */
async function waitingInvitationsBlock(
  db: Kysely<DB>,
  userId: string,
  tz: string | null | undefined,
): Promise<string> {
  const waiting = await waitingInvitations(db, userId, 10);
  if (waiting.length === 0) return '';
  const word = { accepted: 'you said yes', tentative: 'you said maybe', declined: 'you said no', needsAction: 'not answered yet' };
  return [
    'Invitations waiting for you (answer with answer_invitation, using the id):',
    ...waiting.map((w) => `- [${w.id}] "${w.title}" — ${localWhen(w.startsAt, tz)} — ${word[w.response]}`),
  ].join('\n');
}

async function pendingInviteesBlock(db: Kysely<DB>, groupId: string, userId: string): Promise<string> {
  const items = await listPendingInvitees(db, groupId, userId);
  if (items.length === 0) return '';
  const lines = items.map((i) => `- "${i.name}" for event "${i.eventTitle}" (id ${i.eventId})`);
  return (
    'Invitees still waiting on an email address (asked for via an "Add from Contacts" card — ' +
    'never guess or invent one):\n' +
    lines.join('\n') +
    '\nIf THIS message supplies an email address for one of these people — in any form, not ' +
    'just an imperative one ("their email is x@y.com", a bare address, a contact-picker reply) ' +
    '— call update_event for that event id right away with invitees: ["that address"]. Do not ' +
    'wait for the user to ask again.'
  );
}

/**
 * ADR 0232 - a personal event just offered to a group and not yet answered.
 * Same reason as the invitees block above: the offer was made through a tool
 * result, which does not survive a turn, so a later bare "yes" would have
 * nothing to point at. Names only - never ids (ADR 0032).
 */
/**
 * The event this chat made a message ago, so "for tomorrow" or "on the
 * Rudderstack calendar instead" changes it rather than making another one
 * (prod 2026-11-17: three meetings, three invitations).
 */
async function lastEventBlock(db: Kysely<DB>, groupId: string, userId: string, tz: string | null | undefined): Promise<string> {
  const last = await getLastEvent(db, groupId, userId);
  if (!last) return '';
  return (
    `The event you made last in this chat: "${last.title}", ${localWhen(last.startsAt, tz)} (event id ${last.eventId}` +
    (last.invitees.length ? `, guests ${last.invitees.join(', ')}` : '') +
    '). If THIS message corrects it in any words ("for tomorrow", "make it 3pm", "on the X calendar instead", ' +
    '"add a Meet", "also invite Y"), call update_event with that event id and only what changes - never a second ' +
    'create_event, which would send the guests a second invitation.'
  );
}

async function pendingFanoutBlock(db: Kysely<DB>, groupId: string, userId: string): Promise<string> {
  const offer = await getPendingFanout(db, groupId, userId);
  if (!offer) return '';
  const where =
    offer.groups.length === 1
      ? `the "${offer.groups[0]}" group`
      : `one of: ${offer.groups.map((g) => `"${g}"`).join(', ')}`;
  const what =
    offer.kind === 'trip'
      ? `the trip "${offer.title}" (currently on the user's own account only), so the people in it can see who is travelling when`
      : `the event "${offer.title}" (currently on the user's own calendar only), so everyone in it gets it`;
  const tool = offer.kind === 'trip' ? 'share_trip' : 'share_event';
  return (
    `You just offered to put ${what} on ${where}, and are waiting for an answer. ` +
    'If THIS message says yes (in any words: "yes", "sure", "do it", "put it there"), ' +
    `call ${tool}` +
    (offer.groups.length > 1 ? ' with withGroupName set to the group they chose (ask which if they did not say)' : '') +
    '. If it says no, or is about something else, do nothing about it and do not bring it up again.'
  );
}

/** ADR 0289 addendum — trips Chord asked "who is going?" about, still unanswered. */
async function pendingTripTravelersBlock(db: Kysely<DB>, userId: string): Promise<string> {
  const asked = await listPendingTripTravelers(db, userId);
  if (asked.length === 0) return '';
  const lines = asked.map((t) => `- "${t.tripName}" (${t.dates}) — tripId ${t.tripId}`);
  return (
    'You asked who is going on these trips and have no answer yet:\n' +
    lines.join('\n') +
    '\nIf THIS message names who is going (in any words: "it\'s Ben", "Ben Doe", "me and Ada"), ' +
    'call set_trip_passengers with that tripId and those names right away. Anyone can be a ' +
    'traveller - family or a friend, with or without a Chord account. If several trips are waiting and it is unclear which one ' +
    'they mean, ask which.'
  );
}

/** ADR 0138 — how far ahead a flight is still something you are about to do. */
const FLIGHT_WINDOW_BACK_MS = 6 * 60 * 60 * 1000;
const FLIGHT_WINDOW_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const TRAVEL_BLOCK_MAX_CHARS = 1800;

/**
 * The family's travel in the window: legs from Trips (every mode, numbered or
 * not), flight-looking calendar events that are not a leg's own copy, and -
 * in the personal 1:1 - flights read out of the user's mail (ADR 0138).
 *
 * A question about a flight is usually asked with the calendar or the Trips
 * tab in mind, so the answer should already be in front of the model rather
 * than behind a tool call it may not think to make. Legs name their
 * passengers: without them "track Ben's flight" had nothing to match, and
 * the model reached for the one flight-shaped string it could tie to a person
 * - a mileage number from memory.
 *
 * Carries the DESIGNATOR and never a URL. The model has no way to build a
 * FlightAware link — that is `suggest_external_action`'s job, and a URL sitting
 * in the prompt is a URL waiting to be copied into prose, where it renders as
 * dead text (`tools.ts`: "The system builds the URL — do not assemble URLs
 * yourself").
 *
 * Scope follows ADR 0096: a shared group sees its own legs and events; the
 * personal 1:1 sees every group the user belongs to, plus their mail, which
 * has no group of its own and is never shown in a shared room (ADR 0084).
 *
 * Bounded in bytes as well as rows, the ADR 0088 rule — a family with a big
 * itinerary must not crowd out the rest of the prompt.
 */
async function upcomingTravelBlock(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; isPersonal: boolean; tz?: string | null },
): Promise<string> {
  const now = Date.now();
  const sinceMs = now - FLIGHT_WINDOW_BACK_MS;
  const untilMs = now + FLIGHT_WINDOW_AHEAD_MS;
  const scope = opts.isPersonal ? undefined : opts.groupId;

  const [legs, calendar] = await Promise.all([
    findUpcomingLegs(db, { userId: opts.userId, groupId: scope, sinceMs, untilMs, limit: 25 }),
    findCalendarFlights(db, {
      userId: opts.userId,
      groupId: scope,
      sinceMs,
      untilMs,
      tz: opts.tz,
      limit: 10,
    }),
  ]);

  // One line per journey, naming everyone on it.
  const byKey = new Map<string, { head: string; tail: string; passengers: string[] }>();
  const seen = new Set<string>();
  for (const l of legs) {
    const designator = l.mode === 'flight' ? flightDesignator(l.carrier, l.flightNo) : null;
    const ident = designator
      ? `${designator}${l.carrier && l.carrier.toUpperCase() !== designator.slice(0, 2) ? ` (${clip(l.carrier, 40)})` : ''}`
      : [l.mode === 'flight' ? 'flight' : l.mode, l.carrier, l.flightNo].filter(Boolean).join(' ') +
        (l.mode === 'flight' && !l.flightNo ? ' (no flight number on file)' : '');
    if (designator) seen.add(designator);
    const key = `${ident}|${l.departAt}`;
    let entry = byKey.get(key);
    if (!entry) {
      const arrives = l.arriveAt ? ` · arrives ${ownWhen(l.arriveAt, opts.tz)}` : '';
      entry = {
        head: `- ${ident} · ${clip(l.origin, 40)}→${clip(l.destination, 40)} · departs ${ownWhen(l.departAt, opts.tz)}${arrives}`,
        tail: ` · trip "${clip(l.tripName, 40)}"`,
        passengers: [],
      };
      byKey.set(key, entry);
    }
    const who = l.passengerName?.trim();
    if (who && !entry.passengers.some((p) => p.toLowerCase() === who.toLowerCase())) {
      entry.passengers.push(clip(who, 40));
    }
  }
  const lines: string[] = [];
  for (const e of byKey.values()) {
    const who = e.passengers.length ? ` · passengers: ${e.passengers.join(', ')}` : '';
    lines.push(`${e.head}${who}${e.tail}`);
  }

  // Trips under way or starting inside the window that have no leg above -
  // a hotel-only trip, or one whose flights are not booked yet.
  const today = new Date(sinceMs).toISOString().slice(0, 10);
  const horizon = new Date(untilMs).toISOString().slice(0, 10);
  let tripQ = db
    .selectFrom('trips')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', opts.userId)
    .where('trips.deleted_at', 'is', null)
    .where('trips.cancelled_at', 'is', null)
    .where('trips.end_date', '>=', today)
    .where('trips.start_date', '<=', horizon)
    .select(['trips.id', 'trips.name', 'trips.destination', 'trips.start_date', 'trips.end_date'])
    .orderBy('trips.start_date', 'asc')
    .limit(10);
  if (scope) tripQ = tripQ.where('trips.group_id', '=', scope);
  const legTrips = new Set(legs.map((l) => l.tripId));
  for (const t of await tripQ.execute()) {
    if (legTrips.has(t.id)) continue;
    const dest = t.destination ? ` to ${clip(t.destination, 40)}` : '';
    lines.push(`- trip "${clip(t.name, 50)}"${dest} · ${t.start_date}→${t.end_date} (no legs in this window — get_trip_status has the details)`);
  }

  for (const c of calendar) {
    if (c.flight && seen.has(c.flight.iata)) continue;
    if (c.flight) seen.add(c.flight.iata);
    const flight = c.flight ? ` · flight ${c.flight.iata}` : '';
    const where = c.location ? ` @ ${clip(c.location, 40)}` : '';
    lines.push(`- calendar event "${clip(c.title, 60)}"${where} · starts ${localWhen(c.startsAt, opts.tz)}${flight}`);
  }

  if (opts.isPersonal) {
    const rows = await db
      .selectFrom('email_threads')
      .select(['subject', 'flight_json'])
      .where('user_id', '=', opts.userId)
      .where('flight_json', 'is not', null)
      .orderBy('last_message_at', 'desc')
      .limit(40)
      .execute();
    for (const r of rows) {
      const f = r.flight_json;
      if (!f?.iata) continue;
      const when = f.departAt ?? f.arriveAt;
      const at = when ? Date.parse(when) : NaN;
      if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
      if (seen.has(f.iata)) continue;
      seen.add(f.iata);
      const route =
        f.origin && f.destination ? ` · ${clip(f.origin, 40)}→${clip(f.destination, 40)}` : '';
      const status = f.status && f.status !== 'on_time' ? ` · ${f.status}` : '';
      lines.push(`- ${f.iata}${route} · departs ${ownWhen(when!, opts.tz)}${status} (from email)`);
    }
  }

  if (lines.length === 0) return '';
  const head =
    "Travel coming up or under way — from the family's Trips and calendar (and, in this 1:1, their email). " +
    'When the user asks about a flight, a trip, or someone\'s travel ("when does Ben land", "track my flight", "what time do we leave"), answer from THIS list first; ' +
    'if what they mean is not here, call get_trip_status or find_events before saying you do not know — never guess a flight number, and never use a frequent-flyer, mileage, confirmation or ticket number as one. ' +
    'For a live tracking link call suggest_external_action with kind="flight_status" — query.passengerName for a person\'s flight, else query.flightNumber with a designator shown here; never write a tracking URL yourself. ' +
    'Leg times marked "local (UTC±hh:mm)" are in the zone they were booked in — state them in THAT zone (e.g. "6:15 AM, UTC-4"); do NOT convert them to the user\'s current zone unless the user explicitly asks. Calendar events and unmarked times are already in the user\'s own zone. Every time carries its weekday — quote it as shown, never work one out yourself, and never call a time "UTC":';
  const out: string[] = [head];
  let budget = TRAVEL_BLOCK_MAX_CHARS;
  for (const l of lines) {
    if (budget - l.length < 0) break;
    budget -= l.length;
    out.push(l);
  }
  return out.join('\n');
}

/**
 * ADR 0032 — `people` and `important_dates` are owner-scoped (no
 * group_id), so the strict per-group filter excludes them from
 * non-personal chats. In the user's own personal chat with the bot
 * (isPersonal=true) there's no one else in the room, so we inline the
 * full set here as durable background context — saves a tool call for
 * questions like "when's mom's birthday?" or "who do I have saved?".
 */
async function personalProfileBlock(
  db: Kysely<DB>,
  userId: string,
): Promise<string> {
  const [people, days] = await Promise.all([
    listPeopleForUser(db, userId),
    listImportantDayOccurrences(db, userId, 60),
  ]);
  if (people.length === 0 && days.length === 0) return '';
  const lines: string[] = [
    "YOUR_SAVED_PEOPLE (only visible in this 1:1 chat — these are people the asker has saved):",
  ];
  if (people.length > 0) {
    lines.push('People:');
    for (const p of people.slice(0, 50)) {
      const note = p.notes ? ` — ${clip(p.notes, 80)}` : '';
      lines.push(`  - ${p.displayName}${note}`);
    }
  }
  if (days.length > 0) {
    lines.push('Important days (next 60 days):');
    for (const d of days.slice(0, 30)) {
      lines.push(`  - ${d.personName} (${d.kind}) — ${d.on}`);
    }
  }
  return lines.join('\n');
}

/**
 * ADR 0091 / 0148 — what Chord thinks the user's location is, so "what's my
 * location?" / "where does Chord think I am?" is answerable without a tool
 * call, and the bot can explain a wrong guess. Personal 1:1 only (it is the
 * asker's own setting). Emitted only when there is something to say.
 */
async function weatherLocationBlock(db: Kysely<DB>, userId: string): Promise<string> {
  const row = await db
    .selectFrom('users')
    .select(['weather_place', 'weather_place_source', 'last_tz', 'weather_ip_place', 'weather_device_place'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row) return '';
  const tzCity = cityFromTimezone(row.last_tz);
  if (!row.weather_place && !row.weather_ip_place && !tzCity) return '';

  const srcLabel =
    row.weather_place_source === 'user'
      ? 'the user set this'
      : row.weather_place_source === 'device'
        ? "from the user's phone location, which they allowed"
        : row.weather_place_source === 'ip'
        ? 'auto-detected from the IP address'
        : row.weather_place_source === 'tz'
          ? 'guessed from the device timezone'
          : null;

  const lines: string[] = ['USER LOCATION (weather + daily briefings; visible only in this 1:1):'];
  lines.push(
    row.weather_place
      ? `- In use: ${row.weather_place}${srcLabel ? ` — ${srcLabel}` : ''}`
      : '- In use: none set yet (weather falls back to the device timezone)',
  );
  const signals: string[] = [];
  if (row.weather_device_place && row.weather_device_place !== row.weather_place) {
    signals.push(`${row.weather_device_place} from the phone's location`);
  }
  if (row.weather_ip_place && row.weather_ip_place !== row.weather_place) {
    signals.push(`${row.weather_ip_place} from the IP address (often wrong on a VPN or private relay)`);
  }
  if (tzCity && tzCity !== row.weather_place) {
    signals.push(`${tzCity} from the device timezone (${row.last_tz})`);
  }
  if (signals.length > 0) lines.push(`- Automatic detection currently sees: ${signals.join('; ')}`);
  lines.push(
    '- To change it: the user can say "set my weather to <city>" or edit Settings → Weather location.',
  );
  return lines.join('\n');
}

function surfaceBlock(
  sourceSurface:
    | {
        platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
      }
    | null
    | undefined,
): string {
  if (!sourceSurface) {
    return [
      'This turn came from the native Chord group itself.',
      'If the user asks you to send or relay something to Telegram, Slack, Discord, or another bridged surface, use the relay tool.',
    ].join('\n');
  }
  return [
    `This turn came from the ${sourceSurface.platform} bridge, not from the native Chord app.`,
    'If the user says "the Chord group", "the group in the app", or "the local group", they mean the native Chord group. Use relay target="chord" for that.',
    `If the user says "here" or "this chat", they usually mean the current ${sourceSurface.platform} surface.`,
  ].join('\n');
}

export async function buildLlmContext(
  db: Kysely<DB>,
  opts: {
    groupId: string;
    isPersonal: boolean;
    triggerMessageId: string;
    triggeringUserId: string;
    attachments: AttachmentWithExcerpts[];
    useNativeTools: boolean;
    tz?: string;
    sourceSurface?:
      | {
          platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
        }
      | null;
    /** The trigger carried an uploaded attachment whose content is auto-filed
     *  separately — the bot's create tools for it are gated, so tell the model. */
    triggerHasAttachment?: boolean;
    triggerAttachmentIsImage?: boolean;
    /** The attachment arrived with no caption/instruction (just the file).
     *  `bot.service.ts`'s `isBareAttachmentUpload` already suppresses a
     *  visible reply for this case PROVIDED no tool fired — but nothing
     *  stopped the model proactively calling a read-only tool like
     *  find_events "to check" and surfacing its result as if it were the
     *  answer, overriding that suppression. Telling it up front removes the
     *  temptation at the source. */
    triggerIsBareUpload?: boolean;
    /** ADR 0299 - this message answered (or skipped) a skill question; the
     *  server already moved the run on (skills/reply.ts). */
    skillTurn?: SkillTurnNote;
  },
): Promise<LlmMessage[]> {
  // Every fetch below reads only from `opts` (none depends on another's
  // result), so they run concurrently instead of one round trip at a time —
  // this is the hottest path in the bot, once per turn. Order in the
  // assembled prompt is fixed afterward, independent of resolution order.
  const wantsGroupContext = !opts.isPersonal;
  const wantsPersonalContext = opts.isPersonal && !!opts.triggeringUserId;
  const [
    messages,
    memories,
    famFacts,
    roster,
    snapshot,
    evtBlock,
    profile,
    locBlock,
    flights,
    invites,
    waitingInvites,
    fanout,
    lastEvent,
    tripTravelers,
    skillCatalogue,
    runningSkill,
  ] = await Promise.all([
    db
      .selectFrom('messages')
      .leftJoin('users', 'users.id', 'messages.sender_id')
      .where('messages.group_id', '=', opts.groupId)
      // Proactive nudges ARE included: many are conversational (a conflict
      // nudge ends with "Move one, keep both, or drop one?"), so the user's
      // reply ("both") is meaningless without the question in context.
      // Excluding them made the bot confabulate against unrelated history.
      // Clutter from morning-scan summaries is bounded by the recency
      // window + HISTORY_LIMIT below; the "respond to the latest message"
      // instruction keeps focus.
      .orderBy('messages.created_at', 'desc')
      .limit(HISTORY_LIMIT)
      .select([
        'messages.id as id',
        'messages.sender_id as senderId',
        'messages.kind as kind',
        'messages.body as body',
        'messages.created_at as createdAt',
        'users.username as username',
        'users.display_name as displayName',
      ])
      .execute(),
    opts.triggeringUserId
      ? factsForMessage(db, {
          groupId: opts.groupId,
          userId: opts.triggeringUserId,
          triggerMessageId: opts.triggerMessageId,
        })
      : Promise.resolve({ facts: [], total: 0 }),
    wantsGroupContext ? familyFactsForContext(db, opts.groupId) : Promise.resolve<ContextFact[]>([]),
    wantsGroupContext
      ? groupRosterBlock(db, opts.groupId, opts.triggeringUserId)
      : Promise.resolve(''),
    groupSnapshotBlock(db, opts.groupId, wantsPersonalContext ? opts.triggeringUserId! : null),
    wantsGroupContext ? eventsBlock(db, opts.groupId, opts.tz, opts.triggeringUserId ?? null) : Promise.resolve(''),
    wantsPersonalContext ? personalProfileBlock(db, opts.triggeringUserId) : Promise.resolve(''),
    wantsPersonalContext ? weatherLocationBlock(db, opts.triggeringUserId) : Promise.resolve(''),
    opts.triggeringUserId
      ? upcomingTravelBlock(db, {
          groupId: opts.groupId,
          userId: opts.triggeringUserId,
          isPersonal: opts.isPersonal,
          tz: opts.tz,
        })
      : Promise.resolve(''),
    opts.triggeringUserId
      ? pendingInviteesBlock(db, opts.groupId, opts.triggeringUserId)
      : Promise.resolve(''),
    opts.triggeringUserId ? waitingInvitationsBlock(db, opts.triggeringUserId, opts.tz) : Promise.resolve(''),
    opts.triggeringUserId
      ? pendingFanoutBlock(db, opts.groupId, opts.triggeringUserId)
      : Promise.resolve(''),
    opts.triggeringUserId ? lastEventBlock(db, opts.groupId, opts.triggeringUserId, opts.tz) : Promise.resolve(''),
    wantsPersonalContext ? pendingTripTravelersBlock(db, opts.triggeringUserId) : Promise.resolve(''),
    wantsPersonalContext ? skillCatalogueBlock(db, opts.triggeringUserId) : Promise.resolve(''),
    wantsPersonalContext && !opts.skillTurn
      ? activeSkillBlock(db, opts.triggeringUserId, opts.groupId)
      : Promise.resolve(''),
  ]);
  messages.reverse();
  const kept = windowByRecency(messages);

  const atts = opts.attachments;

  const systemParts = [
    `You are ${getDefaultPersona().promptName}, a family AI assistant embedded directly in a group chat.`,
    "What you do: you connect to email, calendar, and reminders and help manage them — reading and replying to mail, creating/editing calendar events and invites, checking for conflicts, and tracking tasks and due dates. You also learn about the family over time — people, important dates, trips, groceries and lists, saved places and recipes, and receipts/bills owed — and help keep track of and coordinate around all of that.",
    "What you don't do: you cannot make bookings or purchases (restaurants, flights, hotels, tickets) — you can find the place and hand back a link to book it, but you never complete a transaction yourself. You also cannot build a freeform spreadsheet or a custom tracker with arbitrary columns — you work through a fixed set of things you track (tasks, lists, events, trips, saved places/contacts, receipts). If a request only makes sense as one of those, don't build a spreadsheet — propose the closest fit instead (see the tool-matching rules below) and never claim to be tracking something in a form you don't actually have. You cannot generate or draw pictures, play music or videos, make calls or send texts either: say so in one line and attach a search card (suggest_external_action kind 'search', with searchType images/videos/news/shopping/web) so they have the next step — never a Maps or other unrelated card.",
    ...(opts.isPersonal
      ? [
          "With the user's email you can: search and read it, summarize it, draft replies, new emails and forwards (they tap to send), move an email to Trash (they tap to confirm), mark emails read or unread, archive them, and add or remove Chord labels — one email, a few, or every email from someone, about a topic, with attachments, in a date range, or all of them (up to 500 at a time; they tap to confirm). You cannot: star or flag mail, move it to folders, apply the mail app's own labels, set up filters, or delete permanently — those are done in their mail app. Never claim an email is read, unread, archived, labelled or deleted unless a tool result this turn says so.",
        ]
      : []),
    'If the user asks what you can do, or seems unsure, answer briefly from the paragraphs above rather than listing every tool.',
    opts.isPersonal
      ? 'This is a private 1:1 chat with a single user — always reply.'
      : 'This is a multi-person group chat. Reply concisely and only address the person who mentioned you. PRIVACY: persona-scoped facts (personal memories, saved people, important dates) belong to individual members and are private to them. If the triggering user asks what you know about *another* member, decline politely and tell them to ask that member directly. Only share group-scope memories or facts that member has explicitly stated in the chat. Never reveal another member\'s persona memories or saved people.',
    'Keep responses short and conversational (1–3 short sentences unless the user asks for a list).',
    "Use the group's shared context below when relevant. Do not invent facts — if you don't know, say so briefly.",
    'If a file appears in the "Files available in this chat" section, its text has already been extracted and is inlined below — you CAN read it. Never tell the user you cannot read PDFs, documents, or attachments. If a file is marked "still indexing", say it is being read and ask the user to retry shortly.',
    'Only mention or cite an indexed file if you actually used its content to answer. Do not reference files that are irrelevant to the question.',
    'The conversation history below is ordered oldest→newest. Always respond to the MOST RECENT message (marked "→ (latest, respond to this)"). Earlier messages are background context only — do not answer a question that has already scrolled past unless the latest message asks about it.',
  ];

  // Triggering user identity intentionally excluded from the system prompt:
  // injecting the sender's name caused the LLM to attribute uploaded documents
  // to the uploader rather than the passenger/owner named in the document.
  // Always emit a date block — falls back to UTC if no tz on record so
  // the LLM doesn't anchor "today" to its training cutoff.
  const tzBlock = localTimeBlock(opts.tz ?? null);
  if (tzBlock) systemParts.push(tzBlock);
  const currentSurface = surfaceBlock(opts.sourceSurface);
  if (currentSurface) systemParts.push(currentSurface);
  const memBlock = turnFactsBlock(memories, { isPersonal: opts.isPersonal });
  if (memBlock) systemParts.push(memBlock);
  // Phase 3a — shared family-profile facts (household + managed personas).
  // Distinct from the per-member memories above, which stay private.
  if (wantsGroupContext) {
    const famBlock = familyFactsBlock(famFacts);
    if (famBlock) systemParts.push(famBlock);
  }
  // PR-G — group roster + snapshot. Personal chats skip the roster (only
  // the user is there) but still surface the snapshot so the bot has a
  // sense of what's on file.
  if (wantsGroupContext && roster) systemParts.push(roster);
  if (snapshot) systemParts.push(snapshot);
  if (wantsGroupContext && evtBlock) systemParts.push(evtBlock);
  // ADR 0166 — a create_event/update_event invitee still waiting on an
  // email. Runs in both personal and group turns: the event that needed it
  // may have been created from either surface.
  if (invites) systemParts.push(invites);
  if (waitingInvites) systemParts.push(waitingInvites);
  // ADR 0232 - only ever set from a personal 1:1 turn, so a shared group
  // never sees it (the key is the personal chat's group id).
  if (fanout) systemParts.push(fanout);
  if (lastEvent) systemParts.push(lastEvent);
  if (tripTravelers) systemParts.push(tripTravelers);
  // ADR 0032 — owner-scoped people + important dates inline only in
  // the 1:1 chat. In group chats these stay tool-gated (list_people)
  // since they have no group_id and can't be safely shown across
  // group boundaries.
  if (wantsPersonalContext) {
    if (profile) systemParts.push(profile);
    if (locBlock) systemParts.push(locBlock);
    // ADR 0110/0143 — each email thread is mined for tasks/trips/events at
    // most once, ever (the mark is what stops a rejected suggestion from
    // reappearing), and there is no tool to clear it or force a re-scan.
    systemParts.push(
      'You have no tool to re-scan or re-run extraction on an email already in the mailbox — every thread is mined at most once, ever, by design, so a rejected suggestion never resurfaces. If the user asks you to "look at this email again", "re-run that", or "try again" on mail that already exists, tell them to forward that email to themselves: a forward is a brand-new message with a new thread id, so it gets mined fresh. Never claim you re-scanned or re-processed an existing thread.',
    );
  }
  // ADR 0138 — "when does my flight land" has to reach a flight NUMBER, and a
  // leg's number was tool-gated behind get_trip_status while an email-derived
  // one had nowhere to live at all.
  if (opts.triggeringUserId && flights) systemParts.push(flights);
  // ADR 0032 — strict per-group scope. The bot's view in a group is
  // limited to items tagged with that group's id; cross-group personal
  // data is never inlined. groupSnapshotBlock + eventsBlock above already
  // cover the in-scope view. The cross_group_personal_context user flag
  // is retained in the DB for backward compatibility but no longer
  // affects bot context.
  const attBlock = attachmentBlock(atts);
  if (attBlock) systemParts.push(attBlock);
  if (opts.triggerHasAttachment) {
    const filed = opts.triggerAttachmentIsImage
      ? 'Its contents are filed automatically (tasks, events, list items, saved places/links, and any flights or hotels). Do NOT create those yourself from the file.'
      : 'Any flight or hotel booking in it is filed automatically. Do NOT create trips or travel legs yourself from the file.';
    systemParts.push(
      [
        'A file is attached to the triggering message. You CAN read it and answer questions about it.',
        filed,
        'If the file is a schedule or calendar, only create events for the dates still in the FUTURE. Dates in it that have already passed are historical context — do NOT create events for them and do NOT ask the user about them. The file stays indexed and searchable regardless.',
        'If — in addition to the file — the user gave you an explicit instruction you therefore cannot carry out this turn, do not silently drop it: tell them to resend that instruction as a plain text message without the attachment.',
      ].join(' '),
    );
    if (opts.triggerIsBareUpload) {
      systemParts.push(
        'This file arrived with no caption, question, or instruction — just the attachment. ' +
          'Do not call any tool this turn, including a read-only lookup like find_events or search: ' +
          'there is nothing to check or answer, and calling one (then reporting its result) reads as ' +
          'a wrong or confused response to whatever the file actually said. The deterministic filer ' +
          'already handles it silently in the background.',
      );
    }
  }
  systemParts.push(opts.useNativeTools ? NATIVE_TOOL_PROMPT : TEXT_FENCE_TOOL_PROMPT);
  // ADR 0246 - mail is answerable only from the personal chat, so the recipes
  // for it are not spent on a shared-group prompt.
  if (opts.isPersonal) systemParts.push(MAIL_QUESTION_RECIPES.trim());
  // ADR 0299 - skills run in the 1:1 only (their tools are personal-only).
  // The running one goes last, nearest the conversation, so its question wins.
  if (wantsPersonalContext) {
    systemParts.push(skillCatalogue);
    const running = opts.skillTurn ? skillTurnBlock(opts.skillTurn) : runningSkill;
    if (running) systemParts.push(running);
  }

  const convo = buildConvo(kept, opts.triggerMessageId);

  return [{ role: 'system', content: systemParts.join('\n\n') }, ...convo];
}

export const __testing = {
  localTimeBlock,
  windowByRecency,
  formatGap,
  buildConvo,
  attachmentBlock,
  FULLTEXT_CHAR_BUDGET,
};
