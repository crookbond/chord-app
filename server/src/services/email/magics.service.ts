/**
 * Email magics (ADR 0063): calendar-event + list-item suggestions extracted from
 * classified threads and staged as PROPOSALS (ADR 0009) in the user's personal
 * group — the user confirms them from the Catchup proposals surface, and confirm
 * dispatches the real create_event / add_list_item tool.
 *
 * Extraction goes through an injectable `EmailExtractor` seam: the real impl uses
 * the LLM; tests inject a deterministic stub. Each thread is processed at most
 * once (the `magic_processed_at` marker), so enabling this only ever costs one
 * LLM call per NEW classified thread. ADR 0088 injects a bounded calendar /
 * tasks / trips snapshot into the extractor so it can refuse twins.
 */
import { responseFromPartstat, setGuestAnswer } from '../events/guest-answers.js';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';

import {
  findFlight,
  listNameKey,
  meetingInvitees,
  type MeetingInviteScope,
  type EmailDecisionsResponse,
  type EmailDecision,
  type EmailMagicSuggestion,
  type EmailReadAdvisory,
  type SchedulingBlock,
  type SchedulingFacts,
  meetingCardPlan,
  type MeetingCardPlan,
} from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { instantMs, textInstant } from '../../db/text-instant.js';
import { sealThreadJsonFor } from './content-seal.js';
import { isDangerousSender, senderContextBlock } from './sender-check/prompt.js';
import { ownAddresses } from './sender-stats.service.js';
import { minablePredicate } from './bulk-gate.js';
import { BODY_EXCERPT_CHARS, bodyForModel, cleanBodyText, cleanSnippet } from '../../utils/email-text.js';
import {
  namesATimeZone,
  offsetForLocalDatetime,
  offsetScheduleNote,
  reanchorNowStampedOffset,
  tzToOffset,
  tzToOffsetMinutes,
  dayOf,
  zonedDayStartUtc,
  svWall,
} from '../../utils/tz.js';
import { normalizeDatetimes, toolSchemas } from '../bot/tools.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { getLlmForUser } from '../llm/factory.js';
import { isAiRefusal } from '../llm/refusal.js';
import { createProposal, retractByProvenance } from '../proposals.service.js';
import { applyEmailChanges } from './email-changes.service.js';
import { replaceOffersFor } from './replace-offer.js';
import { calendarFitFor } from '../events/calendar-fit.service.js';
import { HOLD_DAYS } from '../events/holds.service.js';
import { finishScheduling, parseScheduling, recordScheduling } from './scheduling-block.js';
import {
  cancelMeetingByInviteUid,
  linkInviteToMeeting,
  promoteGroupAgreements,
  readOwnRepliesForMeetings,
  recordMeetingFromEmail,
} from './meetings.service.js';
import {
  applyInviteCancellation,
  consolidateDuplicateEventProposals,
  consolidateDuplicateListItemProposals,
  expireProposals,
  pendingEmailEventProposals,
  retractPastEventProposals,
  retractPastTaskProposals,
  retractPastTripProposals,
  emailThreadPeopleOf,
  retractPendingEmailEventProposalsNear,
  retractProposalsCoveredByExistingEvents,
  shouldStageEventProposal,
  shouldStageListItemProposal,
  shouldStageTaskProposal,
  stripFillerTail,
  threadAlreadyProposed,
  retractSupersededEmailProposals,
  withEmailStagingLocks,
  EMAIL_GENERAL_TOOLS,
} from '../event-convergence.service.js';
import { inviteEventForMessage, probeResultFromIcs, type InviteProbeResult } from './invite-ics.js';
import { icsYearCorrection, legDatetime, placeDatetime, shiftYear } from '../bot/trip_classifier.js';
import {
  stageEmailTripProposal,
  type StageEmailTripResult,
  type TravelClassifier,
} from './trip-extraction.js';
import { inviteEventForAccountMessage } from '../email-accounts/invite-probe.js';
import { hasAiConsent } from '../ai-consent.service.js';
import { getEntitlement } from '../billing.service.js';
import { matchRoutingRule } from './routing-rules.service.js';
import {
  formatLabelledWorld,
  loadThreadEvents,
  loadWorldContext,
  type MagicsWorldContext,
} from './magics-context.js';
import { keepReceipt, normalizePaymentMethod } from './receipts.service.js';
import { trackPassCost } from './pass-cost.js';
import { findTracking } from './tracking.js';
import { REPLY_TITLE, threadAlreadyAnswered } from './reply-todos.js';
import { fetchFullBodyText } from '../email-accounts/message-text.js';
import { askedSomeoneElse } from './asked-of.js';

export interface EventSuggestion {
  kind: 'event';
  title: string;
  /** ISO 8601 with offset (create_event requires a concrete instant). */
  startsAt: string;
  endsAt?: string;
  location?: string;
  /** ADR 0315 addendum — a meeting WITH people on this email: "sender" for a
   *  one-on-one, "all" for everyone on it. Turned into addresses from the
   *  message headers (`meetingInvitees`), never by the model. */
  invite?: MeetingInviteScope;
  /** Who the email asks to do it, as the model read it ("Ash", "me"). */
  askedOf?: string;
}
export interface ListSuggestion {
  kind: 'list';
  listName: string;
  item: string;
  askedOf?: string;
}
/**
 * Something the recipient has to DO (ADR 0132).
 *
 * Distinct from a list item because a task has a lifecycle a list item does
 * not: a due date, the ADR 0092 stale/overdue handling, and an exit other than
 * deletion. Mail is full of obligations with deadlines, and filing them as
 * list rows was throwing all of that away.
 */
export interface TaskSuggestion {
  kind: 'task';
  title: string;
  /** ISO 8601 with offset, when the email states a deadline. */
  dueAt?: string;
  /** ADR 0314 — doing it IS writing back to this email's sender, so the
   *  user's reply in the thread finishes it. */
  reply?: boolean;
  askedOf?: string;
}

/**
 * Nothing actionable, but the message ITSELF is the concern — a
 * phishing/spoofing/scam tell (ADR 0180). Never staged as a proposal: there
 * is nothing to confirm about a warning, and it never co-occurs with an
 * action suggestion for the same message.
 */
export interface AdvisorySuggestion {
  kind: 'advisory';
  note: string;
}
/**
 * ADR 0248 — the email changes something the user ALREADY has: one of the
 * labelled lines in the world block (`e3`, `t1`, `p2`). The model names the
 * label; code maps it back to the row, checks it, and stages a card
 * (`email-changes.service.ts`). Never staged as itself.
 */
export type ChangeAction = 'remove' | 'move' | 'done' | 'drop';
export interface ChangeSuggestion {
  kind: 'change';
  target: string;
  action: ChangeAction;
  /** move, event: the new start (and end). */
  startsAt?: string;
  endsAt?: string;
  /** move, to-do: the new due date. */
  dueAt?: string;
  /** A short quote from the email, shown on the card. */
  why?: string;
}
export type EmailSuggestion =
  | EventSuggestion
  | ListSuggestion
  | TaskSuggestion
  | AdvisorySuggestion
  | ChangeSuggestion;

/** At most this many changes from one email. */
const MAX_CHANGES = 4;
const CHANGE_ACTIONS = new Set<string>(['remove', 'move', 'done', 'drop']);

export interface MagicThreadInput {
  subject: string;
  snippet: string;
  bodyText: string | null;
  /** Extracted text of the thread's KB-imported attachments (bounded) — a
   *  newsletter PDF full of dates is often the ONLY place the details live. */
  attachmentText?: string | null;
  categoryTitle: string | null;
  /** Owner's IANA timezone (`users.last_tz`) — the zone email times are read in. */
  userTz?: string | null;
  /** When the newest message was sent: raw `Date` header when mirrored
   *  (carries the sender's offset), else the UTC `internal_date`. Anchors
   *  relative dates ("this Sunday"). */
  emailSentAt?: string | null;
  /** ADR 0110 — fetch the whole message, when the model says the detail it
   *  needed was cut off. Absent means no escalation is on offer for this
   *  thread: the tick's budget is spent, or there is nothing more to read. */
  readMore?: () => Promise<string | null>;
  /** ADR 0135 — the delivery block, when the mail was a shipping update.
   *  A callback rather than a return value so the extractor's contract stays
   *  `EmailSuggestion | null` and a delivery need not pose as an event. */
  onDelivery?: (facts: DeliveryFacts) => void;
  /** ADR 0138 — the flight block, when the mail was about a flight. Same side
   *  channel as `onDelivery`, and for the same reason. */
  onFlight?: (facts: FlightFacts) => void;
  /** ADR 0160 — the receipt block, when the mail was a payment/purchase
   *  confirmation. Same side channel as `onDelivery`/`onFlight`: read-only,
   *  nothing to confirm about a purchase already settled. */
  onReceipt?: (facts: ReceiptFacts) => void;
  /** ADR 0346 - the scheduling block, when the mail arranges a meeting. Same
   *  side channel again; finished in code and stored, never a card. */
  onScheduling?: (block: SchedulingBlock) => void;
  /** Confirmed persona facts ("kid_school: Lincoln Elementary") — grounds the
   *  group matcher so a school email finds the family group by fact, not by
   *  group-name luck (ADR 0077). */
  knownFacts?: string[];
  /** ADR 0088 — names+dates already on the calendar / to-dos / trips. */
  worldContext?: string | null;
  /** ADR 0177 — a non-invite (ADR 0175: PUBLISH/no-METHOD) `.ics` attached to
   *  this same message, deterministically parsed. Passed as GROUNDING
   *  context, never a replacement for reading the email: an itinerary's
   *  prose usually carries details (a confirmation number, an address) the
   *  bare VEVENT does not. */
  icsContext?: string;
  /** ADR 0184 — true only for the interactive read-time pass (ADR 0180):
   *  opening this exact email is the recipient's own consent, so the
   *  extractor drops ADR 0179's discretionary-broadcast suppression.
   *  Undefined/false for the unattended background sweep, unchanged. */
  interactive?: boolean;
  /** ADR 0294 — who sent it, from the headers and Chord's own sender checks.
   *  Set by both passes (ADR 0329): either may be the email's one read. */
  senderContext?: string | null;
  /** ADR 0315 addendum — "Participants: From ...; To ...; Cc ..." for the
   *  newest message, so the model can choose an event's `invite`. */
  participants?: string | null;
  /** ADR 0193 — present only when the caller wants this call's tokens
   *  recorded to the per-user usage counter. Optional so no existing test
   *  double constructing a `MagicThreadInput` needs to change. */
  userId?: string;
  db?: Kysely<DB>;
}

export interface EmailExtractor {
  /**
   * What the thread asks of its reader, soonest first; null or an empty array
   * for "nothing actionable" (ADR 0243). A single suggestion is still a valid
   * return, so a stub written when a thread yielded at most one keeps working.
   */
  extract(input: MagicThreadInput): Promise<EmailSuggestion | EmailSuggestion[] | null>;
}

/** Entries kept for one list from one email; past this it is a catalogue. */
const MAX_LIST_ENTRIES = 12;

/**
 * Bring whatever an extractor returned down to what may be staged (ADR 0243).
 *
 * An advisory stands alone — a message that looks like a scam must not also
 * get a card inviting the reader to do what it asks (ADR 0180). Otherwise the
 * cap counts CARDS: each event, each to-do, and each distinct list, however
 * many entries that list has, since those fold into one proposal.
 */
export function capSuggestions(
  found: EmailSuggestion | EmailSuggestion[] | null,
  max: number = env.EMAIL_MAGICS_MAX_ITEMS,
): EmailSuggestion[] {
  const given = found ? (Array.isArray(found) ? found : [found]) : [];
  const advisory = given.find((s) => s.kind === 'advisory');
  if (advisory) return [advisory];
  // ADR 0248 — changes to existing items are not new cards to add, so they
  // sit outside the cap: one per target, a few at most.
  const changes: EmailSuggestion[] = [];
  const targets = new Set<string>();
  for (const s of given) {
    if (s.kind !== 'change' || targets.has(s.target) || changes.length >= MAX_CHANGES) continue;
    targets.add(s.target);
    changes.push(s);
  }
  const all = dropTasksRestatingLists(given.filter((s) => s.kind !== 'change'));
  const limit = Math.max(1, max);
  const out: EmailSuggestion[] = [];
  const lists = new Map<string, number>();
  let cards = 0;
  for (const s of all) {
    if (s.kind === 'list') {
      const key = listNameKey(s.listName);
      const held = lists.get(key);
      if (held === undefined) {
        if (cards >= limit) continue;
        cards += 1;
      } else if (held >= MAX_LIST_ENTRIES) {
        continue;
      }
      lists.set(key, (held ?? 0) + 1);
    } else {
      if (cards >= limit) continue;
      cards += 1;
    }
    out.push(s);
  }
  return [...changes, ...out];
}

const plainWords = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * One ask, one shape (ADR 0244). "Bring paper plates, a fruit salad and
 * sparkling water to the potluck" came back as a to-do AND as a list of the
 * same three things. Things to bring are a list (ADR 0132), so a to-do whose
 * title spells out every entry of a list from the same email is that list
 * said again, and is dropped. A to-do that names few of them, or none, is its
 * own obligation and stays.
 */
export function dropTasksRestatingLists(all: EmailSuggestion[]): EmailSuggestion[] {
  const lists = new Map<string, string[]>();
  for (const s of all) {
    if (s.kind !== 'list') continue;
    const entry = plainWords(s.item).replace(/^(?:a|an|the|some) /, '');
    if (!entry) continue;
    const key = listNameKey(s.listName);
    lists.set(key, [...(lists.get(key) ?? []), entry]);
  }
  if (lists.size === 0) return all;
  return all.filter((s) => {
    if (s.kind !== 'task') return true;
    const title = ` ${plainWords(s.title)} `;
    // Two of three is still the same ask: the two shapes rarely word a
    // quantity alike ("two bottles" / "2 bottles").
    return ![...lists.values()].some(
      (entries) =>
        entries.filter((e) => title.includes(` ${e} `)).length >= Math.ceil((entries.length * 2) / 3),
    );
  });
}

/**
 * "paper plates, a fruit salad, and two bottles of sparkling water" is three
 * things to bring, and arrived as ONE list row. Split only a plain comma
 * series of three or more; anything with brackets or a number-comma is left
 * as written, since a wrong split ("flour (2 cups, sifted)") is worse than a
 * long row.
 */
export function splitListEntry(item: string): string[] {
  if (/[()[\]]|\d,\d/.test(item)) return [item];
  const parts = item
    .split(/,\s+/)
    .map((p) => p.replace(/^(?:and|&)\s+/i, '').trim())
    .filter(Boolean);
  // Short parts only: a sentence that happens to hold a date ("…tickets for
  // Sun, Aug 30, 12:00 PM") has commas too, and is one thing.
  const short = (p: string): boolean => p.split(/\s+/).length <= 6 && !/\d:\d/.test(p);
  return parts.length >= 3 && parts.every(short) ? parts : [item];
}

export interface GroupCandidate {
  id: string;
  name: string;
}

/**
 * ADR 0179's discretionary-broadcast gate — unattended background sweep
 * only. A coupon or an unbooked schedule of events costs nothing to miss,
 * so the sweep must not stage a card for mail nobody looked at.
 */
const ON_THE_HOOK_RULE_SWEEP = `- Only emit a task or event when the recipient is ON THE HOOK: a specific person is waiting on them, they have already committed (a booking, a registration, a ticket, a payment owed), or a stated deadline has a real consequence. A coupon or sale they MAY use, and a venue's or club's schedule of events they have not booked, are discretionary — emit "none" even though there is a date. "$4 off, redeem by Sep 16" → none. "Main Dining Room reopens Sep 23" → none. "Sign and return the permission slip by Friday" → task.`;

/**
 * ADR 0184 — the interactive read-time pass only (`runReadTimeEmailMagics`).
 * Opening this exact email is the recipient's own signal that it may be
 * worth acting on, which is the same consent the sweep-only rule above
 * tries to infer from the mail's content alone. Drop the discretionary
 * suppression; keep every other kind definition (a date/time still has to
 * be concrete for an event, a task is still something to DO) so nothing is
 * invented where the email truly has no action in it.
 */
const ON_THE_HOOK_RULE_INTERACTIVE = `- The recipient opened this exact email themselves — that is their own signal it may be worth acting on, so do NOT suppress a task or event just because the email is a discretionary coupon, sale, or an unbooked schedule of events; still only emit one when the email actually contains something of that shape. A one-time, already-fixed date and time window that the recipient's own home or address must accommodate (a utility or building service shut-off, a maintenance notice with a stated start and end time) counts as something "the recipient is attending" for the "event" rule below, even though they are not physically present for it — a RECURRING or open-ended schedule of the same kind of notice ("every Tuesday", "throughout October") is still not concrete enough for an event. "$4 off, redeem by Sep 16" → task ("Redeem the $4-off coupon before Sep 16"). "Building water shut off 10am-2pm Sep 21" → event. "Elevator maintenance every Tuesday in October" → none (recurring, not a fixed slot). "Main Dining Room reopens Sep 23" → none (nothing to do or attend, purely informational). "Sign and return the permission slip by Friday" → task.`;

