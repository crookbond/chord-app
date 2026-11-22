/**
 * ADR 0066 — pure helpers for the in-repo LLM email classifier.
 */
import { describe, expect, it } from 'vitest';

import { buildTreeFromPaths, categoryIdForPath } from '@/services/email/classifier-tree.js';
import {
  deterministicPathFor,
  gmailCategoryOf,
  mergePathAssignments,
  parseClassifierResponse,
} from '@/services/email/llm-classifier.js';
import { validateSnapshot , storageCategoryId } from '@/services/email/classification.service.js';

describe('parseClassifierResponse', () => {
  it('keeps only allowed thread ids and clamps path depth', () => {
    const raw = JSON.stringify({
      assignments: [
        { gmailThreadId: 't1', path: ['Travel', 'Flights', 'Extra', 'TooDeep'], confidence: 0.9 },
        { gmailThreadId: 'unknown', path: ['Finance'] },
        { gmailThreadId: 't2', path: [] },
      ],
    });
    const out = parseClassifierResponse(raw, new Set(['t1', 't2']), 2);
    expect(out).toEqual([{ gmailThreadId: 't1', path: ['Travel', 'Flights'], confidence: 0.9 }]);
  });

  it('returns [] on garbage', () => {
    expect(parseClassifierResponse('not json', new Set(['t1']), 3)).toEqual([]);
  });
});

describe('deterministicPathFor', () => {
  it('routes unmistakable senders (incl. subdomains) without the LLM', () => {
    expect(deterministicPathFor('jobs-noreply@linkedin.com')).toEqual([
      'Social & professional',
      'LinkedIn',
    ]);
    expect(deterministicPathFor('invites@mail.evite.com')).toEqual([
      'Events & invites',
      'Invitations',
    ]);
    expect(deterministicPathFor('notification@facebookmail.com')).toEqual([
      'Social & professional',
      'Social updates',
    ]);
  });

  it('does not match lookalike domains or plain senders', () => {
    expect(deterministicPathFor('me@notlinkedin.com')).toBeNull();
    expect(deterministicPathFor('grandma@example.com')).toBeNull();
    expect(deterministicPathFor(null)).toBeNull();
  });
});

describe('gmailCategoryOf', () => {
  it('maps CATEGORY_* labels to a lowercase hint, ignoring personal', () => {
    expect(gmailCategoryOf(['INBOX', 'CATEGORY_SOCIAL', 'UNREAD'])).toBe('social');
    expect(gmailCategoryOf(['CATEGORY_PROMOTIONS'])).toBe('promotions');
    expect(gmailCategoryOf(['CATEGORY_PERSONAL'])).toBeNull();
    expect(gmailCategoryOf(['INBOX'])).toBeNull();
  });
});

describe('mergePathAssignments', () => {
  it('preserves baseline threads and lets the batch win on overlap', () => {
    const merged = mergePathAssignments(
      [
        { gmailThreadId: 'old', path: ['Newsletters'], confidence: 0.5 },
        { gmailThreadId: 'shared', path: ['Travel', 'Hotels'] },
      ],
      [{ gmailThreadId: 'shared', path: ['Travel', 'Flights'], confidence: 0.95 }],
    );
    expect(merged).toEqual(
      expect.arrayContaining([
        { gmailThreadId: 'old', path: ['Newsletters'], confidence: 0.5 },
        { gmailThreadId: 'shared', path: ['Travel', 'Flights'], confidence: 0.95 },
      ]),
    );
    expect(merged).toHaveLength(2);
  });
});

describe('buildTreeFromPaths', () => {
  it('builds a valid snapshot tree with stable slug ids', () => {
    const { categories, assignments } = buildTreeFromPaths([
      { gmailThreadId: 't1', path: ['Travel', 'Flights'] },
      { gmailThreadId: 't2', path: ['Travel', 'Hotels'] },
    ]);
    expect(validateSnapshot({ version: 1, userId: 'u1', categories, assignments })).toEqual({
      ok: true,
    });
    // Snapshot ids stay user-local on purpose — the namespace is applied at
    // ingest, which is the only path the external classifier also crosses.
    expect(categoryIdForPath(['Travel', 'Flights'])).toBe('mk:travel/flights');
    expect(assignments.find((a) => a.gmailThreadId === 't1')?.categoryId).toBe('mk:travel/flights');
  });
});

describe('storageCategoryId', () => {
  it('gives two users different storage ids for the same snapshot id', () => {
    // `email_categories.id` is a GLOBAL primary key while ingest deletes per
    // user, so a shared id means the second user's whole transaction rolls back
    // on the pkey — which is how three prod mailboxes went unclassified for
    // days, logged only at warn.
    expect(storageCategoryId('u1', 'mk:newsletters')).not.toBe(
      storageCategoryId('u2', 'mk:newsletters'),
    );
  });

  it('is stable for one user, so tile ids do not churn between syncs', () => {
    expect(storageCategoryId('u1', 'mk:travel/flights')).toBe(
      storageCategoryId('u1', 'mk:travel/flights'),
    );
  });
});
