/**
 * Printing and sharing a thread (ADR 0121).
 */
import { describe, expect, it } from 'vitest';

import { printableThreadHtml, threadToPlainText } from '@chord/kernel';

const thread = {
  subject: 'Soccer & practice <times>',
  messages: [
    {
      from: 'Coach <coach@x.example>',
      dateLabel: 'Aug 4, 9:12 AM',
      to: ['me@x.example'],
      cc: ['other@x.example'],
      sanitizedHtml: '<p>Practice moved to <b>5pm</b>.</p>',
      text: 'Practice moved to 5pm.',
    },
    {
      from: 'Me <me@x.example>',
      dateLabel: 'Aug 4, 9:20 AM',
      text: 'Got it, thanks.',
      sanitizedHtml: null,
    },
  ],
};

describe('printableThreadHtml', () => {
  it('escapes the subject rather than letting it become markup', () => {
    const out = printableThreadHtml(thread);

    expect(out).toContain('Soccer &amp; practice &lt;times&gt;');
    expect(out).not.toContain('<times>');
  });

  it('passes sanitized bodies through, because that is the whole job', () => {
    expect(printableThreadHtml(thread)).toContain('<p>Practice moved to <b>5pm</b>.</p>');
  });

  it('falls back to escaped text when a message has no html', () => {
    const out = printableThreadHtml({
      subject: 'x',
      messages: [{ from: 'a', dateLabel: 'b', text: 'plain & <unmarked>' }],
    });

    expect(out).toContain('plain &amp; &lt;unmarked&gt;');
  });

  it('escapes recipients in the meta line', () => {
    const out = printableThreadHtml({
      subject: 'x',
      messages: [{ from: 'a', dateLabel: 'b', to: ['<script>@x.example'], text: 'hi' }],
    });

    expect(out).not.toContain('<script>');
  });

  it('is a standalone document that fetches nothing of its own', () => {
    const out = printableThreadHtml(thread);

    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).not.toContain('<link');
    expect(out).not.toContain('<script');
  });
});

describe('threadToPlainText', () => {
  it('leads with the subject and separates the messages', () => {
    const out = threadToPlainText(thread);

    expect(out.startsWith('Soccer & practice <times>')).toBe(true);
    expect(out).toContain('Practice moved to 5pm.');
    expect(out).toContain('Got it, thanks.');
    expect(out).toContain('----');
  });

  it('carries the recipients it was given', () => {
    expect(threadToPlainText(thread)).toContain('Cc: other@x.example');
  });

  it('copes with an empty subject', () => {
    expect(threadToPlainText({ subject: '', messages: [] })).toBe('(no subject)');
  });
});
