import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// react-native-webview draws its outer box as `flex: 1`, which sizes it from 0
// in a parent with no height of its own, so `style={{ height }}` on the
// WebView itself is ignored on a phone. The rich reply box (ADR 0339) and the
// rich signature editor (ADR 0260) both rendered 0pt tall on iPhone that way.
// A WebView that needs a height gets it from a wrapping View.

const MOBILE = join(__dirname, '../../../mobile');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : [];
  });
}

/** Each `<WebView ... />` element's own props, as written. */
function webViewElements(src: string): string[] {
  // `<WebView` followed by whitespace: a tag, not `useRef<WebView>`.
  const out: string[] = [];
  for (const m of src.matchAll(/<WebView\s/g)) {
    const end = src.indexOf('/>', m.index);
    out.push(src.slice(m.index, end < 0 ? undefined : end));
  }
  return out;
}

describe('a WebView never carries its own height', () => {
  it('sizes every phone WebView through a wrapper', () => {
    const offenders: string[] = [];
    for (const f of [...files(join(MOBILE, 'src')), ...files(join(MOBILE, 'app'))]) {
      for (const el of webViewElements(readFileSync(f, 'utf8'))) {
        if (/style=\{\{[^}]*\bheight\b/.test(el)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
