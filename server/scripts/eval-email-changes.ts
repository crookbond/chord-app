/**
 * ADR 0248 — does the model name the right item, and only when it should?
 *
 * Not part of CI: it calls the configured model (`LLM_PROVIDER` in .env) once
 * per case and costs tokens. Run it whenever the extraction prompt changes:
 *
 *   npx tsx scripts/eval-email-changes.ts
 *
 * Each case is a real-shaped email, the same fixed list of the user's items
 * (labelled exactly as the pass labels them), and what must come back.
 */
import { formatLabelledWorld, type MagicsWorldContext } from '../src/services/email/magics-context.js';
import { llmExtractor, type EmailSuggestion } from '../src/services/email/magics.service.js';
import { offsetForLocalDatetime } from '../src/utils/tz.js';

const TZ = 'America/New_York';

function at(days: number, hhmm: string): string {
  const ymd = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const local = `${ymd}T${hhmm}:00`;
  return `${local}${offsetForLocalDatetime(TZ, local)}`;
}
function longDay(days: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(
    new Date(Date.now() + days * 86_400_000),
  );
}

const world: MagicsWorldContext = {
  events: [
    { id: 'ev-squash', title: 'Squash Singles 3', at: at(2, '17:30') },
    { id: 'ev-dinner', title: 'Dinner with Ana', at: at(2, '19:00') },
    { id: 'ev-dentist', title: 'Dentist - Dr. Patel', at: at(5, '10:00') },
    { id: 'ev-swim', title: 'Maya swim class', at: at(4, '16:00') },
  ],
  tasks: [
    { id: 't-coned', title: 'Pay Con Ed bill', dueAt: at(6, '23:59') },
    { id: 't-slip', title: 'Return the field trip permission slip', dueAt: at(3, '08:00') },
  ],
  pending: [
    {
      id: 'p-carbone',
      tool: 'create_event',
      title: 'Dinner at Carbone',
      at: at(3, '19:30'),
      args: { title: 'Dinner at Carbone', startsAt: at(3, '19:30') },
      provenance: 'gmail:other',
    },
  ],
  trips: [],
  openSlots: [],
};
const { block, targets } = formatLabelledWorld(world, TZ);

interface Case {
  name: string;
  from: string;
  subject: string;
  body: string;
  /** Exactly these changes (label resolved from the row id), and no others. */
  changes: Array<{ id: string; action: string }>;
  /** Kinds of NEW items that must be present (others allowed only if listed). */
  adds?: Array<EmailSuggestion['kind']>;
  /** No new event may come back. */
  noEvent?: boolean;
}

