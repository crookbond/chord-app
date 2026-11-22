/**
 * Dev-only fixture classifier (ADR 0061). Stands in for a real clustering
 * engine so the AI tile view + drill-down work without LLM cost. It writes
 * through the SAME contract + ingest path the LLM classifier uses
 * (snapshot → ingestClassification), building a nested tree from the user's
 * synced threads via cheap sender/subject heuristics. Gated by
 * EMAIL_CLASSIFIER=mock and invoked after a Gmail sync. NOT the product classifier.
 */
import type { Kysely } from 'kysely';

import type { EmailAction, EmailClassificationSnapshot } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { buildTreeFromPaths } from './classifier-tree.js';
import { ingestClassification } from './classification.service.js';

/** Classify one thread into a category PATH (top → …→ leaf). Null = leave
 *  unclassified. Deliberately simple + deterministic. */
export function classifyThread(fromEmail: string | null, subject: string): string[] | null {
  const hay = `${fromEmail ?? ''} ${subject}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => hay.includes(w));

  if (has('flight', 'airline', 'united', 'delta', 'boarding', 'check in')) return ['Travel', 'Flights'];
  if (has('hotel', 'airbnb', 'booking.com', 'checkin', 'check-in', 'stay')) return ['Travel', 'Hotels'];
  if (has('uber', 'lyft', 'taxi', 'ride ')) return ['Travel', 'Ground transport'];
  if (has('hertz', 'avis', 'enterprise', 'car rental', 'rental car')) return ['Travel', 'Car rentals'];

  if (has('statement', 'chase', 'amex', 'citi', 'visa', 'mastercard')) return ['Finance', 'Credit card statements'];
  if (has('bank', 'balance', 'deposit', 'overdraft')) return ['Finance', 'Bank alerts'];
  if (has('paystub', 'payroll', 'payslip', 'direct deposit')) return ['Finance', 'Paystubs'];

  if (has('ship', 'delivery', 'arriving', 'tracking', 'order', 'amazon', 'package')) {
    return ['Deliveries', 'Shipping updates'];
  }

  if (has('permission slip', 'consent form', 'form', 'waiver')) return ['Friends & family', 'Forms to fill'];
  if (has('school', 'teacher', 'classroom', 'pta', 'homework')) return ['Friends & family', 'School notes'];
  if (has('playdate', 'dinner', 'party', 'invite', 'rsvp', 'birthday')) {
    return ['Friends & family', 'Playdates & invites'];
  }

  if (has('receipt')) return ['Receipts'];
  if (has('coupon', '% off', 'sale', 'promo', 'deal')) return ['Coupons'];
  if (has('newsletter', 'digest', 'weekly')) return ['Newsletters'];
  if (has('recipe')) return ['Recipes / forwards'];

  return null;
}

/**
 * Fixture for the action axis. Independent of `classifyThread` on purpose:
 * the two axes are orthogonal, and a mock that derived one from the other
 * would hide exactly the bug we would want a test to catch.
 */
export function classifyAction(subject: string, snippet = ''): EmailAction {
  const hay = `${subject} ${snippet}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => hay.includes(w));

  if (has('rsvp', 'permission slip', 'sign up', 'due ', 'action required', 'confirm your')) {
    return 'to_do';
  }
  if (has('?', 're:', 'can you', 'let me know', 'thoughts', 'what time')) return 'reply_needed';
  if (has('statement', 'receipt', 'shipped', 'delivered', 'newsletter', 'digest', 'confirmation')) {
    return 'informational';
  }
  return 'other';
}

/** Build a snapshot from classified threads: only the paths actually used
 *  (plus their ancestors) become categories, so tiles reflect real mail. */
export function buildSnapshot(
  userId: string,
  threads: {
    gmailThreadId: string;
    fromEmail: string | null;
    subject: string;
    snippet?: string;
  }[],
): EmailClassificationSnapshot {
  const pathAssignments = [];
  for (const t of threads) {
    const path = classifyThread(t.fromEmail, t.subject);
    if (!path) continue;
    pathAssignments.push({
      gmailThreadId: t.gmailThreadId,
      path,
      confidence: 0.9,
      action: classifyAction(t.subject, t.snippet ?? ''),
    });
  }
  const { categories, assignments } = buildTreeFromPaths(pathAssignments);
  return { version: 1, userId, categories, assignments };
}

/** Reclassify the user's synced threads with the fixture and ingest the result.
 *  No-op unless EMAIL_CLASSIFIER=mock. */
export async function runMockClassifier(db: Kysely<DB>, userId: string): Promise<void> {
  if (env.EMAIL_CLASSIFIER !== 'mock') return;
  const threads = await db
    .selectFrom('email_threads')
    .select(['gmail_thread_id', 'from_email', 'subject', 'snippet'])
    .where('user_id', '=', userId)
    .execute();
  if (threads.length === 0) return;
  const snapshot = buildSnapshot(
    userId,
    threads.map((t) => ({
      gmailThreadId: t.gmail_thread_id,
      fromEmail: t.from_email,
      subject: t.subject,
      snippet: t.snippet,
    })),
  );
  const result = await ingestClassification(db, userId, snapshot);
  if ('ok' in result) {
    logger.warn('mock classifier produced an invalid snapshot', { userId, error: result.error });
    return;
  }
  logger.info(
    `mock classifier user=${userId} categories=${result.categories} assignments=${result.assignments}`,
  );
}
