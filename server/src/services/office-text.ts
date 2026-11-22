/**
 * Plain text out of Office and OpenDocument files (ADR 0310), so a Word,
 * Excel or PowerPoint attachment is indexed, searchable and read for action
 * cards the way a PDF already is. These formats are zip archives of XML: the
 * text is read from the parts that hold it, nothing is run or rendered.
 *
 * Old binary Office files (.doc/.xls/.ppt) are not read here.
 */
import AdmZip from 'adm-zip';
import { Parser } from 'htmlparser2';

import type { FileFormat } from '@chord/kernel';

export type OfficeTextFormat = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'rtf';

export const OFFICE_TEXT_FORMATS: ReadonlySet<FileFormat> = new Set<FileFormat>([
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
]);

/** Enough for the 40k characters the caller keeps, with room for markup. */
const MAX_OUTPUT_CHARS = 80_000;
const MAX_ENTRIES = 5_000;
const MAX_PART_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_SHEET_COLS = 60;
/** One cell's text. A shared string is stored once and referenced by any
 *  number of cells, so without a cap one large string becomes gigabytes. */
const MAX_CELL_CHARS = 2_000;

/** Thrown from inside a parser callback once the output budget is spent, so
 *  the rest of the part is never read. */
class BudgetSpent extends Error {}

/** The text being built, refusing more than MAX_OUTPUT_CHARS. The budget is
 *  checked as each piece arrives, not after a whole part or sheet, because a
 *  part's text can be many times its compressed (and capped) size. */
class Out {
  private readonly parts: string[] = [];
  private length = 0;

  add(s: string): void {
    if (!s) return;
    const room = MAX_OUTPUT_CHARS - this.length;
    if (room <= 0) throw new BudgetSpent();
    const piece = s.length > room ? s.slice(0, room) : s;
    this.parts.push(piece);
    this.length += piece.length;
    if (this.length >= MAX_OUTPUT_CHARS) throw new BudgetSpent();
  }

  text(): string {
    return this.parts.join('');
  }
}

/** Runs `fill` and returns what it wrote, stopping quietly at the budget. */
function collect(fill: (out: Out) => void): string {
  const out = new Out();
  try {
    fill(out);
  } catch (err) {
    if (!(err instanceof BudgetSpent)) throw err;
  }
  return out.text();
}

class Archive {
  private readonly zip: AdmZip;
  private read = 0;

  constructor(buf: Buffer) {
    this.zip = new AdmZip(buf);
    if (this.zip.getEntries().length > MAX_ENTRIES) throw new Error('too many entries');
  }

  names(): string[] {
    return this.zip.getEntries().map((e) => e.entryName);
  }

  /** One part's text, or null when it is absent. Refuses a part (or a running
   *  total) that would inflate past the caps, so a zip bomb costs nothing. */
  text(name: string): string | null {
    const entry = this.zip.getEntry(name);
    if (!entry || entry.isDirectory) return null;
    const size = entry.header.size;
    if (size > MAX_PART_BYTES || this.read + size > MAX_TOTAL_BYTES) throw new Error('part too large');
    const data = entry.getData();
    this.read += data.length;
    if (this.read > MAX_TOTAL_BYTES) throw new Error('archive too large');
    return data.toString('utf8');
  }
}

/** Streams an XML part. `onOpen`/`onClose` see the qualified tag name. */
function walkXml(
  xml: string,
  handlers: {
    onOpen?: (name: string, attrs: Record<string, string>) => void;
    onText?: (text: string) => void;
    onClose?: (name: string) => void;
  },
): void {
  const parser = new Parser(
    {
      onopentag: (name, attrs) => handlers.onOpen?.(name, attrs),
      ontext: (text) => handlers.onText?.(text),
      onclosetag: (name) => handlers.onClose?.(name),
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_OUTPUT_CHARS);
}

function wordText(xml: string, out: Out): void {
  let inText = false;
  walkXml(xml, {
    onOpen: (name) => {
      if (name === 'w:t') inText = true;
      else if (name === 'w:tab') out.add('\t');
      else if (name === 'w:br' || name === 'w:cr') out.add('\n');
    },
    onText: (t) => {
      if (inText) out.add(t);
    },
    onClose: (name) => {
      if (name === 'w:t') inText = false;
      else if (name === 'w:p') out.add('\n');
      else if (name === 'w:tc') out.add('\t');
    },
  });
}

function docxText(zip: Archive): string {
  return collect((out) => {
    let first = true;
    for (const part of ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']) {
      const xml = zip.text(part);
      if (!xml) continue;
      if (!first) out.add('\n');
      first = false;
      wordText(xml, out);
    }
  });
}

function byTrailingNumber(a: string, b: string): number {
  const n = (s: string) => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0);
  return n(a) - n(b);
}