const cases: Case[] = [
  {
    name: 'NYAC cancellation',
    from: 'New York Athletic Club <reservations@nyac.org>',
    subject: 'Reservation cancelled',
    body: `You have successfully cancelled out of a reservation made via the New York Athletic Club reservation system.\nCourt: Singles 3 / Squash Singles\nDate: ${longDay(2)}\nTime: 05:30 PM to 06:15 PM`,
    changes: [{ id: 'ev-squash', action: 'remove' }],
    noEvent: true,
  },
  {
    name: 'NYAC moved',
    from: 'New York Athletic Club <reservations@nyac.org>',
    subject: 'Reservation changed',
    body: `Your reservation for Squash Singles (Court 3) on ${longDay(2)} at 5:30 PM has been moved to ${longDay(3)} at 9:00 AM.`,
    changes: [{ id: 'ev-squash', action: 'move' }],
  },
  {
    name: 'Con Ed payment received',
    from: 'Con Edison <billing@coned.com>',
    subject: 'We received your payment',
    body: 'Thank you. We received your payment of $84.20 for account ending 4471. No further action is needed.',
    changes: [{ id: 't-coned', action: 'done' }],
  },
  {
    name: 'Dentist rescheduled',
    from: 'Patel Family Dentistry <office@pateldental.com>',
    subject: 'Your appointment has been rescheduled',
    body: `Hi John, Dr. Patel is out that day, so your cleaning on ${longDay(5)} at 10:00 AM is now ${longDay(8)} at 2:00 PM. Reply if that does not work.`,
    changes: [{ id: 'ev-dentist', action: 'move' }],
  },
  {
    name: 'Swim class moved rooms (same time)',
    from: 'Y Aquatics <aquatics@ymca.org>',
    subject: 'Pool change this week',
    body: `This week Maya's swim class meets in the small pool instead of the main pool. Same time.`,
    changes: [],
  },
  {
    name: 'Swim class cancelled this week',
    from: 'Y Aquatics <aquatics@ymca.org>',
    subject: 'No swim class this week',
    body: `Due to pool maintenance, Maya's swim class on ${longDay(4)} is cancelled. Classes resume next week.`,
    changes: [{ id: 'ev-swim', action: 'remove' }],
    noEvent: true,
  },
  {
    name: 'Carbone (only a suggestion) cancelled',
    from: 'OpenTable <noreply@opentable.com>',
    subject: 'Your reservation at Carbone has been cancelled',
    body: `Your reservation at Carbone for 2 on ${longDay(3)} at 7:30 PM has been cancelled.`,
    changes: [{ id: 'p-carbone', action: 'remove' }],
    noEvent: true,
  },
  {
    name: 'Permission slip received',
    from: 'Ms. Lee <lee@school.org>',
    subject: 'Got it, thanks',
    body: 'Thanks John, I received the signed field trip permission slip for Maya. See you Friday!',
    changes: [{ id: 't-slip', action: 'done' }],
  },
  {
    name: 'Cancellation of something NOT listed',
    from: 'Fresh Cuts Salon <book@freshcuts.com>',
    subject: 'Appointment cancelled',
    body: `Your haircut with Jo on ${longDay(6)} at 11:00 AM has been cancelled.`,
    changes: [],
    noEvent: true,
  },
  {
    name: 'Unrelated newsletter on the same day',
    from: 'Club News <news@nyac.org>',
    subject: 'This week at the club',
    body: `Squash ladder results are posted. The bar reopens ${longDay(2)} at 6 PM. See you soon!`,
    changes: [],
  },
  {
    name: 'New booking confirmation stays an add',
    from: 'New York Athletic Club <reservations@nyac.org>',
    subject: 'Reservation confirmed',
    body: `You have successfully booked Squash Singles, Court 2, on ${longDay(9)} from 07:00 AM to 07:45 AM.`,
    changes: [],
    adds: ['event'],
  },
  {
    name: 'Moved plus something to bring',
    from: 'Y Aquatics <aquatics@ymca.org>',
    subject: 'Swim class moved',
    body: `Maya's swim class on ${longDay(4)} moves to ${longDay(4)} at 5:00 PM. Please bring goggles and a towel.`,
    changes: [{ id: 'ev-swim', action: 'move' }],
    adds: ['list'],
  },
];

const extractor = llmExtractor();
let failed = 0;
for (const c of cases) {
  const found = await extractor.extract({
    subject: c.subject,
    snippet: c.body.slice(0, 120),
    bodyText: `From: ${c.from}\n\n${c.body}`,
    categoryTitle: null,
    userTz: TZ,
    emailSentAt: new Date().toISOString(),
    worldContext: block,
  });
  const items = found ? (Array.isArray(found) ? found : [found]) : [];
  // A label not in the block is dropped by the pass (`unknown_label`), so it changes nothing.
  const invented = items.filter((s) => s.kind === 'change' && !targets.has(s.target));
  const got = items.flatMap((s) =>
    s.kind === 'change' && targets.has(s.target) ? [{ id: targets.get(s.target)!.id, action: s.action }] : [],
  );
  const want = c.changes.map((w) => `${w.id}:${w.action}`).sort().join(',');
  const have = got.map((g) => `${g.id}:${g.action}`).sort().join(',');
  const kinds: string[] = items.filter((s) => s.kind !== 'change').map((s) => s.kind);
  const problems: string[] = [];
  if (want !== have) problems.push(`changes want [${want}] got [${have}]`);
  for (const k of c.adds ?? []) if (!kinds.includes(k)) problems.push(`missing a new ${k}`);
  if (c.noEvent && kinds.includes('event')) problems.push('emitted a new event');
  if (problems.length) failed += 1;
  const note = invented.length ? ` (invented label dropped: ${invented.map((s) => (s.kind === 'change' ? s.target : '')).join(',')})` : '';
  console.log(`${problems.length ? 'FAIL' : 'pass'}  ${c.name}${problems.length ? ` — ${problems.join('; ')}` : ''}${note}`);
  if (problems.length) console.log(`      ${JSON.stringify(items)}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed (labels: ${[...targets.keys()].map((k) => `${k}=${targets.get(k)!.id}`).join(' ')})`);
process.exit(failed ? 1 : 0);
