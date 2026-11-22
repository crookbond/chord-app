/**
 * A small labelled mailbox for measuring email search.
 *
 * Built around the ways search failed in use: a person asked for by name
 * ("emails from Bill") losing to every newer message that mentions a bill; a
 * thread missed because someone else sent its last message; a nickname; mail
 * the user SENT; and queries that share no word with the email they mean.
 * Filler mail is the newest in the box on purpose, so a search that orders by
 * date instead of by match shows up as a lower score.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../../db/schema.js';
import { seedSyncedMail, type SeedMailOpts } from '../../../__test-helpers__/email-seeds.js';
import { sealThreadJsonFor } from '../../email/content-seal.js';

export const ME = 'me@family.test';

interface CorpusMessage extends Omit<SeedMailOpts, 'at' | 'gmailThreadId'> {
  daysAgo: number;
}

export interface EmailCorpusThread {
  key: string;
  messages: CorpusMessage[];
  receipt?: { merchant: string; amount: number; currency: string; purchasedAt: string };
}

const BILL = { fromName: 'Bill Smith', fromEmail: 'bill.test@gmail.com' };
const ROBERT = { fromName: 'Robert Jones', fromEmail: 'rjones@northfield.test' };
const SELF = { fromName: 'Me', fromEmail: ME };

export const EMAIL_CORPUS: EmailCorpusThread[] = [
  {
    key: 'bill_cabin',
    messages: [
      {
        ...BILL,
        toEmails: [ME],
        subject: 'Cabin weekend in March',
        body: 'Want to use the lake house the second weekend of March? I can bring the kayaks and firewood.',
        daysAgo: 40,
      },
      // The user replied last, so the thread's own sender is the user, not Bill.
      {
        ...SELF,
        toEmails: [BILL.fromEmail],
        subject: 'Re: Cabin weekend in March',
        body: 'Yes, that works for us. We will bring food for Saturday.',
        daysAgo: 39,
      },
    ],
  },
  {
    key: 'bill_golf',
    messages: [{ ...BILL, toEmails: [ME], subject: 'Tee time Saturday?', body: 'Got a 9:10 at Pine Ridge. In?', daysAgo: 20 }],
  },
  {
    key: 'robert_budget',
    messages: [
      { ...ROBERT, toEmails: [ME], subject: 'Q3 budget review deck', body: 'Attached the deck for the PTA budget meeting.', daysAgo: 15 },
    ],
  },
  {
    key: 'sent_to_bill',
    messages: [
      {
        ...SELF,
        toEmails: [BILL.fromEmail],
        subject: 'Directions to the lake house',
        body: 'Take exit 14, left at the general store, gravel road for two miles.',
        daysAgo: 38,
      },
    ],
  },
  {
    key: 'billing_acme',
    messages: [
      {
        fromName: 'Acme Billing',
        fromEmail: 'billing@acme.com',
        toEmails: [ME],
        subject: 'Your invoice #4471 is ready',
        body: 'Your bill for this period is ready. Pay your bill online.',
        daysAgo: 3,
      },
    ],
  },
  {
    key: 'bills_newsletter',
    messages: [
      {
        fromName: 'Money Weekly',
        fromEmail: 'news@moneyweekly.test',
        toEmails: [ME],
        subject: '5 bills you should automate this year',
        body: 'Utility bills, phone bills and more. Read this email for tips.',
        daysAgo: 2,
      },
    ],
  },
  {
    key: 'costco_1',
    messages: [
      {
        fromName: 'Costco',
        fromEmail: 'orders@costco.com',
        toEmails: [ME],
        subject: 'Your Costco order has shipped',
        body: 'Order 99812: paper towels, olive oil. Total $84.17. Receipt attached.',
        daysAgo: 12,
      },
    ],
    receipt: { merchant: 'Costco', amount: 84.17, currency: 'USD', purchasedAt: '2026-10-07' },
  },
  {
    key: 'costco_2',
    messages: [
      {
        fromName: 'Costco',
        fromEmail: 'orders@costco.com',
        toEmails: [ME],
        subject: 'Thanks for shopping at Costco',
        body: 'Warehouse purchase. Total $212.40. Keep this email as your receipt.',
        daysAgo: 30,
      },
    ],
    receipt: { merchant: 'Costco', amount: 212.4, currency: 'USD', purchasedAt: '2026-09-19' },
  },
  {
    key: 'field_trip',
    messages: [
      {
        fromName: 'Lincoln Elementary Office',
        fromEmail: 'office@lincoln-elem.org',
        toEmails: [ME],
        subject: 'Field trip form due Friday',
        body: 'Please sign the permission slip for the aquarium visit and return it with your child by Friday.',
        daysAgo: 6,
      },
    ],
  },
  {
    key: 'district_newsletter',
    messages: [
      {
        fromName: 'District News',
        fromEmail: 'newsletter@district.test',
        toEmails: [ME],
        subject: 'October district update',
        body: 'Board meeting recap, bus route changes, and a note that the school calendar is online.',
        daysAgo: 5,
      },
    ],
  },
  {
    key: 'plumber',
    messages: [
      {
        fromName: "Mike's Plumbing",
        fromEmail: 'mike@fixitplumbing.test',
        toEmails: [ME],
        subject: 'Leak under the kitchen sink - quote',
        body: 'Replacing the trap and supply line will be $240 parts and labor. Can come Tuesday.',
        daysAgo: 25,
      },
    ],
  },
  {
    key: 'flight',
    messages: [
      {
        fromName: 'United Airlines',
        fromEmail: 'receipts@united.com',
        toEmails: [ME],
        subject: 'Your trip confirmation',
        body: 'Flight UA512 Newark to Denver departs 8:05 AM on November 14. Confirmation KX8QP2.',
        daysAgo: 18,
      },
    ],
  },
  {
    key: 'dentist',
    messages: [
      {
        fromName: 'Bright Smiles Dental',
        fromEmail: 'frontdesk@brightsmiles.test',
        toEmails: [ME],
        subject: 'Reminder from Dr. Patel',
        body: 'Your cleaning appointment is on Monday at 3:30 PM. Reply C to confirm.',
        daysAgo: 4,
      },
    ],
  },
  {
    key: 'soccer',
    messages: [
      {
        fromName: 'Coach Dan',
        fromEmail: 'dan.coach@gmail.com',
        toEmails: [ME],
        subject: 'Practice moved to Thursday',
        body: 'Field is closed Wednesday so U10 practice moves to Thursday 5pm. Bring water.',
        daysAgo: 7,
      },
    ],
  },
  // Filler: the newest mail in the box, matching none of the queries' intent.
  ...['Flash sale: 40% off boots', 'Your weekly email digest', 'New sign-in on your account', 'Pick up where you left off', 'Billboard top songs this week'].map(
    (subject, i): EmailCorpusThread => ({
      key: `filler_${i}`,
      messages: [
        {
          fromName: 'Promo',
          fromEmail: `promo${i}@deals.test`,
          toEmails: [ME],
          subject,
          body: `${subject}. Read this email in your browser. Unsubscribe any time.`,
          daysAgo: i * 0.1,
        },
      ],
    }),
  ),
];

export type EmailQueryClass = 'person' | 'keyword' | 'paraphrase' | 'context';

export interface EmailEvalQuery {
  query: string;
  cls: EmailQueryClass;
  /** Every thread that answers it. Order does not matter. */
  relevant: string[];
  /** Threads that must NOT appear in the top five (a wrong person, say). */
  wrong?: string[];
}

