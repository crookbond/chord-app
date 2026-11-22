import { describe, expect, it } from 'vitest';

import { createSharedReads } from '@chord/kernel';

/** A request the test answers by hand, recording what the server held then. */
function heldRequest<T>() {
  let answer!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    answer = r;
  });
  return { promise, answer };
}

describe('shared reads', () => {
  it('shares a read already on the wire', async () => {
    const reads = createSharedReads();
    let sent = 0;
    const first = heldRequest<string[]>();
    const a = reads.share('list', () => {
      sent += 1;
      return first.promise;
    });
    const b = reads.share('list', () => {
      sent += 1;
      return Promise.resolve(['never']);
    });
    first.answer(['m1']);
    expect(await a).toEqual(['m1']);
    expect(await b).toEqual(['m1']);
    expect(sent).toBe(1);
  });

  /**
   * Reported 2026-11-19 on the web Traditional list: emails put in Trash from
   * the reading pane came back, and were deleted again and again. The list
   * was read while the Trash was on its way (the read reached the server
   * first, so its answer still held the email); after the Trash was
   * confirmed the list asked again - and that ask joined the read already on
   * the wire, getting the answer from before the Trash.
   */
  it('a read after a write is sent fresh, not joined to one sent before it', async () => {
    const reads = createSharedReads();
    const mailbox = ['grandma', 'amazon', 'united', 'chase'];
    const beforeTrash = heldRequest<string[]>();
    const stale = reads.share('inbox', () => beforeTrash.promise);

    // The Trash is sent and confirmed while that read is still unanswered.
    reads.forget();
    mailbox.splice(mailbox.indexOf('grandma'), 1);
    reads.forget();

    const fresh = reads.share('inbox', () => Promise.resolve([...mailbox]));
    beforeTrash.answer(['grandma', 'amazon', 'united', 'chase']);

    expect(await fresh).toEqual(['amazon', 'united', 'chase']);
    // The read sent before the write still answers its own caller.
    expect(await stale).toContain('grandma');
  });

  it('a read sent after the write shares with later identical reads again', async () => {
    const reads = createSharedReads();
    reads.forget();
    let sent = 0;
    const held = heldRequest<number>();
    const a = reads.share('k', () => {
      sent += 1;
      return held.promise;
    });
    const b = reads.share('k', () => {
      sent += 1;
      return Promise.resolve(2);
    });
    held.answer(1);
    expect([await a, await b]).toEqual([1, 1]);
    expect(sent).toBe(1);
  });

  it('a stale read that answers late does not evict the fresh one from the table', async () => {
    const reads = createSharedReads();
    const stale = heldRequest<string>();
    void reads.share('k', () => stale.promise);
    reads.forget();
    const fresh = heldRequest<string>();
    let sent = 0;
    const f = reads.share('k', () => {
      sent += 1;
      return fresh.promise;
    });
    stale.answer('old');
    await Promise.resolve();
    // Still on the wire: a third ask joins the fresh read, not a new one.
    const g = reads.share('k', () => {
      sent += 1;
      return Promise.resolve('other');
    });
    fresh.answer('new');
    expect([await f, await g]).toEqual(['new', 'new']);
    expect(sent).toBe(1);
  });
});
