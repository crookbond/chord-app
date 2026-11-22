/**
 * HTML character references, decoded.
 *
 * Mail is full of them: Gmail's API hands back every snippet HTML-escaped
 * (`haven&#39;t`), and an HTML body spells its punctuation as `&rsquo;`,
 * `&ndash;`, `&#x2019;`. Text taken from either without decoding shows the
 * reference on screen, hands it to the model, and indexes it for search.
 *
 * One pass over the string, so `&amp;lt;` becomes `&lt;` and stops there - a
 * second pass would turn text someone wrote about markup into markup.
 * Anything unrecognised is left exactly as it was.
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  copy: '©', reg: '®', trade: '™', deg: '°', sect: '§', para: '¶',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  times: '×', divide: '÷', plusmn: '±', minus: '−', frac12: '½',
  frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  iexcl: '¡', iquest: '¿', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', shy: '­', dagger: '†', Dagger: '‡',
  prime: '′', Prime: '″', hearts: '♥', check: '✓',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š',
};

const REFERENCE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,10});/g;

function fromCodePoint(cp: number, original: string): string {
  // Out of range, a surrogate half, or NUL: not a character anyone meant.
  if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return original;
  }
  return String.fromCodePoint(cp);
}

export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      return fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10), whole);
    }
    return NAMED[body] ?? whole;
  });
}
