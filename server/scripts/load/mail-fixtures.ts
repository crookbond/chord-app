/**
 * Generators for the mail the load test delivers to each mock mailbox. A mix of
 * what real mail looks like to this app: bulk (List-Unsubscribe), receipts,
 * shipping, travel, school notes, and person-to-person mail that wants a reply,
 * each with a body long enough that the sync, classifier and extractors do
 * real work rather than parsing a one-liner.
 */
import type { GmailRawMessage } from '../../src/services/google/gmail-sync.js';

interface Template {
  kind: string;
  from: string;
  subject: (n: number) => string;
  body: (n: number) => string;
  bulk?: boolean;
  weight: number;
}

const filler =
  'This message is part of the load test and is deliberately a little longer than a single line so the sync, the search index and the extraction passes have something to read. ';

const TEMPLATES: Template[] = [
  {
    kind: 'newsletter',
    from: 'The Weekly Digest <news@digest.example>',
    subject: (n) => `Your weekly digest #${n}: ten things worth reading`,
    body: (n) => `Newsletter ${n}. ${filler.repeat(6)}Unsubscribe any time.`,
    bulk: true,
    weight: 3,
  },
  {
    kind: 'coupon',
    from: 'ShopCo Deals <deals@shopco.example>',
    subject: (n) => `${10 + (n % 40)}% off everything this weekend only`,
    body: (n) => `Promo code SAVE${n}. ${filler.repeat(4)}Offer ends Sunday.`,
    bulk: true,
    weight: 3,
  },
  {
    kind: 'receipt',
    from: 'Amazon <auto-confirm@amazon.example>',
    subject: (n) => `Your receipt for order #${100000 + n}`,
    body: (n) => `Thanks for your order ${100000 + n}. Total $${(20 + (n % 80)).toFixed(2)}. ${filler.repeat(3)}`,
    weight: 2,
  },
  {
    kind: 'shipping',
    from: 'UPS <ship-notify@ups.example>',
    subject: (n) => `Your package is arriving on Thursday (order ${n})`,
    body: (n) =>
      `Tracking 1Z999AA1${String(1000000000 + n).slice(0, 10)}. Arriving Thursday by 8pm. ${filler.repeat(3)}`,
    weight: 2,
  },
  {
    kind: 'flight',
    from: 'United <no-reply@united.example>',
    subject: (n) => `Your trip to SFO — check in now (ref KX${n % 900}Q)`,
    body: (n) =>
      `Confirmation KX${n % 900}Q. Flight UA ${500 + (n % 400)} departs Fri 6:40am, seat 14C. ${filler.repeat(3)}`,
    weight: 1,
  },
  {
    kind: 'school',
    from: 'Ms. Alvarez <teacher@school.example>',
    subject: (n) => `Permission slip for the field trip due Friday (${n})`,
    body: (n) =>
      `Please sign and return the permission slip ${n} by Friday. The class is going to the science museum. ${filler.repeat(3)}`,
    weight: 2,
  },
  {
    kind: 'personal',
    from: 'Sam Rivera <sam.rivera@friends.example>',
    subject: (n) => `Sunday dinner? (${n})`,
    body: (n) =>
      `Hey, are you all coming over this Sunday at 5pm? Can you let me know what time works? Thoughts on bringing dessert? ${filler.repeat(2)}`,
    weight: 2,
  },
];

const totalWeight = TEMPLATES.reduce((n, t) => n + t.weight, 0);
let seq = 0;

export function mailFor(userId: string, kind?: string): GmailRawMessage {
  const n = ++seq;
  let t = kind ? TEMPLATES.find((x) => x.kind === kind) : undefined;
  if (!t) {
    let r = Math.random() * totalWeight;
    t = TEMPLATES.find((x) => (r -= x.weight) < 0) ?? TEMPLATES[0]!;
  }
  const id = `lm_${userId}_${n}`;
  const date = Date.now();
  const headers = [
    { name: 'From', value: t.from },
    { name: 'To', value: 'you@example.com' },
    { name: 'Subject', value: t.subject(n) },
    { name: 'Date', value: new Date(date).toUTCString() },
    { name: 'Message-ID', value: `<${id}@load.example>` },
  ];
  if (t.bulk) headers.push({ name: 'List-Unsubscribe', value: `<https://unsub.example/${id}>` });
  const body = t.body(n);
  return {
    id,
    threadId: `lt_${userId}_${n}`,
    labelIds: t.bulk ? ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] : ['INBOX', 'UNREAD'],
    snippet: body.slice(0, 100),
    internalDate: String(date),
    historyId: '1',
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { data: Buffer.from(body, 'utf8').toString('base64url') },
    },
  };
}