export const EMAIL_QUERIES: EmailEvalQuery[] = [
  { query: 'emails from Bill Smith', cls: 'person', relevant: ['bill_cabin', 'bill_golf'], wrong: ['billing_acme', 'bills_newsletter'] },
  { query: 'what did Bill Smith send me', cls: 'person', relevant: ['bill_cabin', 'bill_golf'], wrong: ['billing_acme', 'bills_newsletter'] },
  { query: 'from:bill', cls: 'person', relevant: ['bill_cabin', 'bill_golf'], wrong: ['billing_acme', 'bills_newsletter'] },
  { query: 'emails from Bob', cls: 'person', relevant: ['robert_budget'] },
  { query: 'emails I sent to Bill Smith', cls: 'person', relevant: ['sent_to_bill', 'bill_cabin'], wrong: ['billing_acme'] },
  { query: 'mail from the dentist', cls: 'person', relevant: ['dentist'] },
  { query: 'plumber quote', cls: 'keyword', relevant: ['plumber'] },
  { query: 'UA512', cls: 'keyword', relevant: ['flight'] },
  { query: 'costco receipt', cls: 'keyword', relevant: ['costco_1', 'costco_2'] },
  { query: 'permission slip', cls: 'keyword', relevant: ['field_trip'] },
  { query: 'dentist appointment', cls: 'keyword', relevant: ['dentist'] },
  { query: 'kids excursion paperwork', cls: 'paraphrase', relevant: ['field_trip'] },
  { query: 'pipe leak repair estimate', cls: 'paraphrase', relevant: ['plumber'] },
  { query: 'plane tickets to Denver', cls: 'paraphrase', relevant: ['flight'] },
  { query: 'teeth cleaning', cls: 'paraphrase', relevant: ['dentist'] },
  { query: 'Bill Smith about the cabin', cls: 'context', relevant: ['bill_cabin'] },
  { query: 'soccer practice change', cls: 'context', relevant: ['soccer'] },
  { query: 'school form I need to sign', cls: 'context', relevant: ['field_trip'] },
];

/** Seed the corpus into `owner`'s mailbox. Returns thread row id → corpus key. */
export async function seedEmailCorpus(db: Kysely<DB>, owner: string): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  const now = Date.now();
  for (const t of EMAIL_CORPUS) {
    const gmailThreadId = `gt_eval_${t.key}`;
    let rowId = '';
    for (const m of t.messages) {
      const { daysAgo, ...opts } = m;
      rowId = await seedSyncedMail(db, owner, {
        ...opts,
        gmailThreadId,
        at: new Date(now - daysAgo * 86_400_000).toISOString(),
      });
    }
    if (t.receipt) {
      await db
        .updateTable('email_threads')
        .set({ receipt_json: await sealThreadJsonFor(db, rowId, 'receipt_json', t.receipt) })
        .where('id', '=', rowId)
        .execute();
    }
    byId.set(rowId, t.key);
  }
  return byId;
}