const EXTRACT_SYSTEM = `You extract the actionable items from a single email: usually one, often none, occasionally several. Reply with STRICT JSON and nothing else:

{"items":[ up to __MAX_ITEMS__ of the shapes below ]}

plus the extra keys described at the end when they apply. In particular, an
email that ARRANGES a meeting or call (offers times, asks for times, agrees
or moves one) ALWAYS also carries a "scheduling" key, whatever "items" holds.

Each item is one of:
{"kind":"event","title":"...","startsAt":"ISO8601 WITH timezone offset","endsAt":"ISO8601 (optional)","location":"... (optional)","invite":"sender"|"all" (optional, see below),"askedOf":"who is asked"}
{"kind":"list","listName":"...","items":["...","..."],"askedOf":"who is asked"}
{"kind":"task","title":"...","dueAt":"ISO8601 WITH offset (optional)","reply":true (ONLY when doing the task IS writing back to the person who sent this email),"askedOf":"who is asked"}
{"kind":"advisory","note":"one short sentence, in the recipient's own words"}
{"kind":"change","target":"e3","action":"remove"|"move"|"done"|"drop","startsAt":"ISO8601 WITH offset (move, calendar item)","endsAt":"(optional)","dueAt":"ISO8601 WITH offset (move, to-do)","why":"a few words quoted from the email"}

Nothing actionable: {"items":[]}. Wherever the rules below say to emit "none" for something, leave that thing out of "items".

More than one item:
- Emit several ONLY when the email holds genuinely SEPARATE things, each of which passes every rule below on its own: a school note with a form due Friday AND a picture day on the 14th is two. Most emails hold one or none.
- Never split one obligation into steps ("download the form", "sign the form", "return the form" is ONE task), and never emit the same thing twice in two shapes (an appointment is an event, not also a task to attend it).
- Things to buy or bring for the same list go in ONE list item, with each thing as its OWN entry: "bring paper plates, a fruit salad, and two bottles of sparkling water" is "items":["paper plates","fruit salad","2 bottles of sparkling water"], never one entry holding all three.
- Things to bring are a list and ONLY a list: do not also emit a task that says to bring them.
- Order by what comes due first: the soonest date or deadline first, undated items last. If more than __MAX_ITEMS__ qualify, keep the __MAX_ITEMS__ that come due soonest.
- An "advisory" is always the only item.

Timezone rules — NEVER assume UTC:
- Times written in the email ("5pm", "7:30") are in the USER'S timezone (given in the input) unless the email explicitly names a different zone or offset — then use that one.
- startsAt/endsAt MUST carry the matching numeric UTC offset for that zone ON THAT DATE. The user's offset changes with daylight saving; the input line gives the date it changes, so a time after that date takes the later offset, not today's.
- EXCEPTION, travel: a flight or train DEPARTURE time is on the clock of the place it leaves from, and an ARRIVAL time on the clock of the place it lands. Copy each time exactly as printed and give it THAT place's UTC offset, never the user's and never converted (a 01:50 departure from Delhi is 01:50+05:30 whoever is reading).
- Resolve relative dates ("this Sunday", "tomorrow") from the email's sent date, not from today.

Who the recipient is:
- The recipient is the user on the "You" line (when present): their address, and whether they are on To, on Cc only, or neither. Every item must be something THEY do or attend.
- Every task, event and list item carries "askedOf": the name the email uses for the person it asks to do this, copied as written ("Ash", "Geoff", "Tom"), or "me" when the email asks the recipient: by their name, as "you" in a message sent To them, or as a group that includes them ("both of you", "parents"). An appointment or booking the recipient attends is "me".
- Read who the email SPEAKS to before deciding. "Hi Tom, when are you free next week?" → askedOf "Tom". On Cc the recipient is usually just being kept informed.
- Being MENTIONED is not being asked. "A few options that work for John and me - happy to send an invite for whichever works" written to Geoff asks Geoff to choose: askedOf "Geoff". Until he answers there is no fixed time.
- In a reply, the next step belongs to whoever must act on it. Ashton answering Jason's "are you available tomorrow morning?" with "I am open except 1-2:30" leaves Jason to pick the time: askedOf "Jason".

Rules:
- Every suggestion is an ACTION THE RECIPIENT TAKES, written from their point of view ("Reply to Sarah with times that work for coffee"), NEVER a restatement of what the sender wants ("give Sarah time", "Sarah wants to meet").
__ON_THE_HOOK_RULE__
- "event": flights, appointments, reservations, interviews, deliveries with a confirmed slot — anything with a CONCRETE date AND time that is already FIXED and that the recipient is attending. If you cannot determine a specific confirmed date and time, do NOT emit an event.
- A slot is FIXED when the sender states ONE specific date and time as the plan — agreeing to it ("I agree, let's meet for lunch tomorrow at 2pm") or setting it ("let's also do Monday at 4pm"). Each such slot is its own event, even when the same email also asks for other things; never fold two stated times into one "reply about…" task. The recipient still approves the card, so a stated time does not need a second confirmation to count. Title each event by what the email says THAT slot is for; a second time given with no purpose is "Meeting", not a copy of the first event's title.
- A reply that ACCEPTS a time proposed earlier in the conversation (the earlier message is usually quoted below it) fixes that slot too: "10 AM works - talk then" answering "How is anytime after 10 AM, Thursday, November 5" is an event on November 5 at 10 AM. Take the date from the quoted message, title it by what the conversation is for ("Call with Irene"), and do NOT emit a task to reply — the time is settled.
- "invite": set it ONLY on an event that is a meeting, call or get-together WITH people on this email, arranged in this email — the people the recipient would send a calendar invite to. "sender" when it is between the recipient and the other person writing (a one-on-one); "all" when everyone on the email (the "Participants" line) is meeting. Pick "sender" unless the email makes clear the others are coming too. Leave it out for appointments, reservations, classes, flights, deliveries, school events and anything else the recipient attends without these people. Never write an email address; the system takes them from the message.
- When the sender asks the recipient to contact a THIRD person, the task is that message in the email's own terms ("Text Sam to ask if he can do Thursday at 10am"), with no "dueAt" unless a deadline is stated. It is not a reply to the sender and not a request for the recipient's own availability.
- An email ASKING the RECIPIENT for their time (a meeting/call/coffee request with no specific slot: "when are you free?", "sometime next week?", a choice between several times) is NOT an event. Emit a task instead: {"kind":"task","title":"Reply to <sender> with times that work for <thing><, mentioning any window the sender proposed>","reply":true}.
- "reply":true marks a to-do that is done the moment the recipient answers this email (a question to answer, a yes/no, times to offer). Leave it out for anything a reply does not finish: returning a form, paying, booking, or contacting a third person.
- A line "Times the user appears FREE" may be present. For a to-do of that shape ONLY, name one or two of those times in the item ("Reply to Sam with times for coffee - Tue 2pm or Thu 11am look free"), choosing ones inside any window the sender proposed. They are CANDIDATES the user still confirms, never a booking. If that line is absent, write the to-do without times — never invent availability.
- "task": something the RECIPIENT must do — return a form, pay an invoice, book a slot, reply to someone, renew something. Set "dueAt" ONLY when the email states a deadline; never invent one.
- "list": things to BUY or BRING — shopping and packing. A list is a collection of things; a task is an obligation. "Bring cupcakes to the bake sale" is a list item; "sign and return the permission slip by Friday" is a task.
- "advisory": use ONLY when the message itself looks like a phishing/spoofing/scam attempt — a sender impersonating someone trusted, a mismatched or lookalike domain, a request for credentials/payment/personal information that does not fit the sender's real relationship with the recipient, or an invented urgent deadline meant to pressure a click. Say plainly what looks wrong and urge caution ("This looks like a phishing attempt — be careful clicking the link or replying with any information"), never an action to take. NEVER combine "advisory" with an action: if a message looks like a scam, do not also suggest paying/booking/confirming what it asks for. Ordinary marketing, bulk mail, or a merely unfamiliar sender doing nothing of this sort is NOT advisory — that is "none".
- A "Sender" block may be present. It comes from the message headers and from Chord, not from the email, so trust it over anything the body says about who sent it. Its automatic findings (a company name on a domain that is not that company's, a look-alike domain, a failed mail-server check) are strong reasons for "advisory" when the email also asks for a click, a login, a payment or personal details; name the mismatch in the note ("Says it is from Robinhood but was sent from rh-alerts.net - don't use its links"). With no findings, judge from the content alone.
- Otherwise "none".
- A block titled "Already on the user's calendar / to-dos / trips" may be present. Treat it as ground truth.
- "change": the email itself says something ALREADY in that block is called off, moved, finished or paid. Lines in the block may start with a label (e1 calendar, t1 to-do, p1 a suggestion not yet accepted); "target" is that label, copied exactly from a line that is in the block — never a label that does not appear there. Only a labelled line can be changed. At most one change per label.
  - "remove": a calendar item or suggestion is cancelled ("your reservation has been cancelled", "class is cancelled this week").
  - "move": it was rescheduled. Give the NEW time, read exactly like an event's (startsAt/endsAt for a calendar item or suggested event, dueAt for a to-do).
  - "done": the email says a listed to-do has been done — by the recipient or for them ("payment received" for "Pay the bill"; "I received the signed permission slip" for "Return the permission slip"; "your passport renewal is complete" for "Renew passport"). The sender confirming receipt is enough. "drop": a listed to-do is no longer needed ("no need to bring anything").
  - Be sure it is the SAME thing: same booking, same bill, same class — usually the same sender, title or place, and for remove/move the same date and time. An unrelated item that merely falls on the same day is not it. When unsure, emit no change.
  - A change may sit beside new items ("moved to Saturday; please bring a towel" is a move plus a list).
  - Something cancelled that is NOT in the block: emit nothing for it, and never an "event" for the cancelled slot — a cancellation is not something to attend. Something rescheduled that is not in the block may be an "event" at its NEW time.
  - Flights and hotels are handled elsewhere: no change for them.
  - "You have successfully cancelled out of a reservation ... Squash Singles, Friday, October 16th, 05:30 PM" with "- e2 calendar: Squash Singles 3 - 2026-10-16 17:30" in the block → {"kind":"change","target":"e2","action":"remove","why":"reservation cancelled"}.
- If the email is clearly ABOUT an item already listed (same event, same trip, same to-do), leave it out — do not propose a twin. If the email changes it, that is a "change", not a new item.
- A block titled "Attached calendar file" may be present — a deterministically parsed .ics attached to this email, not a summary from an LLM. Its date/time is EXACT; when the prose omits a year or is otherwise ambiguous, resolve against this block rather than guessing. It rarely carries everything the email itself does (a confirmation number, an address, why the recipient needs to act) — keep reading the body for those.
- You MAY use those dates to resolve a NEW obligation the email introduces (an RSVP deadline, something to bring) that is not already listed.
- The item is the ACTION ALONE. Never append a filler clause that says nothing the action does not already say ("and take action accordingly", "and act accordingly", "and respond appropriately"). The same to-do written twice with different padding becomes two cards.
- Titles short. Never invent a date/time. Output JSON only.

The message text may be TRUNCATED. If the email plainly contains the detail you
need — an amount, a date, a confirmation number, an itinerary — and it was cut
off before you could read it, add "needMore": true to your JSON. Use it also
when the text stops partway through what is plainly a run of separate dated
items (a school or team bulletin listing one deadline after another). Use it
only for those: not because the email is vague, and not because you would
simply like more context. It costs a second read of the whole message.

"needMore" and the blocks below are keys of the reply object itself, beside
"items" — never entries inside it.

If the email is a SHIPPING or DELIVERY update, also add:
{"delivery":{"etaAt":"YYYY-MM-DD, or ISO 8601 with offset when a time is given","needsPresence":true|false}}
Most such mail states the arrival outright ("arriving Thursday", "expected
Aug 29", "delivery by end of day Friday") — read it off the email. Omit etaAt
entirely rather than guessing; a shipping date is not an arrival date.
Set needsPresence ONLY when someone must physically be there: a signature is
required, a delivery window is given, or the goods are perishable. A parcel left
at the door is not. Alongside a delivery object "items" is usually empty
— the arrival and a tracking link are shown on the tile already,
so a to-do that says "track this" adds nothing.

If the email is about a FLIGHT — a booking, a check-in reminder, a schedule
change, a delay or a cancellation — also add:
{"flight":{"departAt":"ISO 8601 with offset","arriveAt":"ISO 8601 with offset (optional)","origin":"airport code or city (optional)","destination":"... (optional)","status":"on_time"|"delayed"|"boarding"|"check_in"|"cancelled"}}
Read these off the email; omit any you cannot determine rather than guessing.
departAt is the ORIGIN's local clock time with the origin's offset; arriveAt the
DESTINATION's local clock time with the destination's offset.
Do NOT report the flight number here — it is read from the email text directly.
Unlike a delivery, KEEP the event suggestion: a parcel is left at the door, but
a flight is somewhere a person has to be, so it belongs on the calendar too.

If the email is a RECEIPT or purchase confirmation — a payment succeeded, an
order was placed, a subscription renewed, anything already paid in full with
NOTHING still owed — also add:
{"receipt":{"merchant":"who was paid (optional)","amount":number,"currency":"3-letter code, optional, assume USD","purchasedAt":"YYYY-MM-DD (optional)","orderNumber":"... (optional)","paymentMethod":"how it was paid, e.g. 'Visa ending 1234', 'PayPal', 'Apple Pay', 'gift card' (optional)"}}
For paymentMethod give only the card type and its LAST FOUR digits, never more of a card number.
Only when a specific amount is stated; omit the block entirely otherwise. Do
NOT emit this for a BILL or invoice that still has a balance due — that stays
a task, same as any other obligation. Alongside a receipt object "items" is
usually empty — a completed purchase is a
record to show, not something to act on.

If the email ARRANGES a meeting or call between people (offers or asks for
times, agrees a time, counters, says who will send the invite, moves or
cancels one), also add:
{"scheduling":{"act":"offer_slots"|"ask_times"|"agree"|"counter"|"reschedule"|"cancel"|"fyi","writer":"principal"|"assistant","onBehalfOf":"who an assistant writes for (optional)","inviteBy":"them"|"me"|"unknown","inviteEvidence":"the few words that say so (optional)","format":"in_person"|"video"|"phone"|"unknown","place":"(in person, optional)","phone":"(optional)","offered":["each time on offer, quoted as written"],"agreed":"the time agreed, quoted as written (optional)","title":"what the meeting is FOR, a few words","assistants":["names of anyone arranging it for someone else"],"unavailable":["times the WRITER says they cannot do, quoted"],"others":[{"person":"a name or address on this email","offered":["..."],"unavailable":["..."]}]}}
- "act", read from the recipient's side:
  - offer_slots: the email NAMES one or more times or windows for the recipient to pick from, even when it also asks "anything work?" ("I'm free tomorrow from 10-1. Anything work for you?" is offer_slots).
  - ask_times: it asks the recipient for times and names none.
  - agree: one time is now the plan, including a sender simply setting it ("Let's meet Friday at 9am at Blue Bottle").
  - counter: a different time is proposed instead of one already on the table.
  - fyi: the scheduling is between OTHER people and the recipient is only kept informed — always fyi when the "You" line says Cc only and nothing is asked of the recipient by name.
- "inviteBy": "them" when the other side says they (or their assistant) will send the calendar invite, "me" when they ask the recipient to send it, else "unknown". Never guess from who wrote first.
- "writer": "assistant" when the sender arranges the meeting for someone else (an executive assistant, a scheduler).
- "offered" / "unavailable" / "others": these are about the WRITER of this one email. "offered" is only times THE WRITER can do; "unavailable" only times they say they cannot ("I can't do Wednesday", "out until the 20th"); "any time Tuesday" is an offer of "Tuesday". When the writer passes on someone ELSE's times ("Sam can do Tuesday, Kim prefers mornings"), put them under "others" with that person's name as the email writes it, never under "offered". In a reply, never repeat times quoted from earlier messages: only what THIS message says.
- "offered" / "agreed": copy the words exactly ("tomorrow from 10-1", "11/12: 3:00 PM - 5:00 PM PT"), one entry per time or window, never convert them; the system reads the dates.
- "title": what the meeting is about ("Intro with Omar", "Q3 budget review"), never the email subject line ("Re: Fwd: quick question").
- Leave the block out entirely for mail that does not arrange a meeting (a confirmation from a business, a newsletter, a booking you attend alone).`;

/**
 * Did the model say the answer was below the cut? (ADR 0110)
 *
 * Read separately from the suggestion so the extractor's contract is unchanged
 * — every stub in the tests still returns `EmailSuggestion | null`, and
 * escalation stays an implementation detail of the LLM extractor.
 */
/** What a delivery email said about itself (ADR 0135). */
export interface DeliveryFacts {
  etaAt: string | null;
  needsPresence: boolean;
}

/**
 * The optional delivery block, read off the same reply as the suggestion.
 *
 * A side channel for the same reason `parseNeedMore` is one: the extractor's
 * contract stays `EmailSuggestion | null`, so every injected stub in the tests
 * keeps compiling and a delivery is not forced to masquerade as an event.
 */
export function parseDelivery(raw: string): DeliveryFacts | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let d: unknown;
  try {
    d = (JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>).delivery;
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  const raw_eta = typeof o.etaAt === 'string' ? o.etaAt.trim() : '';
  // A date we cannot parse is worse than none: it would render a wrong day
  // beside an email that states the right one.
  const etaAt = raw_eta && Number.isFinite(Date.parse(raw_eta)) ? raw_eta : null;
  const needsPresence = o.needsPresence === true;
  return etaAt || needsPresence ? { etaAt, needsPresence } : null;
}

/**
 * What a flight email said about itself (ADR 0138).
 *
 * Times, route and status only — the flight's IDENTITY is parsed out of the
 * text by `findFlight`, because a model that misreads a designator produces a
 * link to somebody else's aeroplane.
 */
export interface FlightFacts {
  departAt: string | null;
  arriveAt: string | null;
  origin: string | null;
  destination: string | null;
  status: string | null;
}

const FLIGHT_STATUSES = new Set(['on_time', 'delayed', 'boarding', 'check_in', 'cancelled']);

/** The optional flight block, read off the same reply. See `parseDelivery`. */
export function parseFlight(raw: string): FlightFacts | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let f: unknown;
  try {
    f = (JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>).flight;
  } catch {
    return null;
  }
  if (!f || typeof f !== 'object') return null;
  const o = f as Record<string, unknown>;
  // A date we cannot parse is worse than none — it would render a wrong day
  // beside an email that states the right one.
  const when = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s && Number.isFinite(Date.parse(s)) ? s : null;
  };
  const text = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim().slice(0, 80) : '';
    return s || null;
  };
  const status = typeof o.status === 'string' ? o.status.trim().toLowerCase() : '';
  const facts: FlightFacts = {
    departAt: when(o.departAt),
    arriveAt: when(o.arriveAt),
    origin: text(o.origin),
    destination: text(o.destination),
    status: FLIGHT_STATUSES.has(status) ? status : null,
  };
  return Object.values(facts).some(Boolean) ? facts : null;
}

const sameInstant = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && Date.parse(a) === Date.parse(b);

/**
 * Put a flight's times on the clocks they were printed on.
 *
 * The extractor's timezone rule reads every time in the mail as the user's
 * own, which is wrong for exactly one kind of email: a departure is on the
 * ORIGIN's clock. A 1:50am Delhi departure read by someone in New York came
 * out as 1:50am New York. Mutates `flight`, and moves the event suggestion
 * with it when its start/end ARE the flight's departure/arrival.
 */
