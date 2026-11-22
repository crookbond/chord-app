import { describe, expect, it } from 'vitest';

import {
  fetchPredatesRemoval,
  removedSinceFetch,
  withoutRemoved,
  type EmailRemovals,
} from '@chord/kernel';

/**
 * The client's own record of what it put away, as `email-thread-nav.ts`
 * keeps it: `removedAt` stamped at the tap and again at the confirmation,
 * `removing` holding what the mailbox has not answered yet.
 */
class Nav implements EmailRemovals {
  removing = new Set<string>();
  removedAt = new Map<string, number>();

  tap(id: string, at: number): void {
    this.removing.add(id);
    this.removedAt.set(id, at);
  }

  confirm(id: string, at: number): void {
    this.removing.delete(id);
    this.removedAt.set(id, at);
  }

  refuse(id: string): void {
    this.removing.delete(id);
    this.removedAt.delete(id);
  }
}

describe('email removals vs fetched data', () => {
  it('hides a removal the mailbox has not answered yet, whenever the data was fetched', () => {
    const nav = new Nav();
    nav.tap('a', 10);
    expect(removedSinceFetch(nav, 5, 'a')).toBe(true);
    expect(removedSinceFetch(nav, 20, 'a')).toBe(true);
  });

  it('keeps hiding it in data fetched before the confirmation', () => {
    const nav = new Nav();
    nav.tap('a', 10);
    nav.confirm('a', 30);
    // Asked for at 20: between the tap and the write landing, so the server
    // answered from a mirror that still had the thread in the inbox.
    expect(removedSinceFetch(nav, 20, 'a')).toBe(true);
    // Asked for at 40: after the write, so the server's answer is the truth.
    expect(removedSinceFetch(nav, 40, 'a')).toBe(false);
  });

  it('shows a refused removal again at once', () => {
    const nav = new Nav();
    nav.tap('a', 10);
    nav.refuse('a');
    expect(removedSinceFetch(nav, 5, 'a')).toBe(false);
    expect(removedSinceFetch(nav, 20, 'a')).toBe(false);
  });

  it('leaves alone an email nobody removed', () => {
    const nav = new Nav();
    nav.tap('a', 10);
    expect(removedSinceFetch(nav, 5, 'b')).toBe(false);
  });

  /**
   * The reported bug: delete the feed's emails one by one, and when the walk
   * ends the view comes back showing the last of them. Returning refetches in
   * the same moment as those taps, so the response is newer than the removals
   * and older than their writes - the server still has them in the inbox and
   * nothing asks again afterwards.
   */
  describe('the walk that triggers its own refetch', () => {
    const inbox = ['a', 'b', 'c', 'd'].map((threadId) => ({ threadId }));
    const walk = (): { nav: Nav; landed: Map<string, number> } => {
      const nav = new Nav();
      const landed = new Map<string, number>();
      const put = (id: string, tapped: number, wrote: number) => {
        nav.tap(id, tapped);
        landed.set(id, wrote);
      };
      put('a', 100, 160);
      put('b', 200, 280);
      put('c', 300, 380); // last of the walk - its write is still in flight
      return { nav, landed };
    };
    /** What the tiles endpoint answers a fetch issued at `fetchedAt`. */
    const answerTo = (landed: Map<string, number>, fetchedAt: number) =>
      inbox.filter((p) => (landed.get(p.threadId) ?? Infinity) > fetchedAt);

    it('leaves out an email whose write had not landed when the data was asked for', () => {
      const { nav, landed } = walk();
      const refetchedAt = 310;
      for (const [id, at] of landed) if (at <= refetchedAt) nav.confirm(id, at);
      // Everything whose write landed is already gone from the server's
      // answer; the one still in flight is not, and is what came back.
      expect(answerTo(landed, refetchedAt)).toEqual([{ threadId: 'c' }, { threadId: 'd' }]);
      expect(withoutRemoved(answerTo(landed, refetchedAt), (p) => p.threadId, nav, refetchedAt))
        .toEqual([{ threadId: 'd' }]);
    });

    it('keeps it out once that write lands, rather than letting the answer stand', () => {
      const { nav, landed } = walk();
      const refetchedAt = 310;
      const answer = answerTo(landed, refetchedAt);
      for (const [id, at] of landed) nav.confirm(id, at);
      expect(withoutRemoved(answer, (p) => p.threadId, nav, refetchedAt)).toEqual([
        { threadId: 'd' },
      ]);
      // And that answer is known to be short of a row, so it is worth one
      // more fetch - whose own answer is trusted whole.
      expect(fetchPredatesRemoval(nav, refetchedAt)).toBe(true);
      const freshAt = 400;
      expect(fetchPredatesRemoval(nav, freshAt)).toBe(false);
      expect(withoutRemoved(answerTo(landed, freshAt), (p) => p.threadId, nav, freshAt)).toEqual([
        { threadId: 'd' },
      ]);
    });
  });

  /**
   * Reported 2026-11-19 on the web Traditional list: trashing emails from the
   * open email (the reading pane) one after another, the same emails kept
   * coming back and were deleted again and again. The list hid only what was
   * still PENDING, so a list read issued before a write landed - and answered
   * after the mailbox confirmed it - put the row back, and nothing read the
   * list again after a reader-side Trash.
   */
  describe('trashing from the reader while the list re-reads', () => {
    const inbox = ['m1', 'm2', 'm3', 'm4'].map((id) => ({ id }));
    const pendingOnly = (rows: { id: string }[], nav: Nav) =>
      rows.filter((r) => !nav.removing.has(r.id));

    it('keeps the trashed rows out of an answer that predates their writes', () => {
      const nav = new Nav();
      nav.tap('m1', 100);
      nav.tap('m2', 150);
      // The list is re-read at 160 (focus, a sync event): the server's mirror
      // still holds both, since neither write has landed.
      const askedAt = 160;
      const answer = inbox;
      nav.confirm('m1', 200);
      nav.confirm('m2', 240);
      // The answer arrives at 250. The old rule showed both again.
      expect(pendingOnly(answer, nav).map((r) => r.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(withoutRemoved(answer, (r) => r.id, nav, askedAt).map((r) => r.id)).toEqual([
        'm3',
        'm4',
      ]);
      // And the list knows to read again; that read is trusted whole.
      expect(fetchPredatesRemoval(nav, askedAt)).toBe(true);
      expect(fetchPredatesRemoval(nav, 260)).toBe(false);
    });

    it('a list nobody re-reads still hides a trash confirmed after its read', () => {
      const nav = new Nav();
      const askedAt = 50; // the list on screen, read before any of this
      nav.tap('m3', 100);
      nav.confirm('m3', 180);
      expect(pendingOnly(inbox, nav).map((r) => r.id)).toContain('m3');
      expect(withoutRemoved(inbox, (r) => r.id, nav, askedAt).map((r) => r.id)).not.toContain(
        'm3',
      );
    });

    it('does not ask for a re-read while the write is still pending', () => {
      const nav = new Nav();
      nav.tap('m1', 100);
      expect(fetchPredatesRemoval(nav, 50)).toBe(false);
      nav.confirm('m1', 200);
      expect(fetchPredatesRemoval(nav, 50)).toBe(true);
    });

    it('a refused trash comes back, and asks for nothing', () => {
      const nav = new Nav();
      nav.tap('m1', 100);
      nav.refuse('m1');
      expect(withoutRemoved(inbox, (r) => r.id, nav, 50).map((r) => r.id)).toContain('m1');
      expect(fetchPredatesRemoval(nav, 50)).toBe(false);
    });
  });

  it('does not ask again for data fetched after every confirmation', () => {
    const nav = new Nav();
    nav.tap('a', 10);
    nav.confirm('a', 30);
    expect(fetchPredatesRemoval(nav, 40)).toBe(false);
  });
});
