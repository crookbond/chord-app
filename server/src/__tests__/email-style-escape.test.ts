import { describe, expect, it } from 'vitest';
import { stripEscapingCss } from '@chord/kernel';

describe('stripEscapingCss', () => {
  it('drops a fixed overlay and its z-index, keeping the rest', () => {
    const out = stripEscapingCss('position:fixed;inset:0;z-index:99999;color:red');

    expect(out).not.toMatch(/fixed/i);
    expect(out).not.toMatch(/z-index/i);
    expect(out).toContain('color:red');
  });

  it('drops sticky, and catches spacing, case and !important', () => {
    expect(stripEscapingCss('POSITION : Sticky !important; top:0')).not.toMatch(/sticky/i);
    expect(stripEscapingCss('Z-INDEX : 2147483647')).toBe('');
  });

  it('sees through CSS escapes and comments', () => {
    expect(stripEscapingCss('p\\osition:fixed;top:0')).not.toMatch(/fixed/i);
    expect(stripEscapingCss('position:/**/fixed')).not.toMatch(/fixed/i);
    expect(stripEscapingCss('position:fi\\78 ed')).not.toMatch(/fixed/i);
  });

  it('keeps absolute and relative positioning, which the reader box contains', () => {
    expect(stripEscapingCss('position:absolute;left:0')).toContain('position:absolute');
    expect(stripEscapingCss('position:relative')).toContain('position:relative');
  });

  it('leaves an ordinary style alone', () => {
    expect(stripEscapingCss('color:#333;font-size:14px')).toBe('color:#333;font-size:14px');
    expect(stripEscapingCss(undefined)).toBe('');
  });
});