function pptxText(zip: Archive): string {
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(byTrailingNumber);
  return collect((out) => {
    let first = true;
    for (const [i, name] of slides.entries()) {
      const xml = zip.text(name);
      if (!xml) continue;
      out.add(`${first ? '' : '\n'}--- Slide ${i + 1} ---\n`);
      first = false;
      let inText = false;
      walkXml(xml, {
        onOpen: (n) => {
          if (n === 'a:t') inText = true;
          else if (n === 'a:br') out.add('\n');
        },
        onText: (t) => {
          if (inText) out.add(t);
        },
        onClose: (n) => {
          if (n === 'a:t') inText = false;
          else if (n === 'a:p') out.add('\n');
        },
      });
    }
  });
}

function openDocumentText(zip: Archive): string {
  const xml = zip.text('content.xml');
  if (!xml) return '';
  let cellDepth = 0;
  let paraDepth = 0;
  return collect((out) =>
    walkXml(xml, {
      onOpen: (name, attrs) => {
        if (name === 'text:p' || name === 'text:h') paraDepth++;
        else if (name === 'text:tab') out.add('\t');
        else if (name === 'text:line-break') out.add('\n');
        else if (name === 'text:s') out.add(' ');
        else if (name === 'table:table-cell') cellDepth++;
        else if (name === 'table:table' && attrs['table:name']) out.add(`\n## ${attrs['table:name']}\n`);
        else if (name === 'draw:page' && attrs['draw:name']) out.add(`\n--- ${attrs['draw:name']} ---\n`);
      },
      onText: (t) => {
        // Only paragraph text: the whitespace between elements is layout.
        if (paraDepth > 0) out.add(t);
      },
      onClose: (name) => {
        if (name === 'text:p' || name === 'text:h') {
          paraDepth--;
          out.add(cellDepth > 0 ? ' ' : '\n');
        } else if (name === 'table:table-cell') {
          cellDepth--;
          out.add('\t');
        } else if (name === 'table:table-row') out.add('\n');
      },
    }),
  );
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54,
  55, 56, 57, 58,
]);

/** Whether a number format shows a date or time (`d-mmm-yy`, `h:mm`). */
export function isDateNumberFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/_.|\*./g, '');
  if (/general/i.test(bare)) return false;
  return /[dmyhs]/i.test(bare);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** An Excel date serial as text: a date, a date and time, or a time. */
export function excelSerialToText(serial: number, date1904 = false): string {
  const days = Math.floor(serial);
  const seconds = Math.round((serial - days) * 86_400);
  const hhmm = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}`;
  if (days === 0 && !date1904) return hhmm;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + days * 86_400_000);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return seconds ? `${ymd} ${hhmm}` : ymd;
}

function columnIndex(ref: string | undefined): number | null {
  const letters = /^([A-Z]+)/.exec(ref ?? '')?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxText(zip: Archive): string {
  const shared: string[] = [];
  const sst = zip.text('xl/sharedStrings.xml');
  if (sst) {
    let cur: string | null = null;
    let inT = false;
    let inPhonetic = false;
    walkXml(sst, {
      onOpen: (n) => {
        if (n === 'si') cur = '';
        else if (n === 't') inT = true;
        else if (n === 'rPh') inPhonetic = true;
      },
      onText: (t) => {
        if (inT && !inPhonetic && cur !== null) cur += t;
      },
      onClose: (n) => {
        if (n === 't') inT = false;
        else if (n === 'rPh') inPhonetic = false;
        else if (n === 'si') {
          shared.push((cur ?? '').slice(0, MAX_CELL_CHARS));
          cur = null;
        }
      },
    });
  }

  const dateStyles = new Set<number>();
  const styles = zip.text('xl/styles.xml');
  if (styles) {
    const custom = new Map<number, string>();
    let xfIndex = -1;
    let inCellXfs = false;
    const xfFormats: number[] = [];
    walkXml(styles, {
      onOpen: (n, a) => {
        if (n === 'numFmt') custom.set(Number(a['numFmtId']), a['formatCode'] ?? '');
        else if (n === 'cellXfs') inCellXfs = true;
        else if (n === 'xf' && inCellXfs) {
          xfIndex++;
          xfFormats[xfIndex] = Number(a['numFmtId'] ?? 0);
        }
      },
      onClose: (n) => {
        if (n === 'cellXfs') inCellXfs = false;
      },
    });
    xfFormats.forEach((id, i) => {
      const code = custom.get(id);
      if (code !== undefined ? isDateNumberFormat(code) : BUILTIN_DATE_FORMATS.has(id)) dateStyles.add(i);
    });
  }

  const sheets: { name: string; target: string }[] = [];
  let date1904 = false;
  const workbook = zip.text('xl/workbook.xml');
  const rels = new Map<string, string>();
  const relsXml = zip.text('xl/_rels/workbook.xml.rels');
  if (relsXml) {
    walkXml(relsXml, {
      onOpen: (n, a) => {
        if (n === 'Relationship' && a['Id'] && a['Target']) rels.set(a['Id'], a['Target']);
      },
    });
  }
  if (workbook) {
    walkXml(workbook, {
      onOpen: (n, a) => {
        if (n === 'workbookPr' && /^(1|true)$/.test(a['date1904'] ?? '')) date1904 = true;
        if (n === 'sheet') {
          const target = rels.get(a['r:id'] ?? '');
          if (target) {
            const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
            sheets.push({ name: a['name'] ?? `Sheet ${sheets.length + 1}`, target: path });
          }
        }
      },
    });
  }
  if (!sheets.length) {
    for (const n of zip.names().filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x)).sort(byTrailingNumber)) {
      sheets.push({ name: `Sheet ${sheets.length + 1}`, target: n });
    }
  }

  return collect((out) => {
    let first = true;
    for (const sheet of sheets) {
      const xml = zip.text(sheet.target);
      if (!xml) continue;
      out.add(`${first ? '' : '\n\n'}## ${sheet.name}`);
      first = false;
      readSheet(xml, out);
    }
  });

  function readSheet(xml: string, out: Out): void {
    let row: string[] = [];
    let cell: { col: number | null; type: string; style: number } | null = null;
    let value = '';
    let inValue = false;
    let nextCol = 0;
    walkXml(xml, {
      onOpen: (n, a) => {
        if (n === 'row') {
          row = [];
          nextCol = 0;
        } else if (n === 'c') {
          cell = { col: columnIndex(a['r']), type: a['t'] ?? 'n', style: Number(a['s'] ?? 0) };
          value = '';
        } else if (cell && (n === 'v' || n === 't')) inValue = true;
      },
      onText: (t) => {
        if (inValue) value += t;
      },
      onClose: (n) => {
        if (n === 'v' || n === 't') inValue = false;
        else if (n === 'c' && cell) {
          let text = value;
          if (cell.type === 's') text = shared[Number(value)] ?? '';
          else if (cell.type === 'b') text = value === '1' ? 'TRUE' : 'FALSE';
          else if (cell.type === 'n' && value !== '' && dateStyles.has(cell.style)) {
            const num = Number(value);
            if (Number.isFinite(num)) text = excelSerialToText(num, date1904);
          }
          const col = cell.col ?? nextCol;
          if (col < MAX_SHEET_COLS && text !== '') row[col] = text.slice(0, MAX_CELL_CHARS).replace(/[\t\r\n]+/g, ' ');
          nextCol = col + 1;
          cell = null;
        } else if (n === 'row') {
          if (row.some((v) => v)) out.add(`\n${Array.from(row, (v) => v ?? '').join('\t')}`);
        }
      },
    });
  }
}