export function anchorFlightTimes(
  flight: FlightFacts,
  suggestion: EmailSuggestion | EmailSuggestion[] | null,
  userTz: string | null | undefined,
): void {
  const readerOffset = userTz ? (tzToOffsetMinutes(userTz) ?? undefined) : undefined;
  const anchor = (iso: string | null, place: string | null): string | null =>
    iso && /T\d{2}:\d{2}/.test(iso) ? legDatetime(iso, place, undefined, readerOffset, userTz) : iso;
  const departAt = anchor(flight.departAt, flight.origin);
  const arriveAt = anchor(flight.arriveAt, flight.destination);
  // Every event is compared against the times AS READ, before `flight` moves.
  for (const s of suggestion ? (Array.isArray(suggestion) ? suggestion : [suggestion]) : []) {
    if (s.kind !== 'event') continue;
    if (departAt && sameInstant(s.startsAt, flight.departAt)) s.startsAt = departAt;
    if (arriveAt && sameInstant(s.endsAt, flight.arriveAt)) s.endsAt = arriveAt;
  }
  flight.departAt = departAt;
  flight.arriveAt = arriveAt;
}

/** What a receipt email said about itself (ADR 0160). */
export interface ReceiptFacts {
  merchant: string | null;
  amount: number | null;
  currency: string | null;
  purchasedAt: string | null;
  orderNumber: string | null;
  /** ADR 0249 — card type and last four digits, or a wallet; never a full number. */
  paymentMethod?: string | null;
}

/** The optional receipt block, read off the same reply. See `parseDelivery`. */
export function parseReceipt(raw: string): ReceiptFacts | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let r: unknown;
  try {
    r = (JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>).receipt;
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  // No amount, no fact — an unpriced "receipt" tells the tile nothing a
  // subject line does not already show.
  const amount = typeof o.amount === 'number' && Number.isFinite(o.amount) && o.amount > 0 ? o.amount : null;
  if (amount === null) return null;
  const text = (v: unknown, cap: number): string | null => {
    const s = typeof v === 'string' ? v.trim().slice(0, cap) : '';
    return s || null;
  };
  const purchasedAtRaw = text(o.purchasedAt, 40);
  return {
    merchant: text(o.merchant, 80),
    amount,
    currency: text(o.currency, 3)?.toUpperCase() ?? null,
    // A date we cannot parse is worse than none — it would render beside an
    // email that states the right one.
    purchasedAt: purchasedAtRaw && Number.isFinite(Date.parse(purchasedAtRaw)) ? purchasedAtRaw : null,
    orderNumber: text(o.orderNumber, 40),
    ...(normalizePaymentMethod(o.paymentMethod) ? { paymentMethod: normalizePaymentMethod(o.paymentMethod) } : {}),
  };
}

export function parseNeedMore(raw: string): boolean {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return false;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return o.needMore === true;
  } catch {
    return false;
  }
}

/** Narrow one object from a model reply. A list with several entries is one
 *  suggestion per entry; staging folds them back into a single proposal. */
function narrowSuggestion(obj: unknown): EmailSuggestion[] {
  if (typeof obj !== 'object' || obj === null) return [];
  const o = obj as Record<string, unknown>;
  // An ask aimed at someone else on the email (the To person, while the user
  // is on Cc) is theirs, not the user's: dropped here whatever else the model
  // wrote, so a card for Tom's reply can never reach the user.
  const asked = typeof o.askedOf === 'string' && o.askedOf.trim() ? { askedOf: o.askedOf.trim().slice(0, 80) } : {};
  if (o.kind === 'task' && typeof o.title === 'string' && o.title.trim()) {
    const title = stripFillerTail(o.title);
    const reply = o.reply === true;
    return title
      ? [
          {
            kind: 'task',
            title,
            ...(typeof o.dueAt === 'string' ? { dueAt: o.dueAt } : {}),
            ...(reply ? { reply: true } : {}),
            ...asked,
          },
        ]
      : [];
  }
  if (o.kind === 'event' && typeof o.title === 'string' && typeof o.startsAt === 'string') {
    return [
      {
        kind: 'event',
        title: o.title,
        startsAt: o.startsAt,
        endsAt: typeof o.endsAt === 'string' ? o.endsAt : undefined,
        location: typeof o.location === 'string' ? o.location : undefined,
        ...(o.invite === 'sender' || o.invite === 'all' ? { invite: o.invite } : {}),
        ...asked,
      },
    ];
  }
  if (o.kind === 'list' && typeof o.listName === 'string') {
    const listName = o.listName;
    const entries = Array.isArray(o.items) ? o.items : [o.item];
    return entries
      .filter((e): e is string => typeof e === 'string')
      .flatMap((e) => splitListEntry(e))
      .map((e) => stripFillerTail(e))
      .filter(Boolean)
      .map((item) => ({ kind: 'list' as const, listName, item, ...asked }));
  }
  if (o.kind === 'advisory' && typeof o.note === 'string' && o.note.trim()) {
    return [{ kind: 'advisory', note: o.note.trim().slice(0, 500) }];
  }
  if (
    o.kind === 'change' &&
    typeof o.target === 'string' &&
    /^[etp]\d{1,2}$/.test(o.target.trim()) &&
    typeof o.action === 'string' &&
    CHANGE_ACTIONS.has(o.action)
  ) {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const why = str(o.why)?.slice(0, 160);
    return [
      {
        kind: 'change',
        target: o.target.trim(),
        action: o.action as ChangeAction,
        ...(str(o.startsAt) ? { startsAt: str(o.startsAt) } : {}),
        ...(str(o.endsAt) ? { endsAt: str(o.endsAt) } : {}),
        ...(str(o.dueAt) ? { dueAt: str(o.dueAt) } : {}),
        ...(why ? { why } : {}),
      },
    ];
  }
  return [];
}

/**
 * Every suggestion in a model reply, in the order the model gave them, capped
 * (ADR 0243). Reads the `{"items":[…]}` envelope, and still reads a bare
 * suggestion object — the shape the prompt asked for before a thread could
 * yield more than one.
 */
export function parseSuggestions(
  raw: string,
  max: number = env.EMAIL_MAGICS_MAX_ITEMS,
): EmailSuggestion[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (typeof obj !== 'object' || obj === null) return [];
  const o = obj as Record<string, unknown>;
  // `kind` first: a bare list suggestion carries its own `items` array, which
  // must not be mistaken for the envelope.
  const found =
    typeof o.kind === 'string'
      ? narrowSuggestion(o)
      : Array.isArray(o.items)
        ? o.items.flatMap(narrowSuggestion)
        : [];
  return capSuggestions(found, max);
}

/** The production extractor — one LLM call per thread. */
export function llmExtractor(): EmailExtractor {
  return {
    async extract(input) {
      const llm = await getLlmForUser(input.db, input.userId, 'email_magics');
      const tz = input.userTz ?? 'UTC';
      const promptFor = (body: string | null, chars: number): string =>
        [
          `User timezone: ${tz} (${offsetScheduleNote(tz)})`,
          input.emailSentAt ? `Email sent: ${input.emailSentAt}` : '',
          `Today: ${new Date().toLocaleString('sv-SE', { timeZone: tz })}`,
          input.worldContext ?? '',
          `Category: ${input.categoryTitle ?? 'unknown'}`,
          input.senderContext ?? '',
          input.participants ?? '',
          `Subject: ${cleanSnippet(input.subject)}`,
          `Preview: ${cleanSnippet(input.snippet)}`,
          body ? `Body: ${cleanBodyText(body).slice(0, chars)}` : '',
          input.attachmentText ? `Attached documents:\n${input.attachmentText}` : '',
          input.icsContext ? `Attached calendar file (authoritative for date/time):\n${input.icsContext}` : '',
        ]
          .filter(Boolean)
          .join('\n');

      // ADR 0184 — swapped once per call, not per token: the sweep and the
      // read-time pass never mix rules within a single extraction.
      const systemPrompt = EXTRACT_SYSTEM.replace(
        '__ON_THE_HOOK_RULE__',
        input.interactive ? ON_THE_HOOK_RULE_INTERACTIVE : ON_THE_HOOK_RULE_SWEEP,
      ).replaceAll('__MAX_ITEMS__', String(Math.max(1, env.EMAIL_MAGICS_MAX_ITEMS)));

      const ask = async (user: string, pass: string): Promise<string> => {
        const cost = trackPassCost();
        const startedAt = Date.now();
        const raw = await llm.complete(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: user },
          ],
          // Room for the capped items plus a delivery/flight/receipt block;
          // 300 fitted exactly one item and cut a second off mid-object.
          { temperature: 0, maxTokens: 600, onUsage: cost.onUsage },
        );
        cost.report({
          pass,
          threads: 1,
          model: llm.defaultModel,
          ms: Date.now() - startedAt,
          userId: input.userId,
        });
        return raw;
      };

      /** Report the side-channel blocks, then hand back the suggestions themselves. */
      const finish = (text: string): EmailSuggestion[] => {
        const delivery = parseDelivery(text);
        if (delivery && input.onDelivery) input.onDelivery(delivery);
        const flight = parseFlight(text);
        if (flight && input.onFlight) input.onFlight(flight);
        const receipt = parseReceipt(text);
        if (receipt && input.onReceipt) input.onReceipt(receipt);
        const scheduling = parseScheduling(text);
        if (scheduling && input.onScheduling) input.onScheduling(scheduling);
        return parseSuggestions(text);
      };

      const raw = await ask(promptFor(input.bodyText, BODY_EXCERPT_CHARS), 'magics');
      // ADR 0110 — the model has just read the excerpt, so it is the one placed
      // to say whether the answer was below it. Reported as its own pass, so
      // the second read shows up in the cost benchmark instead of hiding
      // inside the first.
      if (!parseNeedMore(raw) || !input.readMore) return finish(raw);
      const full = await input.readMore();
      // Against what was SHOWN, not what was handed in. When the caller already
      // held the whole body, `input.bodyText` is the entire message and a
      // re-read comes back the same length or shorter — comparing to that would
      // refuse the escalation in exactly the case there is most left to read.
      const shown = Math.min(input.bodyText?.length ?? 0, BODY_EXCERPT_CHARS);
      if (!full || full.length <= shown) return finish(raw);
      const deep = await ask(promptFor(full, env.EMAIL_DEEP_READ_CHARS), 'magics-deep');
      return finish(deep);
    },
  };
}

/**
 * Store what a delivery email said, and — only when someone must BE there —
 * return the calendar event to offer (ADR 0135).
 *
 * Most parcels are left at the door, and proposing a calendar event for each
 * one would fill Action Items with cards nobody wants (ADR 0092's pile-up) for
 * something the family does not have to show up for (ADR 0100's rule about what
 * a calendar entry IS). A signature, a delivery window or perishables are the
 * exception, and that is a real appointment.
 *
 * The proposal's TTL runs to the day after arrival rather than ADR 0009's 72h:
 * a package shipped today for next Tuesday would otherwise expire before it
 * lands — and land in the 'expired, still owed' count, which is for obligations
 * the user never answered, not for parcels.
 */
async function recordDelivery(
  db: Kysely<DB>,
  thread: { id: string; subject: string; fromEmail: string | null },
  delivery: DeliveryFacts,
  body: { body_text: string | null; body_html?: string | null; body_excerpt: string | null } | undefined,
  utcOffset: string,
  userTz?: string | null,
): Promise<{ args: Record<string, unknown>; ttlMs: number; trackingNumber: string | null } | null> {
  const text = `${thread.subject}
${modelBody(body)}`;
  const tracking = findTracking(text, thread.fromEmail);
  await db
    .updateTable('email_threads')
    .set({
      delivery_json: await sealThreadJsonFor(db, thread.id, 'delivery_json', {
        etaAt: delivery.etaAt,
        carrier: tracking?.carrier ?? null,
        trackingNumber: tracking?.number ?? null,
        needsPresence: delivery.needsPresence,
      }),
    })
    .where('id', '=', thread.id)
    .execute();

  if (!delivery.needsPresence || !delivery.etaAt) return null;
  // A delivery DAY with no window becomes a midnight start, which ADR 0040
  // already treats as all-day. Inventing 9am would be a time the email never
  // gave, on an event the user is being asked to attend. The ETA's own DST
  // side is used when the zone is known — a delivery weeks out crossing a
  // DST boundary must not inherit whatever side was in effect when the mail
  // was classified.
  const startsAt = /^\d{4}-\d{2}-\d{2}$/.test(delivery.etaAt)
    ? `${delivery.etaAt}T00:00:00${
        userTz ? offsetForLocalDatetime(userTz, `${delivery.etaAt}T00:00:00`) : utcOffset
      }`
    : delivery.etaAt;
  const args = { title: `Delivery: ${thread.subject}`.slice(0, 120), startsAt };
  if (!toolSchemas.create_event.safeParse(args).success) return null;
  const livesUntil = Date.parse(startsAt) + 24 * 60 * 60 * 1000 - Date.now();
  if (livesUntil <= 0) return null;
  // Handed back, not staged here: the caller stages everything a thread
  // yields in one locked step (ADR 0244), and two passes over one delivery
  // email each used to add this card.
  return { args, ttlMs: livesUntil, trackingNumber: tracking?.number ?? null };
}

/**
 * One "someone must be home" card per parcel (ADR 0244 addendum). The shipped
 * notice and the out-for-delivery notice are two emails with two subjects, so
 * the event rule cannot see they are one package; the tracking number can.
 * The card from the newest email wins, since its arrival day is the current
 * one. Returns whether to stage, after expiring any card it replaces.
 */
