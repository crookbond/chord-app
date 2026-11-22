/**
 * ADR 0150 — learn a routing rule from a correction.
 *
 * After a user routes an email-derived proposal into a shared group by hand
 * (the ADR 0097 chip), `confirmProposal` offers a one-tap `routeSuggestion` to
 * make it a standing `sender_domain` rule. Deterministic, heavily gated, and it
 * only ever pre-selects a future proposal — never routes anything on its own.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  listRoutingRules,
  setRoutingRule,
  suggestRuleFromRouting,
} from '@/services/email/routing-rules.service.js';
import { confirmProposal, createProposal } from '@/services/proposals.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('routing rule learned from a correction (ADR 0150)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let familyGroupId: string;
  let teamGroupId: string;
  let personalGroupId: string;

  beforeEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'router-user');
    familyGroupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: userId })).id;
    teamGroupId = (await createGroup(db, { name: 'Soccer Team', kind: 'group', createdBy: userId })).id;
    personalGroupId = (await ensurePersonalGroup(db, userId)).id;
    return async () => {
      (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
      await closeTestDb(db);
    };
  });

  /** Seed a Gmail thread the user owns, from `fromEmail`. */
  async function seedThread(gmailThreadId: string, fromEmail: string): Promise<void> {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('et'),
        user_id: userId,
        gmail_thread_id: gmailThreadId,
        subject: 'Pack meeting',
        snippet: 'Thursday 6pm',
        from_email: fromEmail,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  describe('suggestRuleFromRouting', () => {
    it('suggests a sender_domain rule for the routed group', async () => {
      await seedThread('g1', 'cubmaster@scouting.org');
      const s = await suggestRuleFromRouting(db, {
        userId,
        provenance: 'gmail:g1',
        targetGroupId: familyGroupId,
      });
      expect(s).toEqual({
        pattern: 'scouting.org',
        targetGroupId: familyGroupId,
        targetGroupName: 'Doe Family',
      });
    });

    it('uses the exact sender host as the pattern (no public-suffix guessing)', async () => {
      await seedThread('g1', 'cubmaster@pack42.scouting.org');
      const s = await suggestRuleFromRouting(db, {
        userId,
        provenance: 'gmail:g1',
        targetGroupId: familyGroupId,
      });
      // Narrower is safer for a learned rule; the user can broaden it in Settings.
      expect(s?.pattern).toBe('pack42.scouting.org');
    });

    it('is suppressed when a sender_domain rule already routes that domain there', async () => {
      await seedThread('g1', 'cubmaster@scouting.org');
      await setRoutingRule(db, {
        userId,
        kind: 'sender_domain',
        pattern: 'scouting.org',
        targetGroupId: familyGroupId,
      });
      expect(
        await suggestRuleFromRouting(db, { userId, provenance: 'gmail:g1', targetGroupId: familyGroupId }),
      ).toBeNull();
    });

    it('sets `replaces` when a rule points the domain at a different group', async () => {
      await seedThread('g1', 'cubmaster@scouting.org');
      await setRoutingRule(db, {
        userId,
        kind: 'sender_domain',
        pattern: 'scouting.org',
        targetGroupId: teamGroupId,
      });
      const s = await suggestRuleFromRouting(db, {
        userId,
        provenance: 'gmail:g1',
        targetGroupId: familyGroupId,
      });
      expect(s).toMatchObject({
        pattern: 'scouting.org',
        targetGroupId: familyGroupId,
        replaces: { targetGroupName: 'Soccer Team' },
      });
    });

    it('no suggestion when the destination is the personal group', async () => {
      await seedThread('g1', 'cubmaster@scouting.org');
      expect(
        await suggestRuleFromRouting(db, {
          userId,
          provenance: 'gmail:g1',
          targetGroupId: personalGroupId,
        }),
      ).toBeNull();
    });

    it('no suggestion for non-email provenance', async () => {
      expect(
        await suggestRuleFromRouting(db, {
          userId,
          provenance: 'attachment:abc',
          targetGroupId: familyGroupId,
        }),
      ).toBeNull();
      expect(
        await suggestRuleFromRouting(db, { userId, provenance: null, targetGroupId: familyGroupId }),
      ).toBeNull();
    });

    it('no suggestion when the sender has no parseable domain', async () => {
      await seedThread('g1', 'weird-sender-no-at');
      expect(
        await suggestRuleFromRouting(db, { userId, provenance: 'gmail:g1', targetGroupId: familyGroupId }),
      ).toBeNull();
    });

    it('no suggestion when the user is not a member of the target group', async () => {
      await seedThread('g1', 'cubmaster@scouting.org');
      const otherOwner = await createUser(db, 'other-owner');
      const strangerGroup = (
        await createGroup(db, { name: 'Not Mine', kind: 'group', createdBy: otherOwner })
      ).id;
      expect(
        await suggestRuleFromRouting(db, {
          userId,
          provenance: 'gmail:g1',
          targetGroupId: strangerGroup,
        }),
      ).toBeNull();
    });
  });

  describe('confirmProposal wiring', () => {
    async function stageTaskProposal(gmailThreadId: string): Promise<string> {
      const p = await createProposal(db, {
        groupId: personalGroupId,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'create_task',
        args: { title: 'Bring snacks to the pack meeting' },
        provenance: `gmail:${gmailThreadId}`,
      });
      return p.id;
    }

    it('returns a routeSuggestion when the user routes into a shared group', async () => {
      await seedThread('g1', 'cubmaster@scouting.org');
      const id = await stageTaskProposal('g1');
      const res = await confirmProposal(db, {
        id,
        resolvedByUserId: userId,
        targetGroupId: familyGroupId,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.routeSuggestion).toEqual({
        pattern: 'scouting.org',
        targetGroupId: familyGroupId,
        targetGroupName: 'Doe Family',
      });
    });

    it('no routeSuggestion on a plain "Just me" confirm', async () => {
      await seedThread('g1', 'cubmaster@scouting.org');
      const id = await stageTaskProposal('g1');
      const res = await confirmProposal(db, { id, resolvedByUserId: userId });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.routeSuggestion).toBeUndefined();
    });

    it('accepting the offer creates the rule that then routes the next thread', async () => {
      await seedThread('g1', 'cubmaster@scouting.org');
      const id = await stageTaskProposal('g1');
      const res = await confirmProposal(db, { id, resolvedByUserId: userId, targetGroupId: familyGroupId });
      expect(res.ok && res.routeSuggestion).toBeTruthy();
      if (!res.ok || !res.routeSuggestion) return;

      // The mobile "Yes" tap is POST /me/email/routes → setRoutingRule.
      await setRoutingRule(db, {
        userId,
        kind: 'sender_domain',
        pattern: res.routeSuggestion.pattern,
        targetGroupId: res.routeSuggestion.targetGroupId,
      });
      const rules = await listRoutingRules(db, userId);
      expect(rules).toEqual([
        expect.objectContaining({
          kind: 'sender_domain',
          pattern: 'scouting.org',
          targetGroupName: 'Doe Family',
        }),
      ]);

      // ...and the offer no longer recurs for that sender/group.
      await seedThread('g2', 'treasurer@scouting.org');
      expect(
        await suggestRuleFromRouting(db, { userId, provenance: 'gmail:g2', targetGroupId: familyGroupId }),
      ).toBeNull();
    });
  });
});
