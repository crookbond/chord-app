/**
 * Formatting a message someone wrote (ADR 0131). The governing rule: mangling
 * what someone typed is worse than not formatting it, so every case where the
 * marker is ambiguous resolves to "leave it alone".
 */
import { describe, expect, it } from 'vitest';

import { hasMarkdown, markdownToHtml } from '@chord/kernel';

describe('markdownToHtml', () => {
  it('escapes before it formats, so typed markup stays text', () => {
    const out = markdownToHtml('use <b>tags</b> & things');

    expect(out).toContain('&lt;b&gt;tags&lt;/b&gt; &amp; things');
    expect(out).not.toContain('<b>');
  });

  it('renders bold', () => {
    expect(markdownToHtml('this is **important** ok')).toContain('<strong>important</strong>');
  });

  it('leaves single asterisks alone', () => {
    // `*` turns up in prose and maths; `**` does not occur by accident.
    const out = markdownToHtml('2 * 3 * 4 and a *maybe*');

    expect(out).not.toContain('<strong>');
    expect(out).not.toContain('<em>');
  });

  it('does not bold across a blank gap', () => {
    expect(markdownToHtml('** not bold **')).not.toContain('<strong>');
  });

  it('renders a link', () => {
    expect(markdownToHtml('see [the form](https://school.example/f)')).toContain(
      '<a href="https://school.example/f">the form</a>',
    );
  });

  it('refuses an unsafe scheme, keeping the literal text', () => {
    // Authoring a javascript: href into outgoing mail is not relaying, it is
    // writing it.
    const out = markdownToHtml('[click](javascript:alert(1))');

    expect(out).not.toContain('<a href');
    expect(out).toContain('[click](javascript:alert(1))');
  });

  it('autolinks a bare url', () => {
    expect(markdownToHtml('go to https://x.example/a now')).toContain(
      '<a href="https://x.example/a">https://x.example/a</a>',
    );
  });

  it('groups consecutive bullets into one list', () => {
    const out = markdownToHtml('bring:\n- milk\n- bread\nthanks');

    expect(out).toContain('<ul><li>milk</li><li>bread</li></ul>');
    expect(out).toContain('bring:');
    expect(out).toContain('thanks');
  });

  it('renders a numbered list', () => {
    expect(markdownToHtml('1. first\n2. second')).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('keeps blank lines as breaks', () => {
    expect(markdownToHtml('one\n\ntwo')).toContain('<br>');
  });

  it('escapes inside a link text and a list item too', () => {
    expect(markdownToHtml('- a & b')).toContain('<li>a &amp; b</li>');
    expect(markdownToHtml('[a & b](https://x.example)')).toContain('a &amp; b');
  });

  it('copes with an empty body', () => {
    expect(markdownToHtml('')).toBe('<div><br></div>');
  });
});

describe('hasMarkdown', () => {
  it('is false for ordinary prose, asterisks included', () => {
    expect(hasMarkdown('hello there')).toBe(false);
    expect(hasMarkdown('2 * 3')).toBe(false);
  });

  it('is true for the things we actually render', () => {
    expect(hasMarkdown('a **b** c')).toBe(true);
    expect(hasMarkdown('- item')).toBe(true);
    expect(hasMarkdown('1. item')).toBe(true);
    expect(hasMarkdown('[a](https://x.example)')).toBe(true);
  });
});