async function shouldStageDeliveryCard(
  db: Kysely<DB>,
  userId: string,
  gid: string,
  trackingNumber: string | null,
): Promise<boolean> {
  if (!trackingNumber) return true;
  const cards = (await pendingEmailEventProposals(db, userId)).filter(
    (p) =>
      p.args.title.startsWith('Delivery: ') &&
      p.provenance?.startsWith('gmail:') &&
      p.provenance !== `gmail:${gid}`,
  );
  if (cards.length === 0) return true;
  const gids = [...new Set(cards.map((c) => c.provenance!.slice('gmail:'.length)))];
  const threads = await db
    .selectFrom('email_threads')
    .select(['gmail_thread_id', 'delivery_json', 'last_message_at'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', 'in', [...gids, gid])
    .execute();
  const byGid = new Map(threads.map((r) => [r.gmail_thread_id, r]));
  const mine = byGid.get(gid)?.last_message_at ?? null;
  const samePackage = cards.filter((c) => {
    const d = byGid.get(c.provenance!.slice('gmail:'.length))?.delivery_json as
      | { trackingNumber?: string | null }
      | null
      | undefined;
    return d?.trackingNumber === trackingNumber;
  });
  if (samePackage.length === 0) return true;
  const newer = samePackage.some(
    (c) => instantMs(byGid.get(c.provenance!.slice('gmail:'.length))?.last_message_at ?? null) > instantMs(mine),
  );
  if (newer) return false;
  await expireProposals(
    db,
    samePackage.map((c) => c.id),
  );
  return true;
}

/**
 * Store what a flight email said (ADR 0138).
 *
 * The identity is PARSED — `findFlight` over the same text, with ADR 0133's
 * corroboration gate — and the times and status are what the model read. So a
 * model that returns a flight block for mail containing no recognisable
 * designator writes nothing: there is no flight to name, and naming one wrong
 * puts a link to somebody else's aeroplane in front of the user.
 *
 * Nothing is proposed here. The calendar event a flight deserves is the
 * extractor's ordinary `create_event` suggestion, which the prompt explicitly
 * keeps — unlike a delivery, a flight is somewhere a person has to be.
 */
async function recordFlight(
  db: Kysely<DB>,
  thread: { id: string; subject: string; fromEmail: string | null },
  flight: FlightFacts,
  body: { body_text: string | null; body_html?: string | null; body_excerpt: string | null } | undefined,
): Promise<void> {
  const text = `${thread.subject}
${modelBody(body)}`;
  const ref = findFlight(text, thread.fromEmail);
  if (!ref) return;
  await db
    .updateTable('email_threads')
    .set({
      flight_json: await sealThreadJsonFor(db, thread.id, 'flight_json', {
        iata: ref.iata,
        number: ref.number,
        ident: ref.ident,
        airline: ref.airline,
        departAt: flight.departAt,
        arriveAt: flight.arriveAt,
        origin: flight.origin,
        destination: flight.destination,
        status: flight.status,
      }),
    })
    .where('id', '=', thread.id)
    .execute();
}

/**
 * Store what a receipt email said (ADR 0160).
 *
 * Nothing is proposed here, same as a delivery: a purchase already settled in
 * full has nothing left to confirm, and the amount is a record to show, not a
 * decision. Stored now regardless of whether Finance (ADR 0070's scaffold)
 * has anywhere to read it yet — the per-thread extraction mark fires once
 * ever, so the alternative is losing the fact permanently and mining it late
 * with no signal left to find it by.
 */
async function recordReceipt(
  db: Kysely<DB>,
  thread: { id: string },
  receipt: ReceiptFacts,
): Promise<void> {
  const fact = {
    merchant: receipt.merchant,
    amount: receipt.amount,
    currency: receipt.currency,
    purchasedAt: receipt.purchasedAt,
    orderNumber: receipt.orderNumber,
    ...(receipt.paymentMethod ? { paymentMethod: receipt.paymentMethod } : {}),
  };
  await db
    .updateTable('email_threads')
    .set({ receipt_json: await sealThreadJsonFor(db, thread.id, 'receipt_json', fact) })
    .where('id', '=', thread.id)
    .execute();
  await keepReceipt(db, thread.id, fact);
}

/**
 * Store the "be careful" note a thread's own content earned (ADR 0180).
 * Never a proposal — there is nothing to confirm about a warning — and never
 * cleared once set: a message does not retroactively stop having looked like
 * a phishing attempt.
 */
async function recordReadAdvisory(db: Kysely<DB>, threadId: string, note: string): Promise<void> {
  await db
    .updateTable('email_threads')
    .set({ read_advisory_json: await sealThreadJsonFor(db, threadId, 'read_advisory_json', { note, severity: 'caution' }) })
    .where('id', '=', threadId)
    .execute();
}

/**
 * How far back a *read* thread may still be mined for obligations (ADR 0143).
 *
 * Deliberately much shorter than `GMAIL_BACKFILL_DAYS`: that window exists so
 * search and context have history to work with, which is a different job from
 * deciding what someone still owes.
 */
function minableSince(): string {
  return new Date(
    Date.now() - env.EMAIL_MINE_READ_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * Top-level categories whose mail is discretionary by nature (ADR 0179): a
 * coupon you MAY redeem, a sale, an editorial digest you subscribed to, a
 * venue's calendar of events you have not booked. Nothing under these is an
 * obligation, so the magics pass skips the thread entirely rather than
 * spending an LLM call to (usually) learn it should emit `none`.
 *
 * The classifier already routes promotional and newsletter-shaped mail here
 * ("a retailer selling something is Coupons however newsletter-shaped it
 * looks"), so an NYAC-style club digest lands under one of these too.
 */
const BROADCAST_ONLY_TOP_LEVELS = new Set(['coupons', 'newsletters']);

/**
 * Category ids whose TOP-LEVEL ancestor is a discretionary-broadcast bucket
 * (ADR 0179). Resolved in JS by walking `parent_id` — a user has tens of
 * categories, and doing it here keeps `LIMIT` honest (the blocked set is
 * excluded in the query, not filtered off the page afterwards).
 */
async function discretionaryBroadcastCategoryIds(
  db: Kysely<DB>,
  userId: string,
): Promise<string[]> {
  const cats = await db
    .selectFrom('email_categories')
    .select(['id', 'parent_id', 'title'])
    .where('user_id', '=', userId)
    .execute();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const rootTitle = (id: string): string => {
    const seen = new Set<string>();
    let node = byId.get(id);
    while (node?.parent_id && !seen.has(node.id)) {
      seen.add(node.id);
      node = byId.get(node.parent_id);
    }
    return (node?.title ?? '').trim().toLowerCase();
  };
  return cats.filter((c) => BROADCAST_ONLY_TOP_LEVELS.has(rootTitle(c.id))).map((c) => c.id);
}

/**
 * ADR 0179 part 4 — retract proposals a discretionary broadcast already
 * produced. Runs in the same per-pass sweep as `retractPastEventProposals`,
 * so the fix is retroactive with no migration and self-heals if the
 * classifier later moves a thread into one of these buckets.
 */
async function retractDiscretionaryBroadcastProposals(
  db: Kysely<DB>,
  userId: string,
  blockedCategoryIds: string[],
): Promise<number> {
  if (blockedCategoryIds.length === 0) return 0;
  const res = await db
    .updateTable('proposals')
    .set({ status: 'expired', resolved_at: new Date().toISOString() })
    .where('proposed_by_user_id', '=', userId)
    .where('status', '=', 'pending')
    .where('tool_name', 'in', ['create_task', 'create_event', 'add_list_item'])
    .where('provenance', 'like', 'gmail:%')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('email_threads')
          .select('email_threads.id')
          .where('email_threads.user_id', '=', userId)
          .where('email_threads.category_id', 'in', blockedCategoryIds)
          .whereRef(
            'email_threads.gmail_thread_id',
            '=',
            sql<string>`substring(proposals.provenance from 7)`,
          ),
      ),
    )
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/** The owner's non-personal groups — the only fan-out targets (ADR 0032: own groups only). */
async function loadUserGroups(db: Kysely<DB>, userId: string): Promise<GroupCandidate[]> {
  return db
    .selectFrom('groups')
    .innerJoin('group_members', 'group_members.group_id', 'groups.id')
    .where('group_members.user_id', '=', userId)
    .where('groups.kind', '!=', 'personal')
    .select(['groups.id as id', 'groups.name as name'])
    .execute();
}

export interface MagicsResult {
  events: number;
  lists: number;
  /** ADR 0132 - obligations with a deadline, staged as create_task. */
  tasks: number;
  /** ADR 0158 - threads that staged a trip proposal bundle (flight or hotel). */
  trips: number;
  /** ADR 0168 - threads that applied a booking cancellation. */
  cancellations: number;
  processed: number;
  /** Proposals routed to a shared group (vs. staged personally). */
  routed: number;
}

/**
 * Anti-join subquery: has this thread already been mined for `kind`? Marks
 * live in `email_extraction_marks`, keyed by gmail_thread_id, so they
 * SURVIVE a mirror wipe (disconnect / provider flip) — a reconnect must
 * never re-stage proposals the user already saw (supersedes the legacy
 * `email_threads.*_processed_at` columns).
 */
export function extractionMarkQuery(
  eb: ExpressionBuilder<DB, 'email_threads'>,
  userId: string,
  kind: 'magic' | 'person' | 'read',
) {
  return eb
    .selectFrom('email_extraction_marks')
    .select('email_extraction_marks.gmail_thread_id')
    .whereRef(
      'email_extraction_marks.gmail_thread_id',
      '=',
      'email_threads.gmail_thread_id',
    )
    .where('email_extraction_marks.user_id', '=', userId)
    .where('email_extraction_marks.kind', '=', kind)
    .$if(kind !== 'person', (qb) => qb.where(markStillCurrent('email_extraction_marks.created_at')));
}

/**
 * ADR 0315 — a suggestion mark covers the conversation as it stood when it
 * was written. A message from someone else arriving after it ("10 AM works"
 * answering "how is Thursday after 10?") is a new ask, so the mark stops
 * counting and the thread is read again. The user's own sent mail does not
 * reopen it: what they wrote is not something for them to act on.
 *
 * Person extraction (ADR 0076) keeps its once-ever mark: a fact does not go
 * stale the way an ask does.
 */
function markStillCurrent(markCreatedAt: string) {
  return sql<boolean>`NOT EXISTS (
    SELECT 1 FROM email_messages nm
    WHERE nm.thread_id = email_threads.id
      AND NOT (nm.gmail_label_ids @> '["SENT"]'::jsonb)
      AND ${textInstant('nm.internal_date')} > ${textInstant(markCreatedAt)}
  )`;
}

/**
 * The same mail, mined once — however many of the user's mailboxes it landed
 * in (bug 12, owner decision 2026-08-24: "we know we have seen the email, we
 * move on").
 *
 * Being cc'd at two of your own addresses is ordinary, and ADR 0080 stores
 * provider ids ACCOUNT-PREFIXED, so one message becomes two `email_threads`
 * rows with two different `gmail_thread_id`s — and the mark above, keyed on
 * that id, considers them unrelated. Both get mined, both stage proposals.
 *
 * `rfc822_message_id` is the identity that survives the crossing: RFC 5322
 * makes it globally unique, it is part of the message rather than the
 * mailbox, and all four providers already store it (Gmail's `Message-ID`
 * header, Graph's `internetMessageId`, IMAP's parsed `messageId`).
 *
 * So: has ANY message of this thread already been mined under any thread id?
 * Deliberately a match on *any* message rather than the whole set — two
 * mailboxes cc'd on one conversation need not hold identical message sets,
 * and once we have read the conversation we are done with it.
 *
 * A message with no `rfc822_message_id` simply falls back to the per-thread
 * mark: SQL never joins NULL to NULL, so it can't collapse unrelated mail.
 */
export function crossAccountMarkQuery(
  eb: ExpressionBuilder<DB, 'email_threads'>,
  userId: string,
  kind: 'magic' | 'person' | 'read',
) {
  return eb
    .selectFrom('email_messages as mine')
    .innerJoin('email_messages as seen', 'seen.rfc822_message_id', 'mine.rfc822_message_id')
    .innerJoin('email_extraction_marks as mk', 'mk.gmail_thread_id', 'seen.gmail_thread_id')
    .select('mine.id')
    .whereRef('mine.thread_id', '=', 'email_threads.id')
    .where('mine.user_id', '=', userId)
    .where('seen.user_id', '=', userId)
    .where('mk.user_id', '=', userId)
    .where('mk.kind', '=', kind)
    .where('mine.rfc822_message_id', 'is not', null)
    .$if(kind !== 'person', (qb) => qb.where(markStillCurrent('mk.created_at')));
}

/** Record that a thread was mined for `kind`. A re-read (ADR 0315) moves the
 *  mark forward, so it covers the messages that read saw. */
export async function markThreadExtracted(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
  kind: 'magic' | 'person' | 'read',
  now: string,
): Promise<void> {
  await db
    .insertInto('email_extraction_marks')
    .values({ user_id: userId, gmail_thread_id: gmailThreadId, kind, created_at: now })
    .onConflict((oc) =>
      kind === 'person'
        ? oc.columns(['user_id', 'gmail_thread_id', 'kind']).doNothing()
        : oc.columns(['user_id', 'gmail_thread_id', 'kind']).doUpdateSet({ created_at: now }),
    )
    .execute();
}

/**
 * ADR 0329 — one model read per email. The sweep's read is told who sent the
 * mail (ADR 0294) and stores any advisory, so it is a complete read-time
 * read too, and the read-time pass already runs the sweep's invite and trip
 * steps. Whichever reads the email first writes both marks and the other
 * re-serves its result. The read-time pass writes `magic` only once the
 * thread is sorted: an unsorted email skipped the travel short-circuit
 * (`stageTripIfTravel` keys on the category), so the sweep still reads it.
 */
async function markEmailRead(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
  now: string,
  opts: { sorted: boolean } = { sorted: true },
): Promise<void> {
  if (opts.sorted) await markThreadExtracted(db, userId, gmailThreadId, 'magic', now);
  await markThreadExtracted(db, userId, gmailThreadId, 'read', now);
}

/** Is this thread's mark for `kind` still current? A single-row check, unlike
 *  `extractionMarkQuery`'s anti-join (built for a batch WHERE clause). */
async function hasExtractionMark(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  kind: 'magic' | 'person' | 'read',
): Promise<boolean> {
  const row = await db
    .selectFrom('email_threads')
    .select('email_threads.id')
    .where('email_threads.id', '=', threadRowId)
    .where((eb) => eb.exists(extractionMarkQuery(eb, userId, kind)))
    .executeTakeFirst();
  return !!row;
}

/**
 * Was another mailbox's copy of this thread already given its read-time
 * check (`crossAccountMarkQuery`)? If so, that copy's advisory, if any.
 */
async function twinReadCheck(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
): Promise<{ checked: boolean; advisory: EmailReadAdvisory | null }> {
  const hit = await db
    .selectFrom('email_threads')
    .select('email_threads.id')
    .where('email_threads.id', '=', threadRowId)
    .where((eb) => eb.exists(crossAccountMarkQuery(eb, userId, 'read')))
    .executeTakeFirst();
  if (!hit) return { checked: false, advisory: null };
  const twin = await db
    .selectFrom('email_messages as mine')
    .innerJoin('email_messages as seen', 'seen.rfc822_message_id', 'mine.rfc822_message_id')
    .innerJoin('email_threads as tw', 'tw.id', 'seen.thread_id')
    .select('tw.read_advisory_json as advisory')
    .where('mine.thread_id', '=', threadRowId)
    .where('mine.user_id', '=', userId)
    .where('seen.user_id', '=', userId)
    .where('tw.user_id', '=', userId)
    .where('tw.id', '!=', threadRowId)
    .where('tw.read_advisory_json', 'is not', null)
    .limit(1)
    .executeTakeFirst();
  return { checked: true, advisory: twin?.advisory ?? null };
}

/** Newest message's sent instant: the raw `Date` header when mirrored (it
 *  carries the sender's offset), else the UTC `internal_date`. */
export function sentAtFromMessage(
  row: { internal_date: string; headers_json: Record<string, string | null> } | undefined,
): string | null {
  if (!row) return null;
  try {
    const h =
      typeof row.headers_json === 'string'
        ? (JSON.parse(row.headers_json) as Record<string, string | null>)
        : row.headers_json;
    if (h && typeof h.date === 'string' && h.date) return h.date;
  } catch {
    // fall through to internal_date
  }
  return row.internal_date ?? null;
}

/**
 * Extracted text of a thread's KB-imported attachments (ADR 0071 stores the
 * copies with `origin_email_thread_id` + full text). Bounded hard: newest 3
 * files, 4k chars each, 8k total — enough for a newsletter's date table
 * without shipping a whole handbook to the LLM.
 */
async function attachmentTextForThread(
  db: Kysely<DB>,
  threadRowId: string,
): Promise<string | null> {
  const rows = await db
    .selectFrom('attachments')
    .select(['filename', 'summary', 'extracted_text'])
    .where('origin_email_thread_id', '=', threadRowId)
    .orderBy('created_at', 'desc')
    .limit(3)
    .execute();
  if (rows.length === 0) return null;
  const parts = rows
    .map((r) => {
      const text = (r.extracted_text ?? r.summary ?? '').trim().slice(0, 4000);
      return text ? `--- ${r.filename} ---\n${text}` : '';
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n').slice(0, 8000) : null;
}

/** The subset of an `email_threads` row `extractAndStage` needs — shared by
 *  the batch sweep's query and the interactive single-thread lookup. */
interface ExtractStageThread {
  id: string;
  gid: string;
  subject: string;
  snippet: string;
  fromEmail: string | null;
  fromName?: string | null;
  catId: string | null;
  cat: string | null;
}

/** ADR 0268 — what the newest message SHOWS a person, never a hidden part. */
export function modelBody(
  body: { body_text: string | null; body_html?: string | null; body_excerpt: string | null } | undefined,
): string {
  if (!body) return '';
  return bodyForModel({ html: body.body_html, text: body.body_text, excerpt: body.body_excerpt });
}

export type ExtractStageBodyRow =
  | {
      id: string;
      gmail_message_id: string | null;
      body_text: string | null;
      body_html: string | null;
      body_excerpt: string | null;
      internal_date: string;
      headers_json: Record<string, string | null>;
      from_email?: string | null;
      from_name?: string | null;
      to_emails?: string[];
      cc_emails?: string[];
    }
  | undefined;

/**
 * The newest message's From / To / Cc, as the model sees them, and which of
 * those addresses is the user. Without the "You" line every ask read as the
 * user's, so a request to the To person staged a card for someone on Cc.
 */
export function participantsLine(body: ExtractStageBodyRow, own: readonly string[]): string | null {
  if (!body?.from_email) return null;
  const from = body.from_name ? `${body.from_name} <${body.from_email}>` : body.from_email;
  const to = (body.to_emails ?? []).join(', ');
  const cc = (body.cc_emails ?? []).join(', ');
  const line = `Participants: From ${from}${to ? `; To ${to}` : ''}${cc ? `; Cc ${cc}` : ''}`;
  const you = youLine(body, own);
  return you ? `${line}\n${you}` : line;
}

function youLine(body: NonNullable<ExtractStageBodyRow>, own: readonly string[]): string | null {
  if (own.length === 0) return null;
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const hit = (list: string[] | undefined) => (list ?? []).find((a) => mine.has(a.toLowerCase()));
  const onTo = hit(body.to_emails);
  if (onTo) return `You: ${onTo} (on To)`;
  const onCc = hit(body.cc_emails);
  if (onCc) return `You: ${onCc} (on Cc only)`;
  if (body.from_email && mine.has(body.from_email.toLowerCase())) return `You: ${body.from_email} (the sender)`;
  return `You: ${own[0]} (not on To or Cc)`;
}

/** The names an email may use for the user. */
async function userNames(db: Kysely<DB>, userId: string): Promise<string[]> {
  const u = await db
    .selectFrom('users')
    .select(['display_name', 'first_name'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return [u?.display_name, u?.first_name].filter((n): n is string => !!n);
}

/**
 * Items the email asks of SOMEONE ELSE on it ("Hi Tom, when are you free?"
 * with the user on Cc) are theirs, not the user's: dropped before the cap so
 * they never take a card's place. The model names who is asked; code decides
 * whether that is the user (`asked-of.ts`).
 */
export function dropAsksOfOthers(
  found: EmailSuggestion | EmailSuggestion[] | null,
  body: ExtractStageBodyRow,
  me: readonly string[],
): EmailSuggestion[] {
  const items = found ? (Array.isArray(found) ? found : [found]) : [];
  if (!body) return items;
  const mine = new Set(me.map((a) => a.toLowerCase()));
  const others = [
    body.from_name ?? '',
    body.from_email ?? '',
    ...(body.to_emails ?? []),
    ...(body.cc_emails ?? []),
  ].filter((a) => a && !mine.has(a.toLowerCase()));
  return items.filter((s) => {
    const askedOf = s.kind === 'task' || s.kind === 'event' || s.kind === 'list' ? s.askedOf : undefined;
    return !askedSomeoneElse(askedOf, { me, others });
  });
}

interface ExtractStageCtx {
  extractor: EmailExtractor;
  personalGroupId: string;
  groups: GroupCandidate[];
  userTz: string | null;
  /** ADR 0088 — the batch's snapshot, labelled per email (ADR 0248). */
  world: MagicsWorldContext | null;
  /** ADR 0177 — set only when a non-invite `.ics` was found on this message
   *  (the batch loop's own invite probe); undefined wherever that probe
   *  didn't run (the interactive read-time pass, ADR 0180). */
  icsDateHint?: string;
  icsContext?: string;
  /** ADR 0110 — shared across every thread in ONE call to this function's
   *  caller, so a batch of many threads still has a single ceiling; the
   *  interactive pass passes its own small budget for its one thread. */
  deepReadBudget: { used: number; max: number };
  /** ADR 0184 — set only by the interactive read-time pass. See
   *  `MagicThreadInput.interactive`. */
  interactive?: boolean;
  /** ADR 0294 — see `MagicThreadInput.senderContext`. */
  senderContext?: string | null;
}

/**
 * ADR 0294 addendum — no suggestions from a sender the code check calls
 * dangerous (a brand from someone else's domain, a look-alike domain, failed
 * DMARC...). Decided in code, before any model call, because the model was
 * shown the same findings and still turned a phishing email's "call us at
 * <their number>" into a to-do. Cards already staged from the email (an
 * earlier pass, or before this rule) are withdrawn. Every pass that stages
 * from an email asks this first, so none can disagree.
 */
async function suppressedForSender(
  db: Kysely<DB>,
  userId: string,
  t: { id: string; gid: string },
): Promise<boolean> {
  if (!(await isDangerousSender(db, userId, t.id))) return false;
  const withdrawn = await retractByProvenance(db, userId, [`gmail:${t.gid}`]);
  logger.info('email suggestions suppressed: dangerous sender', {
    userId,
    threadId: t.id,
    withdrawn: withdrawn.length,
  });
  return true;
}

/** Proposals staged from one thread, by kind (ADR 0243). */
interface ExtractStageOutcome {
  events: number;
  tasks: number;
  lists: number;
  advisory: boolean;
  /** ADR 0248 — change cards staged plus suggestions taken back. */
  changes?: number;
  /** How many of those proposals a routing rule sent to a shared group. */
  routed: number;
}

/**
 * The actual "read the message, decide, stage" step shared by the background
 * sweep (`runEmailMagics`) and the interactive read-time pass
 * (`runReadTimeEmailMagics`, ADR 0180) — one implementation of "should this
 * stage a proposal" so the two callers can never disagree about it (the ADR
 * 0085 lesson). The invite read is `stageInviteIfInvite` and the travel
 * short-circuit `stageTripIfTravel`; BOTH callers run both first (ADR 0074,
 * ADR 0244). Leaving the invite read to the sweep let the read-time pass
 * stage a model-guessed time for an Outlook invite before it. The old
 * reasoning here, that `threadAlreadyProposed` stops a twin of whatever the
 * batch loop staged, only held when the batch loop went first.
 */
async function extractAndStage(
  db: Kysely<DB>,
  userId: string,
  t: ExtractStageThread,
  body: ExtractStageBodyRow,
  ctx: ExtractStageCtx,
): Promise<ExtractStageOutcome> {
  const provenance = `gmail:${t.gid}`;
  // ADR 0243 — a thread is staged from ONCE per message (ADR 0315: a newer
  // message is a new ask). Read before anything this call writes (a delivery
  // that needs someone home stages its own proposal below).
  const readAt = body?.internal_date ?? null;
  const alreadyStaged = await threadAlreadyProposed(db, userId, provenance, undefined, readAt);
  const own = body?.from_email ? await ownAddresses(db, userId) : [];

  // ADR 0110 — offered while the budget lasts, whenever there is more text
  // than the extractor will show.
  //
  // The test is on LENGTH, not on which column the text came from. A thread
  // a human opened holds the whole message in `body_text` — 23 KB on
  // average in prod — and the extractor still shows only the first 2,000
  // characters of it; gating on "the excerpt is all we have" would starve
  // exactly the threads where the rest is already sitting in the row.
  // An excerpt shorter than the cap IS the whole message; one at the cap
  // means there was more.
  const messageRowId = body?.id ?? null;
  const available = modelBody(body) || null;
  const truncated = (available?.length ?? 0) >= BODY_EXCERPT_CHARS;
  const readMore =
    messageRowId && truncated && ctx.deepReadBudget.used < ctx.deepReadBudget.max
      ? async (): Promise<string | null> => {
          ctx.deepReadBudget.used += 1;
          return fetchFullBodyText(db, userId, messageRowId);
        }
      : undefined;

  // ADR 0135 — a delivery email states its arrival; the tile was rendering
  // the word "shipped" and dropping it. Captured here because this is the
  // only pass holding the body, and stored rather than proposed: an
  // arrival date is a fact to show, not a decision to approve.
  let delivery: DeliveryFacts | null = null;
  // ADR 0138 — the same trade for a flight: what the mail says about the
  // times is read here, where the body is, and the designator is parsed
  // out of it. Both are stored, so the tile can render a link at a moment
  // when no model can run.
  let flight: FlightFacts | null = null;
  // ADR 0160 — same trade again for a receipt: mined here, where the body
  // is, and stored for a future Finance feature to read.
  let receipt: ReceiptFacts | null = null;
  // ADR 0346 - what the email says about the meeting it arranges.
  let scheduling: SchedulingBlock | null = null;

  // ADR 0248 — labels the model can name in a "change", plus the events on
  // the days this email names or from its sender, which the batch's
  // soonest-first list may have cut.
  const labelled = ctx.world
    ? formatLabelledWorld(ctx.world, ctx.userTz, {
        excludeProvenance: provenance,
        extraEvents: await loadThreadEvents(db, userId, {
          text: `${t.subject}\n${modelBody(body) || t.snippet || ''}`,
          fromEmail: t.fromEmail,
          tz: ctx.userTz,
          exclude: new Set(ctx.world.events.map((e) => e.id).filter((id): id is string => !!id)),
        }),
      })
    : { block: null, targets: new Map() };
  const input: MagicThreadInput = {
    subject: t.subject,
    snippet: t.snippet,
    bodyText: modelBody(body) || null,
    onDelivery: (facts) => {
      delivery = facts;
    },
    onFlight: (facts) => {
      flight = facts;
    },
    onReceipt: (facts) => {
      receipt = facts;
    },
    onScheduling: (block) => {
      scheduling = block;
    },
    attachmentText: await attachmentTextForThread(db, t.id),
    categoryTitle: t.cat ?? null,
    userTz: ctx.userTz,
    emailSentAt: sentAtFromMessage(body),
    readMore,
    worldContext: labelled.block,
    icsContext: ctx.icsContext,
    interactive: ctx.interactive,
    senderContext: ctx.senderContext ?? null,
    participants: participantsLine(body, own),
    userId,
    db,
  };
  const suggestions = capSuggestions(dropAsksOfOthers(await ctx.extractor.extract(input), body, [...own, ...(await userNames(db, userId))]));
  // ADR 0346 - whether anything here is asked of the user, for the scheduling block.
  const askedOfUser = suggestions.length > 0;
  // An invitation is answered with its own Yes / Maybe / No card (ADR 0104).
  // On a thread that holds one, the model's event is the same meeting read
  // worse, and its "invite the sender" sends the organizer an invitation to
  // their own meeting; an RSVP to-do repeats the card.
  if (await threadHoldsInvite(db, userId, t.id, provenance)) {
    for (let i = suggestions.length - 1; i >= 0; i -= 1) {
      if (answersTheInvite(suggestions[i]!)) suggestions.splice(i, 1);
    }
  }
  if (flight) anchorFlightTimes(flight, suggestions, ctx.userTz);
  // ADR 0244 — a time after a daylight-saving change, stamped with today's
  // offset. A flight's own endpoints were just put on their airports'
  // clocks and are not the reader's to move; nor is anything when the email
  // names a zone itself.
  if (ctx.userTz && !namesATimeZone(`${t.subject}\n${input.bodyText ?? ''}`)) {
    const f = flight as FlightFacts | null;
    const isFlightEnd = (iso: string): boolean =>
      !!f && (sameInstant(iso, f.departAt) || sameInstant(iso, f.arriveAt));
    for (const s of suggestions) {
      if (s.kind === 'event') {
        // ADR 0245 — a dinner in Denver is on Denver's clock. Where the
        // location is a place the table knows, the time goes there; a place
        // it does not know leaves the time on the reader's clock for that
        // date, which is all there is to go on.
        const readerNow = tzToOffsetMinutes(ctx.userTz) ?? undefined;
        const onClock = (iso: string): string => {
          const there = s.location ? placeDatetime(iso, s.location, readerNow, ctx.userTz) : null;
          return there?.zone ? there.at : reanchorNowStampedOffset(iso, ctx.userTz);
        };
        if (!isFlightEnd(s.startsAt)) s.startsAt = onClock(s.startsAt);
        if (s.endsAt && !isFlightEnd(s.endsAt)) s.endsAt = onClock(s.endsAt);
      } else if (s.kind === 'task' && s.dueAt) {
        s.dueAt = reanchorNowStampedOffset(s.dueAt, ctx.userTz);
      } else if (s.kind === 'change') {
        if (s.startsAt) s.startsAt = reanchorNowStampedOffset(s.startsAt, ctx.userTz);
        if (s.endsAt) s.endsAt = reanchorNowStampedOffset(s.endsAt, ctx.userTz);
        if (s.dueAt) s.dueAt = reanchorNowStampedOffset(s.dueAt, ctx.userTz);
      }
    }
  }
  // ADR 0177 — same year-anchor backstop as the trip classifier: an
  // attached .ics's date is exact, so a wrong-year guess in the general
  // extractor's own output (month/day agreeing, year not) is corrected
  // against it rather than trusted as written.
  for (const s of suggestions) {
    if (s.kind === 'event' || (s.kind === 'change' && s.startsAt)) {
      const corr = icsYearCorrection(ctx.icsDateHint, s.startsAt!);
      if (corr !== 0) {
        s.startsAt = shiftYear(s.startsAt!, corr);
        if (s.endsAt) s.endsAt = shiftYear(s.endsAt, corr);
      }
    } else if (s.kind === 'task' && s.dueAt) {
      const corr = icsYearCorrection(ctx.icsDateHint, s.dueAt);
      if (corr !== 0) s.dueAt = shiftYear(s.dueAt, corr);
    }
  }
  const outcome: ExtractStageOutcome = { events: 0, tasks: 0, lists: 0, advisory: false, routed: 0 };
  const advisory = suggestions.find((s) => s.kind === 'advisory');
  const actions = suggestions.filter((s) => s.kind !== 'advisory' && s.kind !== 'change');
  const changes = suggestions.filter((s): s is ChangeSuggestion => s.kind === 'change');
  // ADR 0097 — routing to a shared group is a DECISION, and only the owner
  // makes it. A user-declared rule (ADR 0077: "school email → family") is
  // that decision, made once in advance, so it still routes. Unruled email
  // does not: `targetGroupId` stays null, the confirmed item lands in the
  // owner's personal group, and moving it somewhere shared takes an
  // explicit pick at confirm time. The LLM no longer chooses.
  let targetGroupId: string | null = null;
  if (actions.length > 0 && ctx.groups.length > 0) {
    targetGroupId = await matchRoutingRule(db, userId, {
      fromEmail: t.fromEmail,
      categoryTitle: t.cat,
    });
  }
  const tzOffset = tzToOffset(ctx.userTz ?? 'UTC');
  const deliveryEvent = delivery
    ? await recordDelivery(db, t, delivery, body, tzOffset, ctx.userTz)
    : null;
  if (flight) await recordFlight(db, t, flight, body);
  if (receipt) await recordReceipt(db, t, receipt);

  if (advisory?.kind === 'advisory') {
    await recordReadAdvisory(db, t.id, advisory.note);
    outcome.advisory = true;
    return outcome;
  }
  // ADR 0346 - kept on the thread, and moves the thread's meeting record.
  const schedulingBlock = scheduling as SchedulingBlock | null;
  let schedFacts: SchedulingFacts | null = null;
  if (schedulingBlock && body) {
    const sentAt = sentAtFromMessage(body);
    const sentMs = sentAt ? Date.parse(sentAt) : NaN;
    const facts = finishScheduling(
      schedulingBlock,
      {
        bodyText: modelBody(body) || null,
        fromEmail: body.from_email ?? null,
        fromName: body.from_name ?? null,
        toEmails: body.to_emails ?? [],
        ccEmails: body.cc_emails ?? [],
        sentDay: svWall(Number.isFinite(sentMs) ? new Date(sentMs) : new Date(), ctx.userTz ?? 'UTC').slice(0, 10),
        sentAt: Number.isFinite(sentMs) ? new Date(sentMs).toISOString() : null,
      },
      own,
      { askedOfUser },
    );
    await recordScheduling(db, t.id, facts);
    schedFacts = facts;
    try {
      await recordMeetingFromEmail(db, userId, provenance, facts, facts.addressed === 'sender' ? 'me' : 'them', {
        tz: ctx.userTz ?? null,
        own,
        people: { fromEmail: body.from_email ?? null, toEmails: body.to_emails ?? [], ccEmails: body.cc_emails ?? [] },
      });
    } catch (err) {
      logger.warn('meeting record update failed', { userId, threadId: t.id, err: (err as Error).message });
    }
  }
  // ADR 0248 — what the email changes about things the user already has.
  // Under the thread's and the user's lock, so neither two passes over this
  // email nor two emails about the same booking (the cancellation and its
  // follow-up) can both stage the card; the service skips a target that
  // already has one.
  if (changes.length > 0) {
    const changed = await withEmailStagingLocks(db, userId, provenance, (trx) =>
      applyEmailChanges(trx, {
        userId,
        personalGroupId: ctx.personalGroupId,
        userTz: ctx.userTz,
        provenance,
        changes,
        targets: labelled.targets,
      }),
    );
    outcome.changes = changed.staged + changed.withdrawn;
  }
  if (alreadyStaged) return outcome;

  // Collected first; checked against other cards and written together under
  // the thread's AND the user's staging lock (ADR 0244 + addendum). Checked
  // before the lock, two emails with the same ask both read "no card yet".
  type Candidate = {
    toolName: string;
    args: Record<string, unknown>;
    targetGroupId: string | null;
    ttlMs?: number;
    counts?: 'events' | 'tasks' | 'lists';
    check: (trx: Kysely<DB>) => Promise<boolean>;
  };
  const candidates: Candidate[] = [];
  if (deliveryEvent) {
    const { args, ttlMs, trackingNumber } = deliveryEvent;
    const parsed = toolSchemas.create_event.safeParse(args);
    if (parsed.success) {
      candidates.push({
        toolName: 'create_event',
        args,
        ttlMs,
        targetGroupId: null,
        check: async (trx) =>
          (await shouldStageDeliveryCard(trx, userId, t.gid, trackingNumber)) &&
          shouldStageEventProposal(trx, userId, parsed.data, { tzOffset }),
      });
    }
  }

  // Entries for one list arrive as separate suggestions and leave as ONE
  // proposal — `add_list_item` takes several, and three cards for one
  // shopping trip is the pile-up the cap exists to prevent.
  const listEntries = new Map<string, { listName: string; items: string[] }>();
  for (const s of actions) {
    if (s.kind === 'event') {
      // ADR 0315 addendum — the card names who will be invited; the
      // invitations go out only when the user confirms it.
      const invitees =
        s.invite && body
          ? meetingInvitees(
              s.invite,
              { from: body.from_email ?? null, to: body.to_emails ?? [], cc: body.cc_emails ?? [] },
              own,
            )
          : [];
      // ADR 0346 phase 5 - a meeting with people on this email: who sends
      // the invite decides whether there is a card at all, and the format
      // fills the location (a link already in the email is the call).
      let plan: MeetingCardPlan = { skip: false };
      if (s.invite && schedFacts && schedFacts.addressed !== 'sender') {
        plan = meetingCardPlan(
          {
            // Read from the recipient's side on someone else's message.
            sender: schedFacts.inviteBy,
            viaAssistant: schedFacts.writer === 'assistant',
            format: schedFacts.format,
            ...(schedFacts.link ? { link: schedFacts.link } : {}),
            ...(schedFacts.place ? { place: schedFacts.place } : {}),
            ...(schedFacts.phone ? { phone: schedFacts.phone } : {}),
          },
          s.location,
        );
        // They send it: the slot is held (phase 4) and their invitation
        // becomes the card; a card here would send the organizer a second
        // invitation to their own meeting.
        if (plan.skip) continue;
      }
      const args = {
        title: s.title,
        startsAt: s.startsAt,
        ...(s.endsAt ? { endsAt: s.endsAt } : {}),
        ...(plan.location ?? s.location ? { location: plan.location ?? s.location } : {}),
        ...(invitees.length > 0 ? { invitees } : {}),
        ...(invitees.length > 0 && plan.videoCall ? { videoCall: true } : {}),
        ...(invitees.length > 0 && plan.whoSends ? { whoSends: plan.whoSends } : {}),
      };
      const parsedEvent = toolSchemas.create_event.safeParse(args);
      if (!parsedEvent.success) continue;
      candidates.push({
        toolName: 'create_event',
        args,
        targetGroupId,
        counts: 'events',
        check: (trx) => shouldStageEventProposal(trx, userId, parsedEvent.data, { tzOffset, provenance }),
      });
    } else if (s.kind === 'task') {
      const reply = s.reply === true || REPLY_TITLE.test(s.title);
      const args = {
        title: s.title,
        ...(s.dueAt ? { dueAt: s.dueAt } : {}),
        ...(reply ? { closesOnReply: true } : {}),
      };
      if (!toolSchemas.create_task.safeParse(args).success) continue;
      candidates.push({
        toolName: 'create_task',
        args,
        targetGroupId,
        counts: 'tasks',
        // ADR 0314 — a reply the user already sent needs no card.
        check: async (trx) =>
          !(reply && (await threadAlreadyAnswered(trx, userId, t.gid))) &&
          (await shouldStageTaskProposal(trx, userId, { title: s.title, dueAt: s.dueAt }, { tzOffset })),
      });
    } else if (s.kind === 'list') {
      const key = listNameKey(s.listName);
      const held = listEntries.get(key) ?? { listName: s.listName, items: [] };
      if (!held.items.includes(s.item)) held.items.push(s.item);
      listEntries.set(key, held);
    }
  }
  for (const { listName, items } of listEntries.values()) {
    if (!toolSchemas.add_list_item.safeParse({ listName, items }).success) continue;
    const kept: string[] = [];
    candidates.push({
      toolName: 'add_list_item',
      // Filled by `check`: only the entries no other card already carries.
      args: { listName, items: kept },
      targetGroupId,
      counts: 'lists',
      check: async (trx) => {
        for (const item of items) {
          if (await shouldStageListItemProposal(trx, userId, { listName, item })) kept.push(item);
        }
        return kept.length > 0;
      },
    });
  }
  if (candidates.length === 0) return outcome;
  const staged = await withEmailStagingLocks(db, userId, provenance, async (trx) => {
    if (await threadAlreadyProposed(trx, userId, provenance, undefined, readAt)) return false;
    let wrote = 0;
    for (const c of candidates) {
      if (!(await c.check(trx))) continue;
      await createProposal(trx, {
        groupId: ctx.personalGroupId,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: c.toolName,
        args: c.args,
        provenance,
        targetGroupId: c.targetGroupId,
        ...(c.ttlMs ? { ttlMs: c.ttlMs } : {}),
      });
      wrote += 1;
      if (c.counts) outcome[c.counts] += 1;
      if (c.counts && c.targetGroupId) outcome.routed += 1;
    }
    if (wrote > 0 && readAt) await retractSupersededEmailProposals(trx, userId, provenance, readAt);
    return true;
  });
  return staged ? outcome : { events: 0, tasks: 0, lists: 0, advisory: false, routed: 0 };
}

/**
 * ADR 0158's travel short-circuit, for BOTH passes (ADR 0244): a `travel/*`
 * thread goes to the trip classifier, and whatever it stages (or finds
 * already booked) is that thread's one outcome. Anything but `'none'` means
 * the caller must not also run the general extractor.
 */
async function stageTripIfTravel(
  db: Kysely<DB>,
  userId: string,
  t: { gid: string; subject: string; catId: string | null },
  bodyText: string,
  ctx: {
    personalGroupId: string;
    userTz: string | null;
    icsDateHint?: string;
    tripClassifier?: TravelClassifier;
  },
): Promise<StageEmailTripResult> {
  if (!env.EMAIL_TRIPS_ENABLED || !(t.catId ?? '').toLowerCase().includes('travel')) return 'none';
  return stageEmailTripProposal(
    db,
    {
      userId,
      personalGroupId: ctx.personalGroupId,
      gmailThreadId: t.gid,
      subject: t.subject,
      bodyText,
      userLastTz: ctx.userTz,
      icsDateHint: ctx.icsDateHint,
    },
    ctx.tripClassifier,
  );
}

const RSVP_TASK =
  /\b(rsvp|accept|decline|respond to|reply to|answer)\b.*\b(invit|meeting|call|event)|\bconfirm (your )?attendance\b/i;

/** A suggestion that only re-states an invitation already on this thread. */
export function answersTheInvite(s: EmailSuggestion): boolean {
  if (s.kind === 'event') return true;
  return s.kind === 'task' && RSVP_TASK.test(s.title);
}

/**
 * Whether this thread holds a calendar invitation anywhere in it, not only in
 * its newest message: an .ics with an iTIP method on any message, or a card
 * (any status) staged from an invite on this thread. The invite read looks at
 * the newest message only, so a plain follow-up under an invite reached the
 * model with the invitation quoted.
 */
export async function threadHoldsInvite(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  provenance: string,
): Promise<boolean> {
  const icsRows = await db
    .selectFrom('email_messages')
    .select('ics_text')
    .where('user_id', '=', userId)
    .where('thread_id', '=', threadRowId)
    .where('ics_text', 'is not', null)
    .where('ics_text', '<>', '')
    .execute();
  for (const r of icsRows) {
    if (r.ics_text && probeResultFromIcs(Buffer.from(r.ics_text, 'utf8')).isInvite) return true;
  }
  const cards = await db
    .selectFrom('proposals')
    .select('args_json')
    .where('proposed_by_user_id', '=', userId)
    .where('provenance', '=', provenance)
    .where('tool_name', '=', 'create_event')
    .execute();
  return cards.some((c) => {
    try {
      return Boolean((JSON.parse(c.args_json) as { externalUid?: unknown }).externalUid);
    } catch {
      return false;
    }
  });
}

/** What the invite read found (ADR 0074), for the caller to act on. */
type InviteStep =
  /** The check itself failed: skip WITHOUT a mark so the thread retries. */
  | { kind: 'deferred' }
  /** An invite (or a cancellation / RSVP notice): this thread's one outcome. */
  | { kind: 'invite'; staged: boolean }
  /** Not an invite. A published .ics still grounds the date (ADR 0177). */
  | { kind: 'none'; icsDateHint?: string; icsContext?: string };

/**
 * ADR 0074's invite read, for BOTH passes - the sweep and the read-time pass
 * (ADR 0180/0219). An invite carries authoritative structured times, so it
 * is parsed, never handed to the model: the read-time pass once skipped this,
 * and an Outlook invite whose body has no time got a model-guessed midnight
 * card that then blocked the real one. A card the model already staged from
 * the same invite thread is replaced (invite wins); a card staged from the
 * invite itself is kept.
 */
async function stageInviteIfInvite(
  db: Kysely<DB>,
  userId: string,
  t: { id: string; gid: string; accountId: string | null },
  newest: { gmail_message_id: string | null } | undefined,
  ctx: { personalGroupId: string; userTz: string | null },
): Promise<InviteStep> {
  if (!newest?.gmail_message_id) return { kind: 'none' };
  const provenance = `gmail:${t.gid}`;
  let invite: InviteProbeResult;
  try {
    invite = t.accountId
      ? await inviteEventForAccountMessage(db, userId, t.accountId, newest.gmail_message_id)
      : await inviteEventForMessage(db, userId, newest.gmail_message_id);
  } catch (err) {
    logger.warn('invite ics probe failed — thread deferred', {
      err: (err as Error).message,
      threadId: t.id,
    });
    return { kind: 'deferred' };
  }
  if (!invite.isInvite) {
    if (!invite.event) return { kind: 'none' };
    return {
      kind: 'none',
      icsDateHint: invite.event.startsAt,
      icsContext: [
        `Title: ${invite.event.title}`,
        `Starts: ${invite.event.startsAt}`,
        invite.event.endsAt ? `Ends: ${invite.event.endsAt}` : '',
        invite.event.location ? `Location: ${invite.event.location}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  // A cancellation payload RETRACTS by UID — it must never become a new
  // event (a METHOD:CANCEL VEVENT parses like a normal one).
  for (const uid of invite.cancelledUids) {
    await cancelMeetingByInviteUid(db, userId, uid);
    const r = await applyInviteCancellation(db, userId, uid);
    if (r.proposalsRetracted || r.eventsCancelled) {
      logger.info(
        `invite cancellation uid=${uid}: retracted ${r.proposalsRetracted} proposal(s), cancelled ${r.eventsCancelled} event(s)`,
        { userId },
      );
    }
  }
  // ADR 0328 — a guest's reply to an event this user organizes: record the
  // answer on it. Nothing to stage; the user already has the event.
  let answered = false;
  for (const r of invite.replies ?? []) {
    const response = responseFromPartstat(r.partstat);
    if (response && (await setGuestAnswer(db, { organizerId: userId, icalUid: r.uid, email: r.email, response }))) {
      answered = true;
    }
  }
  if (answered) return { kind: 'invite', staged: false };

  if (!invite.event) return { kind: 'invite', staged: false };

  // ADR 0328 — a family member's invitation to a group event Chord already
  // gave this user a row for: a card would ask them to add what they have.
  const inviteUid = invite.event.uid;
  if (inviteUid) {
    const have = await db
      .selectFrom('events')
      .select('id')
      .where('owner_user_id', '=', userId)
      .where('invite_uid', '=', inviteUid)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (have) return { kind: 'invite', staged: false };
  }

  const invitePeople = [
    ...(invite.event.organizer ? [invite.event.organizer] : []),
    ...(await emailThreadPeopleOf(db, userId, provenance)),
  ];
  // ADR 0346 - the invitation for a meeting being arranged by email: matched
  // by the meeting (organizer on the other side, the core people on it), not
  // by attendees being equal.
  try {
    await linkInviteToMeeting(
      db,
      userId,
      {
        uid: invite.event.uid ?? null,
        organizer: invite.event.organizer ?? null,
        people: invitePeople,
        startsAt: invite.event.startsAt,
      },
      ctx.userTz,
    );
  } catch (err) {
    logger.warn('meeting: invite link failed', { userId, err: (err as Error).message });
  }
  // "Invite wins": a pending event proposal extracted earlier from the
  // plain-email agreement for this slot is now superseded.
  await retractPendingEmailEventProposalsNear(db, userId, invite.event.startsAt, invite.event.title, invitePeople);
  const args = normalizeDatetimes(
    {
      title: invite.event.title,
      startsAt: invite.event.startsAt,
      ...(invite.event.endsAt ? { endsAt: invite.event.endsAt } : {}),
      ...(invite.event.allDay ? { allDay: true } : {}),
      ...(invite.event.location ? { location: invite.event.location } : {}),
      externalUid: invite.event.uid,
      // The organizer's meeting, not ours to re-create: it reaches this
      // user's Google calendar when they RSVP, and Google may hold it until
      // then (an invite from an unfamiliar sender does not appear on the
      // calendar until it is answered). Confirming here records it in Chord;
      // it must not mint a second Google event that the real invite then
      // arrives beside.
      alreadyInGoogle: true,
      // Who to answer (ADR 0104). Kept on the proposal because the iTIP
      // fallback needs it precisely when the calendar lookup cannot supply
      // it — the invite is not on the calendar yet.
      ...(invite.event.organizer ? { organizerEmail: invite.event.organizer } : {}),
    },
    tzToOffset(ctx.userTz ?? 'UTC'),
    ctx.userTz ?? null,
  );
  const parsed = toolSchemas.create_event.safeParse(args);
  // Same locked check-then-insert as every other email card (ADR 0244
  // addendum): staged once per thread, and compared against other emails'
  // cards while no other pass can be writing one.
  const staged =
    parsed.success &&
    (await withEmailStagingLocks(db, userId, provenance, async (trx) => {
      // The model's reading of this same invite (no invite UID) is the
      // invite in a worse shape; a card from the invite itself is kept and
      // stops a second one below.
      const pending = await trx
        .selectFrom('proposals')
        .select(['id', 'args_json'])
        .where('proposed_by_user_id', '=', userId)
        .where('provenance', '=', provenance)
        .where('status', '=', 'pending')
        .where('bundle_id', 'is', null)
        .where('tool_name', 'in', [...EMAIL_GENERAL_TOOLS])
        .execute();
      const modelMade = pending
        .filter((p) => {
          try {
            return !(JSON.parse(p.args_json) as { externalUid?: unknown }).externalUid;
          } catch {
            return true;
          }
        })
        .map((p) => p.id);
      if (modelMade.length > 0) {
        await trx
          .updateTable('proposals')
          .set({ status: 'expired', resolved_at: new Date().toISOString() })
          .where('id', 'in', modelMade)
          .execute();
      }
      if (await threadAlreadyProposed(trx, userId, provenance)) return false;
      if (
        !(await shouldStageEventProposal(trx, userId, parsed.data, {
          tzOffset: tzToOffset(ctx.userTz ?? 'UTC'),
        }))
      ) {
        return false;
      }
      await createProposal(trx, {
        groupId: ctx.personalGroupId,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'create_event',
        args,
        provenance,
        targetGroupId: null,
      });
      return true;
    }));
  return { kind: 'invite', staged: Boolean(staged) };
}

/**
 * ADR 0346 - read the user's own sent replies on threads whose meeting is
 * still being arranged, for the scheduling block only. Same extractor and
 * prompt as every email (one door); its cards are discarded, since the user
 * does not get suggestions from their own mail.
 */
export async function runOwnReplyScheduling(
  db: Kysely<DB>,
  userId: string,
  opts: { extractor?: EmailExtractor; limit?: number } = {},
): Promise<number> {
  const read = await readOwnReplies(db, userId, opts);
  try {
    await stageMeetingCards(db, userId);
  } catch (err) {
    logger.warn('meeting cards pass failed', { userId, err: (err as Error).message });
  }
  return read;
}

/**
 * ADR 0346 phase 5 - an agreed meeting with no card yet gets one:
 * - the user sends the invite (they said so, or were asked) - "Send invite";
 * - nobody said - the card asks "send an invite, or wait for theirs?";
 * - their side was to send it and nothing came within the hold - "Rob's
 *   invite never came", the user's call.
 * Once per agreement: any event card staged on the thread since the meeting
 * last changed stops another (a dismissed one included). Same locked
 * staging and past/duplicate guards as every email card.
 */
export async function stageMeetingCards(db: Kysely<DB>, userId: string, nowMs = Date.now()): Promise<number> {
  // ADR 0346 phase 7 - a group the user is arranging becomes agreed once
  // everyone has answered and one time suits them all.
  const tzRow = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
  await promoteGroupAgreements(db, userId, tzRow?.last_tz ?? null, nowMs);
  const meetings = await db
    .selectFrom('meetings')
    .selectAll()
    .where('user_id', '=', userId)
    .where('state', '=', 'agreed')
    .where('hold_dropped_at', 'is', null)
    .where('agreed_start', 'is not', null)
    .execute();
  if (meetings.length === 0) return 0;
  const user = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
  const tzOffset = tzToOffset(user?.last_tz ?? 'UTC');
  const personalGroupId = (await ensurePersonalGroup(db, userId)).id;
  let staged = 0;
  for (const m of meetings) {
    if (Date.parse(m.agreed_start!) <= nowMs) continue;
    const lapsed = m.invite_by === 'them' && Date.parse(m.updated_at) < nowMs - HOLD_DAYS * 86_400_000;
    if (m.invite_by === 'them' && !lapsed) continue;
    const facts = m.facts_json;
    const plan = meetingCardPlan(
      {
        sender: lapsed ? 'me' : m.invite_by,
        format: facts?.format ?? 'unknown',
        ...(facts?.link ? { link: facts.link } : {}),
        ...(facts?.place ? { place: facts.place } : {}),
        ...(facts?.phone ? { phone: facts.phone } : {}),
      },
    );
    const invitees = m.core_people.slice(0, 20);
    const who = invitees[0]?.split('@')[0] ?? null;
    const args = {
      title: facts?.title ?? (who ? `Meeting with ${who}` : 'Meeting'),
      startsAt: m.agreed_start!,
      ...(m.agreed_end ? { endsAt: m.agreed_end } : {}),
      ...(plan.location ? { location: plan.location } : {}),
      ...(invitees.length > 0 ? { invitees } : {}),
      ...(invitees.length > 0 && plan.videoCall ? { videoCall: true } : {}),
      ...(plan.whoSends ? { whoSends: plan.whoSends } : {}),
      ...(lapsed ? { lapsedNote: `${who ? `${who}'s` : 'Their'} invite never came` } : {}),
    };
    const parsed = toolSchemas.create_event.safeParse(args);
    if (!parsed.success) continue;
    const wrote = await withEmailStagingLocks(db, userId, m.thread_key, async (trx) => {
      const since = await trx
        .selectFrom('proposals')
        .select('id')
        .where('proposed_by_user_id', '=', userId)
        .where('provenance', '=', m.thread_key)
        .where('tool_name', '=', 'create_event')
        .where('created_at', '>=', m.updated_at)
        .executeTakeFirst();
      if (since) return false;
      const made = await trx
        .selectFrom('events')
        .select('id')
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .where('source_raw_context', '=', m.thread_key)
        .executeTakeFirst();
      if (made) return false;
      if (!(await shouldStageEventProposal(trx, userId, parsed.data, { tzOffset, provenance: m.thread_key }))) return false;
      await createProposal(trx, {
        groupId: personalGroupId,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'create_event',
        args,
        provenance: m.thread_key,
        targetGroupId: null,
      });
      return true;
    });
    if (wrote) staged += 1;
  }
  return staged;
}

async function readOwnReplies(
  db: Kysely<DB>,
  userId: string,
  opts: { extractor?: EmailExtractor; limit?: number },
): Promise<number> {
  const extractor = opts.extractor ?? llmExtractor();
  const own = await ownAddresses(db, userId);
  return readOwnRepliesForMeetings(
    db,
    userId,
    {
      async read(m) {
        let block: SchedulingBlock | null = null;
        await extractor.extract({
          subject: m.subject,
          snippet: m.bodyText.slice(0, 200),
          bodyText: m.bodyText,
          categoryTitle: null,
          userTz: m.tz,
          emailSentAt: m.sentAt,
          participants: m.participants,
          onScheduling: (b) => {
            block = b;
          },
          userId,
          db,
        });
        return block;
      },
    },
    {
      finish: (block, msg, mine) => finishScheduling(block, msg, mine, { askedOfUser: true }),
      bodyOf: (row) => modelBody(row),
      participantsOf: (row) =>
        participantsLine(
          {
            id: '',
            gmail_message_id: null,
            body_text: null,
            body_html: null,
            body_excerpt: null,
            internal_date: '',
            headers_json: {},
            from_email: row.from_email,
            from_name: row.from_name,
            to_emails: row.to_emails,
            cc_emails: row.cc_emails,
          },
          own,
        ),
    },
    { limit: opts.limit },
  );
}

/**
 * Extract suggestions from new classified threads and stage proposals. Bounded
 * per call; each thread is marked processed so it's never re-extracted. Best
 * effort — one thread's failure never aborts the batch.
 */
export async function runEmailMagics(
  db: Kysely<DB>,
  userId: string,
  opts: {
    extractor?: EmailExtractor;
    limit?: number;
    /** ADR 0158 — injectable travel classifier for the email → trip pass. */
    tripClassifier?: TravelClassifier;
  } = {},
): Promise<MagicsResult> {
  const extractor = opts.extractor ?? llmExtractor();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const personal = await ensurePersonalGroup(db, userId);
  const groups = await loadUserGroups(db, userId);
  const owner = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', userId)
    .executeTakeFirst();
  const userTz = owner?.last_tz ?? null;

  // ADR 0179 — threads under Coupons / Newsletters are discretionary
  // broadcasts; keep them out of the pass entirely, not marked mined (ADR
  // 0143: a policy change must be able to revisit them).
  const blockedCatIds = await discretionaryBroadcastCategoryIds(db, userId);

  const threads = await db
    .selectFrom('email_threads')
    .leftJoin('email_categories', 'email_categories.id', 'email_threads.category_id')
    .select([
      'email_threads.id as id',
      'email_threads.gmail_thread_id as gid',
      'email_threads.account_id as accountId',
      'email_threads.subject as subject',
      'email_threads.snippet as snippet',
      'email_threads.from_email as fromEmail',
      'email_threads.from_name as fromName',
      'email_threads.category_id as catId',
      'email_categories.title as cat',
    ])
    .where('email_threads.user_id', '=', userId)
    .where((eb) => eb.not(eb.exists(extractionMarkQuery(eb, userId, 'magic'))))
    // ...nor under another mailbox's copy of the same message (bug 12).
    .where((eb) => eb.not(eb.exists(crossAccountMarkQuery(eb, userId, 'magic'))))
    // Archived (incl. spam-labeled, which never carries INBOX) stays out of
    // the AI passes — was only guaranteed transitively via the classifier.
    .where('email_threads.is_archived', '=', 0)
    .where('email_threads.category_id', 'is not', null)
    // ADR 0143 — mail already read and left sitting is mail someone has dealt
    // with, and the backfill window is 90 days, so a first sync otherwise
    // mines a quarter of a year of settled inbox into fresh obligations.
    //
    // Unread is never skipped at any age: nobody has looked at it yet, so its
    // to-do is still owed. Only the read-AND-old combination is history.
    .where((eb) =>
      eb.or([
        eb('email_threads.is_unread', '=', 1),
        eb('email_threads.last_message_at', '>=', minableSince()),
      ]),
    )
    // ADR 0127 — the bulk deny-list. Events & invites is exempt by title
    // here because this is the pass ADR 0088 was worried about: Evite and
    // Eventbrite are bulk by construction and are exactly what it wanted kept.
    .where(
      minablePredicate(userId, {
        prefix: 'email_threads.',
        categoryTitleRef: 'email_categories.title',
      }),
    )
    // ADR 0179 — the discretionary-broadcast backstop.
    .$if(blockedCatIds.length > 0, (qb) =>
      qb.where('email_threads.category_id', 'not in', blockedCatIds),
    )
    .orderBy('email_threads.last_message_at', 'desc')
    .limit(limit)
    .execute();

  const now = new Date().toISOString();
  let events = 0;
  // Ceiling for the whole tick, not per thread (ADR 0110), shared across
  // every thread via `extractAndStage`'s `deepReadBudget`.
  const deepReadBudget = { used: 0, max: env.EMAIL_DEEP_READ_PER_TICK };
  let lists = 0;
  let tasks = 0;
  let trips = 0;
  let cancellations = 0;
  let routed = 0;
  // ADR 0088 — one snapshot for the whole batch, and only when there's a thread
  // to spend it on (this pass runs after every sync, usually with nothing new).
  const world = threads.length === 0 ? null : await loadWorldContext(db, userId, { tz: userTz });

  for (const t of threads) {
    try {
      if (await suppressedForSender(db, userId, t)) {
        await markEmailRead(db, userId, t.gid, now);
        continue;
      }
      // ADR 0110 — `body_text` belongs to the reader and exists only for
      // threads a human opened; `body_excerpt` is what sync keeps for this
      // pass. Either counts as having read the message.
      const body = await db
        .selectFrom('email_messages')
        .select([
          'id',
          'gmail_message_id',
          'body_text',
          'body_html',
          'body_excerpt',
          'internal_date',
          'headers_json',
          'from_email',
          'from_name',
          'to_emails',
          'cc_emails',
        ])
        .where('thread_id', '=', t.id)
        .where((eb) =>
          eb.or([eb('body_text', 'is not', null), eb('body_html', 'is not', null), eb('body_excerpt', 'is not', null)]),
        )
        .orderBy('internal_date', 'desc')
        .limit(1)
        .executeTakeFirst();
      // The invite probe must see the newest message even when no body text
      // is mirrored yet — a cancellation can be an ICS-only message.
      const newest =
        body ??
        (await db
          .selectFrom('email_messages')
          .select([
          'id',
          'gmail_message_id',
          'body_text',
          'body_html',
          'body_excerpt',
          'internal_date',
          'headers_json',
          'from_email',
          'from_name',
          'to_emails',
          'cc_emails',
        ])
          .where('thread_id', '=', t.id)
          .orderBy('internal_date', 'desc')
          .limit(1)
          .executeTakeFirst());
      // ADR 0074 — an invite is parsed, never guessed (shared with the
      // read-time pass). A failed check skips WITHOUT the marker so the
      // thread retries once the provider is back.
      const inviteStep = await stageInviteIfInvite(db, userId, t, newest, {
        personalGroupId: personal.id,
        userTz,
      });
      if (inviteStep.kind === 'deferred') continue;
      if (inviteStep.kind === 'invite') {
        if (inviteStep.staged) events += 1;
        await markEmailRead(db, userId, t.gid, now);
        continue;
      }
      // ADR 0177 — a non-invite (ADR 0175: PUBLISH/no-METHOD) .ics on this
      // message grounds the trip classifier and the general extractor.
      const { icsDateHint, icsContext } = inviteStep;

      // ADR 0158 — an itinerary in the body (Booking.com / Expedia send no
      // attachment) goes through the SAME trip classifier the attachment path
      // uses, staging a proposal bundle rather than auto-committing. Scoped to
      // `travel/*` threads so `classify` (an LLM call) does not run on the
      // whole batch; after the invite probe (an .ics is authoritative). A
      // staged bundle is this thread's one outcome (ADR 0137) — mark + skip
      // the LLM magics extraction and the flight-fact side channel.
      {
        // ADR 0177 — icsDateHint (set above, if the invite probe found a
        // non-invite .ics on this message) is passed through as a
        // deterministic anchor the classifier's own year-resolution can be
        // corrected against — never as a replacement for the LLM read.
        const staged = await stageTripIfTravel(
          db,
          userId,
          t,
          modelBody(body),
          { personalGroupId: personal.id, userTz, icsDateHint, tripClassifier: opts.tripClassifier },
        );
        if (staged === 'cancellation') {
          cancellations += 1;
          await markEmailRead(db, userId, t.gid, now);
          continue;
        }
        if (staged !== 'none') {
          trips += 1;
          await markEmailRead(db, userId, t.gid, now);
          continue;
        }
      }

      const outcome = await extractAndStage(db, userId, t, body, {
        extractor,
        personalGroupId: personal.id,
        groups,
        userTz,
        world,
        icsDateHint,
        icsContext,
        deepReadBudget,
        // ADR 0329 — the read-time pass's sender facts (ADR 0294), so this
        // one read can raise the advisory and opening the email needs none.
        senderContext: await senderContextBlock(db, userId, t.id).catch(() => null),
      });
      events += outcome.events;
      tasks += outcome.tasks;
      lists += outcome.lists;
      routed += outcome.routed;
    } catch (err) {
      // ADR 0079/0283 — refused before anything was sent (the allowance ran
      // out partway through the pass, or consent was withdrawn): this thread
      // and the rest were not read, so none is marked. They wait.
      if (isAiRefusal(err)) {
        logger.info('email magic pass stopped: model refused', { reason: err.message, userId });
        break;
      }
      logger.warn('email magic extract failed', { err: (err as Error).message, threadId: t.id });
    }
    await markEmailRead(db, userId, t.gid, now);
  }

  // Heal duplicates that predate staging-time dedup (and any that slip past
  // it when two syncs race), plus proposals whose slot a real calendar event
  // already covers: one cheap sweep per pass.
  const consolidated =
    (await consolidateDuplicateEventProposals(db, userId)) +
    (await consolidateDuplicateListItemProposals(db, userId)) +
    (await retractProposalsCoveredByExistingEvents(db, userId)) +
    (await retractPastEventProposals(db, userId, tzToOffset(userTz ?? 'UTC'))) +
    // ADR 0158 — the same "nothing past ever surfaces" rule, for a to-do whose
    // deadline lapsed or a trip bundle that went stale before it was confirmed.
    (await retractPastTaskProposals(db, userId, tzToOffset(userTz ?? 'UTC'))) +
    (await retractPastTripProposals(db, userId, tzToOffset(userTz ?? 'UTC'))) +
    (await retractDiscretionaryBroadcastProposals(db, userId, blockedCatIds));
  if (consolidated) {
    logger.info(`email magics consolidated ${consolidated} duplicate proposals`, { userId });
  }

  // Logged whenever the pass actually spent LLM calls, not just when it yielded
  // something: a 25-thread pass with no suggestions is the expensive case.
  // `ctxEvents`: how many calendar lines the ADR 0088 snapshot carried.
  if (events || lists || threads.length) {
    logger.info(
      `email magics user=${userId} events=${events} lists=${lists} routed=${routed} processed=${threads.length} ctxEvents=${world?.events.length ?? 0}`,
    );
  }
  return { events, lists, tasks, trips, cancellations, routed, processed: threads.length };
}

export interface ReadTimeMagicsResult {
  /** True when the LLM actually ran just now; false when a prior `read` mark
   *  meant this call re-served the already-stored result instead. */
  ranNow: boolean;
  advisory: EmailReadAdvisory | null;
}

/**
 * ADR 0180 — opening a thread runs its own extraction pass on THAT thread
 * alone, bypassing every gate `runEmailMagics`' batch query applies (the bulk
 * deny-list, discretionary-broadcast categories, archived, unread/age window)
 * and ignoring whether the `magic` mark already exists — none of those
 * gates' reasoning holds once a person already has the message open. Shares
 * `extractAndStage` with the background sweep, so a suggestion staged here
 * goes through the identical dedup.
 *
 * ADR 0184 does NOT narrow this to exclude bulk/promotional mail: a message
 * that escaped the provider's spam filter and landed in the inbox, if the
 * user proactively opens it, is exactly the case this pass exists for — the
 * open IS the consent ADR 0179's content gate is trying to infer from
 * unattended mail. Real Junk/Spam needs no carve-out here at all: it is
 * never mirrored into `email_threads` in the first place (`junk.service.ts`,
 * ADR 0080 addendum — "read straight from the provider, NEVER mirrored,
 * never classified, never fed to any AI pass"), so `runReadTimeEmailMagics`
 * — which only ever runs against a thread ROW — structurally cannot reach
 * it regardless of what gates live here.
 *
 * Marked `read` (and `magic` once the thread is sorted), and it re-serves
 * instead of re-asking when either mark is current: the sweep's read is the
 * same read (ADR 0329), and a re-open or the ADR 0082 foreground refresh
 * gets the stored result.
 * Best-effort like the batch loop: a failure still marks the thread `read`
 * (the same "once ever" posture as `magic`) and returns no advisory, rather
 * than retrying on every subsequent open — the caller (the thread-open
 * route) must never fail on this pass's account either way.
 */
/**
 * One check per thread at a time. The reader's prefetch starts a thread's check
 * before it is opened; an open that arrives while that check is still running
 * joins it instead of asking the model a second time.
 */
const readTimeInFlight = new Map<string, Promise<ReadTimeMagicsResult>>();

export function runReadTimeEmailMagics(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  opts: { extractor?: EmailExtractor; tripClassifier?: TravelClassifier } = {},
): Promise<ReadTimeMagicsResult> {
  const key = `${userId}:${threadRowId}`;
  const running = readTimeInFlight.get(key);
  if (running) return running;
  const run = runReadTimeEmailMagicsNow(db, userId, threadRowId, opts).finally(() => {
    readTimeInFlight.delete(key);
  });
  readTimeInFlight.set(key, run);
  return run;
}

async function runReadTimeEmailMagicsNow(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  opts: { extractor?: EmailExtractor; tripClassifier?: TravelClassifier },
): Promise<ReadTimeMagicsResult> {
  if (!env.EMAIL_READ_TIME_MAGICS_ENABLED) return { ranNow: false, advisory: null };

  const t = await db
    .selectFrom('email_threads')
    .leftJoin('email_categories', 'email_categories.id', 'email_threads.category_id')
    .select([
      'email_threads.id as id',
      'email_threads.gmail_thread_id as gid',
      'email_threads.account_id as accountId',
      'email_threads.subject as subject',
      'email_threads.snippet as snippet',
      'email_threads.from_email as fromEmail',
      'email_threads.from_name as fromName',
      'email_threads.category_id as catId',
      'email_categories.title as cat',
      'email_threads.read_advisory_json as readAdvisory',
    ])
    .where('email_threads.id', '=', threadRowId)
    .where('email_threads.user_id', '=', userId)
    .executeTakeFirst();
  if (!t) return { ranNow: false, advisory: null };

  // ADR 0329 — a current `magic` mark is the sweep's read of this same
  // message, sender check and advisory included: re-served, not re-asked.
  if (
    (await hasExtractionMark(db, userId, t.id, 'read')) ||
    (await hasExtractionMark(db, userId, t.id, 'magic'))
  ) {
    return { ranNow: false, advisory: t.readAdvisory ?? null };
  }
  // The same mail in another of the user's mailboxes was already checked
  // (bug 12): that check stands for this copy, as the warm-up already
  // assumes. Opening the second copy staged a second set of cards beside the
  // first, under a provenance no dedup compared against.
  const twin = await twinReadCheck(db, userId, t.id);
  if (twin.checked) return { ranNow: false, advisory: twin.advisory };
  // ADR 0283 / 0079 — the same gates the sweep sits behind. Every door into
  // this pass (opening, the prefetch, the warm-up after sync) comes through
  // here, and the warm-up ran even when the sweep had stopped at its gate.
  // No mark: once the user agrees or pays, the email is checked then.
  if (!(await hasAiConsent(db, userId))) return { ranNow: false, advisory: null };
  if (env.BILLING_ENABLED && !(await getEntitlement(db, userId)).entitled) {
    return { ranNow: false, advisory: null };
  }

  let outcome: ExtractStageOutcome = { events: 0, tasks: 0, lists: 0, advisory: false, routed: 0 };
  try {
    if (await suppressedForSender(db, userId, t)) {
      await markEmailRead(db, userId, t.gid, new Date().toISOString(), { sorted: t.catId !== null });
      return { ranNow: true, advisory: null };
    }
    const extractor = opts.extractor ?? llmExtractor();
    const personal = await ensurePersonalGroup(db, userId);
    const groups = await loadUserGroups(db, userId);
    const owner = await db
      .selectFrom('users')
      .select('last_tz')
      .where('id', '=', userId)
      .executeTakeFirst();
    const userTz = owner?.last_tz ?? null;
    // ADR 0088 — the same bounded snapshot the batch pass uses, just for one
    // thread's call rather than a whole tick's.
    const world = await loadWorldContext(db, userId, { tz: userTz });
    const body = await db
      .selectFrom('email_messages')
      .select([
          'id',
          'gmail_message_id',
          'body_text',
          'body_html',
          'body_excerpt',
          'internal_date',
          'headers_json',
          'from_email',
          'from_name',
          'to_emails',
          'cc_emails',
        ])
      .where('thread_id', '=', t.id)
      .orderBy('internal_date', 'desc')
      .limit(1)
      .executeTakeFirst();

    // ADR 0074 — an invite is parsed, never guessed, on this pass too. It
    // runs before anything the sweep has done (this thread is often not yet
    // sorted), so skipping it let the model guess an Outlook invite's time
    // from a body that has none, and that card then blocked the real one.
    const inviteStep = await stageInviteIfInvite(db, userId, t, body, {
      personalGroupId: personal.id,
      userTz,
    });
    // Not marked: the email is read again on the next open or warm-up.
    if (inviteStep.kind === 'deferred') return { ranNow: false, advisory: null };
    const icsDateHint = inviteStep.kind === 'none' ? inviteStep.icsDateHint : undefined;
    const icsContext = inviteStep.kind === 'none' ? inviteStep.icsContext : undefined;

    // ADR 0244 — a booking is a trip whichever pass reads it first. Without
    // this the pass staged "Flight UA 1234 from Newark to Denver" as a bare
    // calendar event seconds before the sweep staged the trip itself.
    const trip =
      inviteStep.kind === 'invite'
        ? 'none'
        : await stageTripIfTravel(
            db,
            userId,
            t,
            modelBody(body),
            { personalGroupId: personal.id, userTz, icsDateHint, tripClassifier: opts.tripClassifier },
          );
    if (inviteStep.kind !== 'invite' && trip === 'none') {
      outcome = await extractAndStage(db, userId, t, body, {
        extractor,
        personalGroupId: personal.id,
        groups,
        userTz,
        world,
        icsDateHint,
        icsContext,
        deepReadBudget: { used: 0, max: 1 },
        // ADR 0184 — the whole point of this pass: the user opened this
        // thread, so ADR 0179's discretionary-broadcast gate doesn't apply.
        interactive: true,
        // ADR 0294 — the only pass that can raise an advisory is told who
        // really sent the mail.
        senderContext: await senderContextBlock(db, userId, t.id).catch(() => null),
      });
    }
  } catch (err) {
    // Refused before anything was sent: not read, so no mark (see the gates above).
    if (isAiRefusal(err)) return { ranNow: false, advisory: null };
    logger.warn('read-time email magic failed', { err: (err as Error).message, threadId: threadRowId });
  }
  await markEmailRead(db, userId, t.gid, new Date().toISOString(), { sorted: t.catId !== null });

  if (!outcome.advisory) return { ranNow: true, advisory: null };
  const fresh = await db
    .selectFrom('email_threads')
    .select('read_advisory_json as readAdvisory')
    .where('id', '=', t.id)
    .executeTakeFirst();
  return { ranNow: true, advisory: fresh?.readAdvisory ?? null };
}

/** One user's preprocessing run in flight at a time (in-memory, single
 *  process - mirrors `afterSyncRuns`/`mailSyncRounds`'s own coalescing). Two
 *  triggers landing close together (a sync finishing right as the reader
 *  opens their first email) would otherwise both see the same unmarked
 *  batch and both pay for it; `runReadTimeEmailMagics`'s own per-thread mark
 *  check bounds the damage to "wasted, not wrong" either way, so this is a
 *  cheap guard against the common case, not a correctness requirement. */
const preprocessInFlight = new Set<string>();

/**
 * Warms the ADR 0180 read-time pass AHEAD of the open, for the newest
 * not-yet-processed threads — so the common case (mail near the top of the
 * inbox) is instant to open instead of paying a live ~1.5-2s LLM call.
 *
 * Deliberately bounded to `limit` threads per call rather than every synced
 * thread: a 14-day backfill must not turn into `limit`-per-thread LLM spend
 * whether or not anyone ever reads it (the same reasoning ADR 0109/0127/0143
 * apply to the background sweep). No cursor is stored — the query always
 * asks for "the newest `limit` threads with no `read` mark yet", so once the
 * current front is fully marked (by this running again, or by the reader
 * opening them directly), the identical call naturally surfaces the next
 * `limit`. Called both right after a sync (warms the first page) and
 * opportunistically on each thread open (keeps topping up as the reader
 * scrolls past what's already warm).
 *
 * ADR 0180's read-time pass deliberately bypasses the background sweep's
 * eligibility gates (age/bulk/discretionary) — but that's justified only
 * because a PERSON has the specific message open right now, so a stale or
 * bulk-looking thread is worth re-examining. Nobody is looking at THESE
 * threads; this call is speculative, run from a sync or from a DIFFERENT
 * thread's open. Without the same gates `runEmailMagics` applies, the
 * "newest N still unmarked" query self-advances with no age bound at all
 * (ADR 0219 shipped it that way) and, given enough sync/open ticks, walks
 * arbitrarily far back into mail that sat read-and-settled for months —
 * staging fresh to-dos for things already handled through some other
 * channel. See ADR 0221.
 */
export async function preprocessReadTimeMagics(
  db: Kysely<DB>,
  userId: string,
  opts: { limit?: number; extractor?: EmailExtractor; tripClassifier?: TravelClassifier } = {},
): Promise<{ processed: number }> {
  if (!env.EMAIL_PREPROCESS_READTIME_ENABLED || !env.EMAIL_READ_TIME_MAGICS_ENABLED) {
    return { processed: 0 };
  }
  if (preprocessInFlight.has(userId)) return { processed: 0 };
  preprocessInFlight.add(userId);
  try {
    const limit = Math.min(Math.max(opts.limit ?? env.EMAIL_PREPROCESS_READTIME_BATCH, 1), 50);
    const threads = await warmUpCandidates(db, userId, { limit });
    for (const t of threads) {
      try {
        await runReadTimeEmailMagics(db, userId, t.id, {
          extractor: opts.extractor,
          tripClassifier: opts.tripClassifier,
        });
      } catch (err) {
        logger.warn('read-time preprocess failed', {
          userId,
          threadId: t.id,
          err: (err as Error).message,
        });
      }
    }
    return { processed: threads.length };
  } finally {
    preprocessInFlight.delete(userId);
  }
}

/**
 * Threads a check may run on before anyone opens them (ADR 0219 warm-up, and the
 * reader's prefetch of the next email): not yet checked, unread or recent, and
 * not mail the background sweep would skip. A speculative check earns no
 * exception from those rules - running one on old, already-handled mail is
 * what staged a burst of stale to-dos (ADR 0221). An open always runs it.
 */
async function warmUpCandidates(
  db: Kysely<DB>,
  userId: string,
  opts: { limit: number; threadRowId?: string },
): Promise<{ id: string; gmail_thread_id: string }[]> {
  const blockedCatIds = await discretionaryBroadcastCategoryIds(db, userId);
  return db
    .selectFrom('email_threads')
    .leftJoin('email_categories', 'email_categories.id', 'email_threads.category_id')
    .select(['email_threads.id as id', 'email_threads.gmail_thread_id as gmail_thread_id'])
    .where('email_threads.user_id', '=', userId)
    .$if(opts.threadRowId !== undefined, (qb) => qb.where('email_threads.id', '=', opts.threadRowId!))
    .where('email_threads.is_archived', '=', 0)
    .where((eb) => eb.not(eb.exists(extractionMarkQuery(eb, userId, 'read'))))
    .where((eb) => eb.not(eb.exists(crossAccountMarkQuery(eb, userId, 'read'))))
    // ADR 0329 — nor already read by the sweep.
    .where((eb) => eb.not(eb.exists(extractionMarkQuery(eb, userId, 'magic'))))
    .where((eb) => eb.not(eb.exists(crossAccountMarkQuery(eb, userId, 'magic'))))
    .where((eb) =>
      eb.or([
        eb('email_threads.is_unread', '=', 1),
        eb('email_threads.last_message_at', '>=', minableSince()),
      ]),
    )
    .where(
      minablePredicate(userId, {
        prefix: 'email_threads.',
        categoryTitleRef: 'email_categories.title',
      }),
    )
    .$if(blockedCatIds.length > 0, (qb) => qb.where('email_threads.category_id', 'not in', blockedCatIds))
    .orderBy('email_threads.last_message_at', 'desc')
    .limit(opts.limit)
    .execute();
}

/**
 * The reader is pre-loading the email after (or before) the one on screen.
 * Start that email's one-time check now, so opening it has nothing to wait
 * for. Same rule as the warm-up; never throws.
 */
export async function prefetchReadTimeMagics(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  opts: { extractor?: EmailExtractor; tripClassifier?: TravelClassifier } = {},
): Promise<{ started: boolean }> {
  if (!env.EMAIL_READ_TIME_MAGICS_ENABLED || !env.EMAIL_PREFETCH_READTIME_ENABLED) return { started: false };
  try {
    const [t] = await warmUpCandidates(db, userId, { limit: 1, threadRowId });
    if (!t) return { started: false };
    await runReadTimeEmailMagics(db, userId, t.id, opts);
    return { started: true };
  } catch (err) {
    logger.warn('read-time prefetch check failed', { userId, threadRowId, err: (err as Error).message });
    return { started: false };
  }
}

/** ADR 0248 — what an email's change card says, or null for any other tool. */
function changeLabel(
  toolName: string,
  args: Record<string, unknown>,
): { title: string; detail: string | null } | null {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const event = str(args.eventTitle);
  const task = str(args.taskTitle);
  if (toolName === 'delete_event' && event) return { title: `Remove from calendar: ${event}`, detail: str(args.eventStartsAt) };
  if (toolName === 'update_event' && event) return { title: `Move: ${event}`, detail: str(args.startsAt) };
  if (toolName === 'complete_task' && task) {
    return { title: args.drop === true ? `No longer needed: ${task}` : `Mark done: ${task}`, detail: null };
  }
  if (toolName === 'update_task' && task) return { title: `New due date: ${task}`, detail: str(args.dueAt) };
  return null;
}

export function suggestionFromProposal(p: {
  id: string;
  tool_name: string;
  args_json: string;
  target_group_id: string | null;
  status?: 'pending' | 'confirmed' | 'rejected' | 'expired';
}, opts: { includeChanges?: boolean } = {}): EmailMagicSuggestion | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(p.args_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Only 'pending'/'confirmed' rows ever reach here (both callers' queries
  // filter to those), but narrow defensively rather than widen the wire type.
  const status: 'pending' | 'confirmed' = p.status === 'confirmed' ? 'confirmed' : 'pending';
  let suggestion: EmailMagicSuggestion | null = null;
  if (p.tool_name === 'create_event' && typeof args.title === 'string') {
    suggestion = {
      proposalId: p.id,
      kind: 'event',
      title: args.title,
      detail: typeof args.startsAt === 'string' ? args.startsAt : null,
      targetGroupId: p.target_group_id,
      status,
      // ADR 0104 - an invitation is answered (Yes / Maybe / No), not added.
      ...(args.alreadyInGoogle === true && args.externalUid ? { isInvite: true } : {}),
      ...(Array.isArray(args.invitees) && args.invitees.length > 0
        ? { invitees: args.invitees.filter((e): e is string => typeof e === 'string') }
        : {}),
      // ADR 0346 phase 5 - nobody said who sends the invite: the card asks.
      ...(args.whoSends === 'ask' ? { whoSends: 'ask' as const } : {}),
      ...(typeof args.lapsedNote === 'string' ? { note: args.lapsedNote } : {}),
    };
  } else if (p.tool_name === 'create_task' && typeof args.title === 'string') {
    suggestion = {
      proposalId: p.id,
      kind: 'task',
      title: args.title,
      detail: typeof args.dueAt === 'string' ? args.dueAt : null,
      targetGroupId: p.target_group_id,
      status,
    };
  } else if (opts.includeChanges && changeLabel(p.tool_name, args)) {
    // ADR 0248 - an email's change card. Only the reader dock asks for it:
    // the briefing and the decision feeds count things to ADD.
    const label = changeLabel(p.tool_name, args)!;
    suggestion = {
      proposalId: p.id,
      kind: 'change',
      title: label.title,
      detail: label.detail,
      targetGroupId: null,
      ...(typeof args.why === 'string' && args.why ? { changeNote: args.why } : {}),
      status,
    };
  } else if (p.tool_name === 'add_list_item' && Array.isArray(args.items)) {
    suggestion = {
      proposalId: p.id,
      kind: 'list',
      title: args.items.filter((i) => typeof i === 'string').join(', '),
      detail: typeof args.listName === 'string' ? args.listName : null,
      targetGroupId: p.target_group_id,
      status,
    };
  }
  return suggestion?.title ? suggestion : null;
}

/**
 * ADR 0068 — pending (or already-confirmed, ADR 0187) suggestions for a set
 * of local thread row ids, keyed by row id, so the reader can dock each
 * suggestion beside its email. Matches on the `gmail:<threadId>` provenance
 * this module writes; scoped to the owner (proposals are staged in the
 * owner's personal group, ADR 0063).
 *
 * A confirmed proposal is included with no `expires_at` check — it's a
 * settled fact, not a live offer, so it doesn't age out the way a pending one
 * does. The card renders it as "already added" (ADR 0187) instead of
 * silently vanishing, which is what happened before: confirm flips the
 * status, the row drops out of this query, and re-opening the thread showed
 * nothing at all — indistinguishable from having never been mined.
 */
export async function pendingSuggestionsForThreads(
  db: Kysely<DB>,
  userId: string,
  threadRowIds: string[],
): Promise<Map<string, EmailMagicSuggestion[]>> {
  const out = new Map<string, EmailMagicSuggestion[]>();
  if (threadRowIds.length === 0) return out;

  const threads = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id'])
    .where('user_id', '=', userId)
    .where('id', 'in', threadRowIds)
    .execute();
  if (threads.length === 0) return out;
  const rowIdByProvenance = new Map(threads.map((t) => [`gmail:${t.gmail_thread_id}`, t.id]));

  const proposals = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'provenance', 'target_group_id', 'status'])
    .where('proposed_by_user_id', '=', userId)
    .where((eb) =>
      eb.or([
        eb.and([eb('status', '=', 'pending'), eb('expires_at', '>', new Date().toISOString())]),
        eb('status', '=', 'confirmed'),
      ]),
    )
    .where('provenance', 'in', [...rowIdByProvenance.keys()])
    .execute();

  const groupNames = await targetGroupNames(db, proposals);
  // ADR 0343 — the card asks whether this replaces an event already there.
  const [replaces, fits] = await Promise.all([
    replaceOffersFor(db, userId, proposals),
    calendarFitFor(db, userId, proposals),
  ]);
  for (const p of proposals) {
    const rowId = rowIdByProvenance.get(p.provenance!);
    if (!rowId) continue;
    const suggestion = suggestionFromProposal(p, { includeChanges: true });
    if (!suggestion) continue;
    const offer = replaces.get(p.id);
    if (offer) suggestion.replaces = offer;
    const fit = fits.get(p.id);
    if (fit) suggestion.fit = fit;
    suggestion.targetGroupName = p.target_group_id
      ? (groupNames.get(p.target_group_id) ?? null)
      : null;
    const arr = out.get(rowId) ?? [];
    arr.push(suggestion);
    out.set(rowId, arr);
  }
  return out;
}

/** ADR 0077 — batch-resolve target group names so the card can show where a
 *  confirm will land ("→ Doe Family"). */
async function targetGroupNames(
  db: Kysely<DB>,
  proposals: Array<{ target_group_id: string | null }>,
): Promise<Map<string, string>> {
  const ids = [...new Set(proposals.map((p) => p.target_group_id).filter((v): v is string => !!v))];
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom('groups').select(['id', 'name']).where('id', 'in', ids).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** All of a user's pending email-magic suggestions, newest first (digest). */
export async function pendingSuggestionsForUser(
  db: Kysely<DB>,
  userId: string,
  limit = 10,
): Promise<EmailMagicSuggestion[]> {
  const proposals = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'target_group_id'])
    .where('proposed_by_user_id', '=', userId)
    .where('status', '=', 'pending')
    .where('expires_at', '>', new Date().toISOString())
    .where('provenance', 'like', 'gmail:%')
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
  const groupNames = await targetGroupNames(db, proposals);
  return proposals
    .map((p) => {
      const s = suggestionFromProposal(p);
      if (s) {
        s.targetGroupName = p.target_group_id
          ? (groupNames.get(p.target_group_id) ?? null)
          : null;
      }
      return s;
    })
    .filter((s): s is EmailMagicSuggestion => s !== null);
}

/**
 * ADR 0083 — every pending gmail-provenance decision for the AI shell, with
 * category join fields. Unclassified / archived / missing threads yield
 * `categoryId: null` so they land in Unsorted instead of vanishing.
 */
/**
 * "Expired, still owed" — bug 9's third path, owner decision 2026-08-24.
 *
 * A proposal that times out drops the tile badge, which is correct: nobody
 * decided, so nothing may claim to be handled. But letting the thread go
 * silent WITH it is exactly the failure decision counts replaced unread to
 * prevent — the tile goes quiet while the thing is still owed.
 *
 * The discriminator is **read state**, not a new column, and that works
 * because of the invariant the rest of bug 9 established: every path that
 * legitimately clears a proposal now settles the thread's read state too.
 * So the other two `expired` writers exclude themselves for free —
 * convergence retractions mark the source read (the obligation really was
 * met), and `retractByProvenance` fires when the source was trashed, which
 * archives it. What is left is a timeout nobody acted on.
 *
 * A thread the user READ but never decided on is deliberately not counted:
 * they saw it and chose not to act, and nagging past that is what makes a
 * counter get ignored.
 */
/** How many threads a coverage count will hand back to tap through to. The
 *  count itself is never clipped — only the list behind it. */
const COVERAGE_LIST_CAP = 200;

/**
 * ADR 0134 — the threads this user acted on today, archived ones included.
 *
 * Deliberately NOT filtered by `is_archived`, which ADR 0073 applies to every
 * listing surface. The reason is that `handledToday` is a record of what the
 * USER DID, counted off confirmed proposals, and archiving afterwards is an
 * unrelated tidy-up — deciding never archives anything (`markSourceThreadsRead`
 * only clears UNREAD). Filter this list and the footer says "3 handled" over a
 * list of 2, which is the count disagreeing with itself.
 *
 * Note the deliberate asymmetry with `stillOwedThreadIds`, which DOES exclude
 * archived: an outstanding obligation is cancelled by archiving the mail, a
 * completed action is not.
 *
 * `count` is proposals (you can confirm two on one thread); `threadIds` is
 * threads, deduped, which is what there is to open.
 */
async function handledTodayThreadIds(
  db: Kysely<DB>,
  userId: string,
  dayStart: string,
): Promise<{ count: number; threadIds: string[] }> {
  const rows = await db
    .selectFrom('proposals')
    .innerJoin('email_threads', (join) =>
      join
        .on('email_threads.user_id', '=', userId)
        .onRef(
          'email_threads.gmail_thread_id',
          '=',
          sql<string>`substring(proposals.provenance from 7)`,
        ),
    )
    .select(['email_threads.id as threadId', 'email_threads.last_message_at as at'])
    .where('proposals.proposed_by_user_id', '=', userId)
    .where('proposals.status', '=', 'confirmed')
    .where('proposals.provenance', 'like', 'gmail:%')
    .where('proposals.resolved_at', '>=', dayStart)
    .orderBy('email_threads.last_message_at', 'desc')
    .execute();
  return { count: rows.length, threadIds: [...new Set(rows.map((r) => r.threadId))] };
}

/** The "expired, still owed" set — ids, with the count as its length. */
async function stillOwedThreadIds(db: Kysely<DB>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('proposals')
    .innerJoin('email_threads', (join) =>
      join
        .on('email_threads.user_id', '=', userId)
        .onRef(
          'email_threads.gmail_thread_id',
          '=',
          sql<string>`substring(proposals.provenance from 7)`,
        ),
    )
    .select(['email_threads.id as threadId', 'email_threads.last_message_at as at'])
    .where('proposals.proposed_by_user_id', '=', userId)
    .where('proposals.status', '=', 'expired')
    .where('proposals.provenance', 'like', 'gmail:%')
    .where('email_threads.is_archived', '=', 0)
    .where('email_threads.is_unread', '=', 1)
    // A thread with a LIVE decision is already badged; it is not "owed" in
    // the silent sense this counts.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('proposals as live')
            .select('live.id')
            .whereRef('live.provenance', '=', 'proposals.provenance')
            .where('live.proposed_by_user_id', '=', userId)
            .where('live.status', '=', 'pending'),
        ),
      ),
    )
    .orderBy('email_threads.last_message_at', 'desc')
    .execute();
  return [...new Set(rows.map((r) => r.threadId))];
}

export async function listEmailDecisions(
  db: Kysely<DB>,
  userId: string,
): Promise<EmailDecisionsResponse> {
  const nowIso = new Date().toISOString();
  // Independent reads, run together.
  const [proposals, tzRow, unreadableRow, owed] = await Promise.all([
    db
      .selectFrom('proposals')
      .select(['id', 'tool_name', 'args_json', 'target_group_id', 'provenance', 'created_at'])
      .where('proposed_by_user_id', '=', userId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', nowIso)
      .where('provenance', 'like', 'gmail:%')
      .orderBy('created_at', 'desc')
      .execute(),
    db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst(),
    db
      .selectFrom('email_threads')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('is_archived', '=', 0)
      .where('category_id', 'is', null)
      .executeTakeFirst(),
    stillOwedThreadIds(db, userId),
  ]);
  // "Today" is the user's day, not UTC's (ADR 0074), starting at the offset
  // its own midnight had: on a clock-change day that is not the current one.
  const tz = tzRow?.last_tz ?? null;
  const dayStart = zonedDayStartUtc(dayOf(new Date().toISOString(), tz), tz).toISOString();

  const gmailIds = [
    ...new Set(
      proposals
        .map((p) => (p.provenance ? p.provenance.slice('gmail:'.length) : null))
        .filter((v): v is string => !!v),
    ),
  ];
  const [threads, groupNames, handled] = await Promise.all([
    gmailIds.length === 0
      ? []
      : db
          .selectFrom('email_threads')
          .select(['id', 'gmail_thread_id', 'category_id', 'is_archived'])
          .where('user_id', '=', userId)
          .where('gmail_thread_id', 'in', gmailIds)
          .execute(),
    targetGroupNames(db, proposals),
    handledTodayThreadIds(db, userId, dayStart),
  ]);
  const threadByGmail = new Map(threads.map((t) => [t.gmail_thread_id, t]));

  const categoryIds = [
    ...new Set(threads.map((t) => t.category_id).filter((v): v is string => !!v)),
  ];
  const categories =
    categoryIds.length === 0
      ? []
      : await db
          .selectFrom('email_categories')
          .select(['id', 'title'])
          .where('user_id', '=', userId)
          .where('id', 'in', categoryIds)
          .execute();
  const titleByCat = new Map(categories.map((c) => [c.id, c.title]));

  const decisions: EmailDecision[] = [];
  for (const p of proposals) {
    const suggestion = suggestionFromProposal(p);
    if (!suggestion) continue;
    suggestion.targetGroupName = p.target_group_id
      ? (groupNames.get(p.target_group_id) ?? null)
      : null;
    const gid = p.provenance!.slice('gmail:'.length);
    const thread = threadByGmail.get(gid);
    const archived = thread ? thread.is_archived === 1 : false;
    // Archived or unclassified → Unsorted so the decision stays reachable.
    const categoryId =
      thread && !archived && thread.category_id ? thread.category_id : null;
    decisions.push({
      ...suggestion,
      categoryId,
      categoryTitle: categoryId ? (titleByCat.get(categoryId) ?? null) : null,
      threadRowId: thread?.id ?? null,
      dueAt: suggestion.kind === 'event' ? suggestion.detail : null,
      archivedSource: archived,
    });
  }

  return {
    decisions,
    coverage: {
      handledToday: handled.count,
      unreadable: Number(unreadableRow?.n ?? 0),
      stillOwed: owed.length,
      // Counts stay exact; only the lists behind them are clipped.
      handledThreadIds: handled.threadIds.slice(0, COVERAGE_LIST_CAP),
      owedThreadIds: owed.slice(0, COVERAGE_LIST_CAP),
    },
  };
}
