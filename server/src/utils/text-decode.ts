/**
 * Bytes to text, without assuming they are UTF-8.
 *
 * Almost everything is UTF-8, and `buf.toString('utf8')` never fails - it
 * swaps what it cannot read for U+FFFD and carries on, so a Notepad "Unicode"
 * file or a Latin-1 mail body is stored as garbage with nothing logged.
 *
 * Order matters. A byte-order mark is a statement by the writer and wins.
 * Then UTF-8 is tried STRICTLY, ahead of any declared charset: valid UTF-8 is
 * very unlikely to be anything else, and a provider may already have converted
 * the bytes while leaving the original label on the part. Only bytes that are
 * not UTF-8 fall to the declared charset, then to Windows-1252, the usual
 * answer for undeclared Western text.
 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * What bytes 0x80-0x9F mean in Windows-1252, as code points, indexed from
 * 0x80. Zero marks the five bytes the encoding leaves undefined.
 */
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

/**
 * Finish a Windows-1252 decode that stopped at Latin-1.
 *
 * Node 20's `TextDecoder('windows-1252')` (and `iso-8859-1` / `latin1`, which
 * the standard maps to it) decodes bytes 0x80-0x9F to the C1 control
 * characters of the same number, where Windows-1252 has curly quotes, dashes
 * and the euro sign. Node 24 gets it right. The control characters are
 * invisible, so the text looks intact with its punctuation missing.
 *
 * A correct decode never produces U+0080-U+009F from these labels, so mapping
 * them afterwards changes nothing where the decoder already worked.
 */
export function repairWindows1252(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80 || code > 0x9f) continue;
    const mapped = CP1252_HIGH[code - 0x80];
    if (!mapped) continue;
    out += text.slice(from, i) + String.fromCharCode(mapped);
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

function tryDecode(label: string, buf: Buffer): string | null {
  try {
    const decoder = new TextDecoder(label);
    const text = decoder.decode(buf);
    return decoder.encoding === 'windows-1252' ? repairWindows1252(text) : text;
  } catch {
    // An unknown label, or a Node build without that converter.
    return null;
  }
}

/** The `charset` parameter of a Content-Type value, lowercased, or null. */
export function charsetOf(contentType: string | null | undefined): string | null {
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

export function decodeText(buf: Buffer, declaredCharset?: string | null): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return tryDecode('utf-16le', buf.subarray(2)) ?? buf.toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return tryDecode('utf-16be', buf.subarray(2)) ?? buf.toString('utf8');
  }
  try {
    return strictUtf8.decode(buf);
  } catch {
    // Not UTF-8; fall through.
  }
  const declared = declaredCharset?.trim().toLowerCase();
  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    const out = tryDecode(declared, buf);
    if (out !== null) return out;
  }
  return tryDecode('windows-1252', buf) ?? buf.toString('utf8');
}
