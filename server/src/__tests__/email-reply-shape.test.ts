import { describe, expect, it } from 'vitest';

import {
  asksAboutTime,
  emailReplyPoints,
  replyShapeOf,
  reviseReplyAsks,
  wantsPointByPoint,
  type EmailMessage,
} from '@chord/kernel';

function msg(over: Partial<EmailMessage>): EmailMessage {
  return {
    id: 'm1',
    gmailMessageId: 'g1',
    fromName: 'Priya',
    fromEmail: 'priya@example.com',
    toEmails: [],
    ccEmails: [],
    subject: 'Spring carpool',
    snippet: '',
    bodyText: null,
    bodyHtml: null,
    internalDate: '2026-11-10T15:00:00Z',
    isUnread: true,
    ...over,
  };
}

describe('emailReplyPoints', () => {
  it('reads real questions in order and skips pleasantries', () => {
    const text = [
      'Hi John,',
      'Hope you had a good weekend! How are you?',
      'Can you drive on Tuesdays this spring? Does Ben still need a booster seat?',
      'Also, are you OK splitting gas?',
      'Thanks, Priya',
    ].join('\n');
    expect(emailReplyPoints(text)).toEqual([
      'Can you drive on Tuesdays this spring?',
      'Does Ben still need a booster seat?',
      'Also, are you OK splitting gas?',
    ]);
  });

  it('uses numbered items when the message lists two or more', () => {
    const text = 'A few things before Friday:\n1. Confirm the headcount\n2) Send the allergy list\n- Pick a dessert';
    expect(emailReplyPoints(text)).toEqual(['Confirm the headcount', 'Send the allergy list', 'Pick a dessert']);
  });

  it('ignores quoted lines and the signature', () => {
    const text = 'Does 3pm work?\n> Can we move it?\n-- \nWhy not call me?';
    expect(emailReplyPoints(text)).toEqual(['Does 3pm work?']);
  });

  it('finds nothing in a message that asks nothing', () => {
    expect(emailReplyPoints('Thanks for the photos, they came out great.')).toEqual([]);
  });
});

describe('wantsPointByPoint', () => {
  it.each([
    ['Reply point by point, answering each of their points in order', true],
    ['answer each question', true],
    ['go through them one by one', true],
    ['Make it warmer', false],
    ['Make it longer and more complete', false],
  ])('%s', (instruction, expected) => {
    expect(wantsPointByPoint(instruction)).toBe(expected);
  });
});

describe('asksAboutTime', () => {
  it('spots scheduling', () => {
    expect(asksAboutTime('When works for you next week to meet?')).toBe(true);
    expect(asksAboutTime('Here is the receipt for the order.')).toBe(false);
  });
});

describe('reviseReplyAsks', () => {
  it('puts the chips that fit the email first, then every style change', () => {
    expect(reviseReplyAsks({ points: 3, aboutTime: true }).map((a) => a.label)).toEqual([
      'Point by point',
      'Suggest times',
      'Shorter',
      'Longer',
      'Warmer',
      'More formal',
    ]);
  });

  it('offers no point by point for a single question or a plain note', () => {
    const labels = reviseReplyAsks({ points: 1, aboutTime: false }).map((a) => a.label);
    expect(labels).toEqual(['Shorter', 'Longer', 'Warmer', 'More formal']);
  });

  it('the point-by-point chip is read as point by point by the writer', () => {
    const chip = reviseReplyAsks({ points: 2, aboutTime: false })[0];
    expect(wantsPointByPoint(chip.ask)).toBe(true);
  });
});

describe('replyShapeOf', () => {
  it('answers the newest message the user did not send', () => {
    const shape = replyShapeOf([
      msg({ id: 'a', bodyText: 'Can you drive Tuesday? Can you bring snacks?' }),
      msg({ id: 'b', sent: true, bodyText: 'Let me check and get back to you.' }),
    ]);
    expect(shape.points).toBe(2);
  });

  it('reads an HTML-only message without its quoted history', () => {
    const html =
      '<div><p>Can you host on Saturday?</p><p>Should we order pizza?</p></div>' +
      '<div class="gmail_quote">On Mon wrote:<blockquote>Is the gym open? Who has the key? What about parking?</blockquote></div>';
    const shape = replyShapeOf([msg({ bodyHtml: html })]);
    expect(shape.points).toBe(2);
  });

  it('notices a scheduling email from its subject', () => {
    const shape = replyShapeOf([msg({ bodyText: 'Let me know.' })], 'Finding a time to meet');
    expect(shape.aboutTime).toBe(true);
  });
});
