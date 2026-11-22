/**
 * Domains written in letters that only LOOK Latin (ADR 0294 addendum).
 *
 * A domain like `xn--pple-43d.com` is shown by many mail apps as `аpple.com`,
 * with a Cyrillic а. To compare it with the domain it imitates we decode the
 * punycode (RFC 3492) and map each look-alike letter to the Latin letter it
 * imitates. The result is a "skeleton": two domains with the same skeleton
 * look the same to a reader. Digit and Latin swaps (0 for o, 1 for l) are
 * folded afterwards by `foldLookalikes`.
 *
 * Pure TS, no `node:url`/`punycode`: kernel runs in the app too.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;

function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digitOf(c: number): number {
  if (c >= 48 && c <= 57) return c - 22; // 0-9 → 26-35
  if (c >= 65 && c <= 90) return c - 65; // A-Z
  if (c >= 97 && c <= 122) return c - 97; // a-z
  return BASE;
}

/** Decode one punycode label (without `xn--`). Null when it is not valid. */
export function decodePunycode(input: string): string | null {
  const out: number[] = [];
  let n = 128;
  let i = 0;
  let bias = 72;
  const b = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(b, 0); j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    out.push(c);
  }
  for (let idx = b > 0 ? b + 1 : 0; idx < input.length; ) {
    const oldI = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= input.length) return null;
      const digit = digitOf(input.charCodeAt(idx++));
      if (digit >= BASE) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) return null;
    }
    bias = adapt(i - oldI, out.length + 1, oldI === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...out);
}

/** `xn--pple-43d.com` → `аpple.com` (the Unicode the reader would see). */
export function hostToUnicode(host: string): string {
  return host
    .split('.')
    .map((l) => (l.startsWith('xn--') ? (decodePunycode(l.slice(4)) ?? l) : l))
    .join('.');
}

/**
 * Letters from other alphabets that are drawn like a Latin letter, mapped to
 * it. Lower case only: domains are case-insensitive and lowered first.
 */
const LOOKS_LATIN: Record<string, string> = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'һ': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k',
  'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's',
  'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ь': 'b', 'ɡ': 'g', 'ӏ': 'l',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w', 'ϲ': 'c',
  // Latin extensions and symbols
  'ı': 'i', 'ȷ': 'j', 'ɑ': 'a', 'ɩ': 'i', 'ʟ': 'l', 'ℓ': 'l', 'ꞵ': 'b', 'ɒ': 'a', 'ø': 'o',
  'đ': 'd', 'ħ': 'h', 'ł': 'l', 'ŧ': 't',
};

/**
 * What a label looks like to a reader, in plain Latin letters. NFKC first
 * (full-width ｐａｙｐａｌ, ligatures), then accents dropped (é → e), then
 * the look-alike map. Digit swaps are left for `foldLookalikes`.
 */
export function latinSkeleton(label: string): string {
  const unicode = label.startsWith('xn--') ? (decodePunycode(label.slice(4)) ?? label) : label;
  const plain = unicode
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    // Every combining mark and every character that draws nothing: "C<VS>o<VS>i…"
    // with an invisible variation selector between letters reads "Coi…".
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '');
  let out = '';
  for (const ch of plain) out += LOOKS_LATIN[ch] ?? ch;
  return out;
}

/** True when a label uses any letter that is not plain ASCII. */
export function hasNonAscii(label: string): boolean {
  return /[^ -~]/.test(label) || label.startsWith('xn--');
}