const CP1252: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰',
  0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/** The visible text of an RTF document: control words dropped, destination
 *  groups (`{\*...}`, fonts, colours, pictures) skipped. */
export function rtfToText(rtf: string): string {
  const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'object', 'themedata', 'datastore', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl']);
  let out = '';
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false;
  let uc = 1;
  let pendingSkip = 0;
  let i = 0;
  const emit = (s: string) => {
    if (pendingSkip > 0) {
      const drop = Math.min(pendingSkip, s.length);
      pendingSkip -= drop;
      s = s.slice(drop);
    }
    if (!skip) out += s;
  };
  while (i < rtf.length) {
    const ch = rtf[i]!;
    if (ch === '{') {
      stack.push({ skip, uc });
      i++;
    } else if (ch === '}') {
      const prev = stack.pop();
      if (prev) ({ skip, uc } = prev);
      i++;
    } else if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === undefined) break;
      if (next === '*') {
        skip = true;
        i += 2;
      } else if (next === "'") {
        const code = parseInt(rtf.slice(i + 2, i + 4), 16);
        if (Number.isFinite(code)) emit(CP1252[code] ?? String.fromCharCode(code));
        i += 4;
      } else if (/[a-z]/i.test(next)) {
        const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i, i + 40));
        const word = m?.[1] ?? '';
        const arg = m?.[2];
        i += m?.[0].length ?? 2;
        if (SKIP.has(word)) skip = true;
        else if (word === 'par' || word === 'line' || word === 'row') emit('\n');
        else if (word === 'tab' || word === 'cell') emit('\t');
        else if (word === 'uc' && arg !== undefined) uc = Number(arg);
        else if (word === 'u' && arg !== undefined) {
          let code = Number(arg);
          if (code < 0) code += 65_536;
          emit(String.fromCharCode(code));
          pendingSkip = uc;
        }
      } else {
        // Escaped literal: \\ \{ \} and \~ (non-breaking space).
        emit(next === '~' ? ' ' : next === '\n' || next === '\r' ? '\n' : next);
        i += 2;
      }
    } else {
      if (ch !== '\r' && ch !== '\n') emit(ch);
      i++;
    }
    if (out.length > MAX_OUTPUT_CHARS) break;
  }
  return out;
}

/** The text of an Office/OpenDocument/RTF file; '' when there is none. Throws
 *  on a damaged or oversized archive (the caller logs and moves on). */
export function extractOfficeText(buf: Buffer, format: OfficeTextFormat): string {
  if (format === 'rtf') return tidy(rtfToText(buf.toString('latin1')));
  const zip = new Archive(buf);
  switch (format) {
    case 'docx':
      return tidy(docxText(zip));
    case 'xlsx':
      return tidy(xlsxText(zip));
    case 'pptx':
      return tidy(pptxText(zip));
    case 'odt':
    case 'ods':
    case 'odp':
      return tidy(openDocumentText(zip));
  }
}
