import { describe, expect, it } from 'vitest';

import { applyReplyAll, replyAllAdds, type ReplyTarget } from '@chord/kernel';

const ME = 'me@example.com';

const group: ReplyTarget = {
  fromEmail: 'sender@example.com',
  toEmails: [ME, 'ruth@example.com'],
  ccEmails: ['chen@example.com'],
};

const oneToOne: ReplyTarget = {
  fromEmail: 'sender@example.com',
  toEmails: [ME],
  ccEmails: [],
};

describe('replyAllAdds', () => {
  it('is empty when reply-all would reach nobody new', () => {
    expect(replyAllAdds(oneToOne, ME)).toEqual([]);
    expect(replyAllAdds(null, ME)).toEqual([]);
  });

  it('names the other recipients and never the user', () => {
    expect(replyAllAdds(group, ME)).toEqual(['ruth@example.com', 'chen@example.com']);
  });

  it('does not count the sender, who a plain reply already reaches', () => {
    const toSelfAndSender: ReplyTarget = {
      fromEmail: 'sender@example.com',
      toEmails: [ME, 'SENDER@example.com'],
      ccEmails: [],
    };
    expect(replyAllAdds(toSelfAndSender, ME)).toEqual([]);
  });
});

describe('applyReplyAll', () => {
  const plain = { to: ['sender@example.com'], cc: [] as string[] };

  it('fills Cc with everyone else and leaves To alone', () => {
    expect(applyReplyAll(plain, group, { replyAll: true, myEmail: ME })).toEqual({
      to: ['sender@example.com'],
      cc: ['ruth@example.com', 'chen@example.com'],
    });
  });

  it('keeps an address the user typed while writing', () => {
    const typed = { to: ['sender@example.com'], cc: ['boss@example.com'] };
    expect(applyReplyAll(typed, group, { replyAll: true, myEmail: ME })).toEqual({
      to: ['sender@example.com'],
      cc: ['boss@example.com', 'ruth@example.com', 'chen@example.com'],
    });
  });

  it('removes only what reply-all added when switched back off', () => {
    const wide = {
      to: ['sender@example.com'],
      cc: ['boss@example.com', 'ruth@example.com', 'chen@example.com'],
    };
    expect(applyReplyAll(wide, group, { replyAll: false, myEmail: ME })).toEqual({
      to: ['sender@example.com'],
      cc: ['boss@example.com'],
    });
  });

  it('leaves a hand-typed To line alone through both switches', () => {
    // The sender was deleted on purpose; reply-all must not put them back.
    const edited = { to: ['someone.else@example.com'], cc: [] as string[] };
    const on = applyReplyAll(edited, group, { replyAll: true, myEmail: ME });
    expect(on.to).toEqual(['someone.else@example.com']);
    expect(on.cc).toEqual(['ruth@example.com', 'chen@example.com']);
    expect(applyReplyAll(on, group, { replyAll: false, myEmail: ME })).toEqual(edited);
  });

  it('does not add someone the user already addressed', () => {
    const already = { to: ['sender@example.com', 'Ruth@example.com'], cc: [] as string[] };
    const on = applyReplyAll(already, group, { replyAll: true, myEmail: ME });
    expect(on.to).toEqual(['sender@example.com', 'Ruth@example.com']);
    expect(on.cc).toEqual(['chen@example.com']);
  });
});
