import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';

import { excelSerialToText, extractOfficeText, isDateNumberFormat, rtfToText } from '@/services/office-text.js';

function zip(parts: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [name, body] of Object.entries(parts)) z.addFile(name, Buffer.from(body, 'utf8'));
  return z.toBuffer();
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

describe('docx', () => {
  it('reads paragraphs, tabs, breaks and entities, and ignores deleted text', () => {
    const buf = zip({
      'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>
        <w:p><w:r><w:t>Field trip to the </w:t></w:r><w:r><w:t>aquarium</w:t></w:r></w:p>
        <w:p><w:r><w:t>Permission slip due</w:t><w:tab/><w:t>Fri Nov 14</w:t></w:r></w:p>
        <w:p><w:r><w:t>Cost: $12 &amp; lunch</w:t><w:br/><w:t>Bring a jacket</w:t></w:r></w:p>
        <w:p><w:r><w:delText>OLD DATE</w:delText></w:r></w:p>
      </w:body></w:document>`,
    });
    const text = extractOfficeText(buf, 'docx');
    expect(text).toContain('Field trip to the aquarium');
    expect(text).toContain('Permission slip due\tFri Nov 14');
    expect(text).toContain('Cost: $12 & lunch\nBring a jacket');
    expect(text).not.toContain('OLD DATE');
  });
});

describe('xlsx', () => {
  it('reads shared strings, numbers and dates from a date-styled cell, sheet by sheet', () => {
    const buf = zip({
      'xl/workbook.xml': `<workbook xmlns:r="r"><sheets><sheet name="Fall games" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/sharedStrings.xml': `<sst><si><t>Date</t></si><si><t>Opponent</t></si><si><r><t>Lions </t></r><r><t>FC</t></r></si></sst>`,
      'xl/styles.xml': `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="ddd, mmm d"/></numFmts>
        <cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>42</v></c></row>
        <row r="2"><c r="A2" s="1"><v>46340</v></c><c r="B2" t="s"><v>2</v></c><c r="D2" s="2"><v>46340.75</v></c></row>
      </sheetData></worksheet>`,
    });
    const text = extractOfficeText(buf, 'xlsx');
    expect(text).toContain('## Fall games');
    expect(text).toContain('Date\tOpponent\t42');
    // 46340 is 2026-11-14; the gap where C2 is empty is kept so columns line up.
    expect(text).toContain('2026-11-14\tLions FC\t\t2026-11-14 18:00');
  });

  it('tells date formats from number formats', () => {
    expect(isDateNumberFormat('ddd, mmm d')).toBe(true);
    expect(isDateNumberFormat('h:mm AM/PM')).toBe(true);
    expect(isDateNumberFormat('[$-409]d-mmm-yy;@')).toBe(true);
    expect(isDateNumberFormat('#,##0.00')).toBe(false);
    expect(isDateNumberFormat('"Due "0')).toBe(false);
    expect(isDateNumberFormat('General')).toBe(false);
  });

  it('turns serials into dates and times', () => {
    expect(excelSerialToText(46340)).toBe('2026-11-14');
    expect(excelSerialToText(0.5)).toBe('12:00');
    expect(excelSerialToText(0, true)).toBe('1904-01-01');
  });
});

describe('pptx', () => {
  it('reads slides in number order', () => {
    const buf = zip({
      'ppt/slides/slide10.xml': `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Last slide</a:t></a:r></a:p></p:sld>`,
      'ppt/slides/slide2.xml': `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Concert Dec 3 at 7pm</a:t></a:r></a:p></p:sld>`,
      'ppt/slides/slide1.xml': `<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Winter recital</a:t></a:r></a:p></p:sld>`,
    });
    const text = extractOfficeText(buf, 'pptx');
    expect(text.indexOf('Winter recital')).toBeLessThan(text.indexOf('Concert Dec 3 at 7pm'));
    expect(text.indexOf('Concert Dec 3 at 7pm')).toBeLessThan(text.indexOf('Last slide'));
  });
});

describe('OpenDocument', () => {
  it('reads an odt and an ods', () => {
    const odt = zip({
      'content.xml': `<office:document-content xmlns:text="t"><office:body><office:text>
        <text:h>Carpool</text:h><text:p>Monday<text:tab/>Priya drives</text:p></office:text></office:body></office:document-content>`,
    });
    expect(extractOfficeText(odt, 'odt')).toContain('Carpool\nMonday\tPriya drives');
    const ods = zip({
      'content.xml': `<office:document-content xmlns:table="tb" xmlns:text="t"><office:body><office:spreadsheet>
        <table:table table:name="Snacks"><table:table-row><table:table-cell><text:p>Sat</text:p></table:table-cell>
        <table:table-cell><text:p>Oranges</text:p></table:table-cell></table:table-row></table:table>
        </office:spreadsheet></office:body></office:document-content>`,
    });
    const text = extractOfficeText(ods, 'ods');
    expect(text).toContain('## Snacks');
    expect(text).toMatch(/Sat \tOranges/);
  });
});

describe('rtf', () => {
  it('keeps the text and drops fonts, colours and control words', () => {
    const rtf =
      "{\\rtf1\\ansi{\\fonttbl{\\f0 Helvetica;}}{\\colortbl;\\red0\\green0\\blue0;}" +
      "\\f0\\fs24 Dentist \\b Tuesday\\b0  at 3pm\\par Caf\\'e9 after\\par {\\*\\generator Word;}Bring \\u8364? 5}";
    const text = rtfToText(rtf);
    expect(text).toContain('Dentist Tuesday at 3pm');
    expect(text).toContain('Café after');
    expect(text).toContain('Bring € 5');
    expect(text).not.toMatch(/Helvetica|red0|Word;/);
  });
});

describe('safety', () => {
  it('refuses an archive whose parts would inflate past the cap', () => {
    const z = new AdmZip();
    // Compresses to almost nothing, inflates to 40 MB.
    z.addFile('word/document.xml', Buffer.alloc(40 * 1024 * 1024, 0x20));
    expect(() => extractOfficeText(z.toBuffer(), 'docx')).toThrow(/too large/);
  });

  it('throws on bytes that are not a zip', () => {
    expect(() => extractOfficeText(Buffer.from('<html>not a docx</html>'), 'docx')).toThrow();
  });

  it('returns nothing for an archive with no text parts', () => {
    expect(extractOfficeText(zip({ 'other.txt': 'x' }), 'docx')).toBe('');
  });

  /** Total characters of every string `Array#join` built while `fn` ran: the
   *  memory the extraction actually spent, which the 80k output slice hides. */
  function joinedChars(fn: () => void): number {
    const original = Array.prototype.join;
    let total = 0;
    Array.prototype.join = function (this: unknown[], sep?: string) {
      const s = original.call(this, sep);
      total += s.length;
      return s;
    };
    try {
      fn();
    } finally {
      Array.prototype.join = original;
    }
    return total;
  }

  function sharedStringBomb(stringLength: number, rows: number, cols: number): Buffer {
    const big = 'A'.repeat(stringLength);
    const cells = (r: number) =>
      Array.from({ length: cols }, (_, c) => `<c r="${String.fromCharCode(65 + c)}${r}" t="s"><v>0</v></c>`).join('');
    const sheetRows = Array.from({ length: rows }, (_, i) => `<row r="${i + 1}">${cells(i + 1)}</row>`).join('');
    return zip({
      'xl/sharedStrings.xml': `<sst><si><t>${big}</t></si></sst>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
    });
  }

  it('caps one cell of a shared-strings bomb instead of copying the whole string', () => {
    const text = extractOfficeText(sharedStringBomb(50_000, 1, 1), 'xlsx');
    expect(text.length).toBeLessThan(5_000);
  });

  it('stops reading a sheet once the output budget is spent', () => {
    // One 3k string referenced by 20,000 cells is 60M characters of rows if
    // every row is built; the caller only ever keeps 80k.
    const buf = sharedStringBomb(3_000, 2_000, 10);
    const spent = joinedChars(() => extractOfficeText(buf, 'xlsx'));
    expect(spent).toBeLessThan(2_000_000);
  });

  it('reads a long deck in linear time, not by re-joining every slide', () => {
    const parts: Record<string, string> = {};
    for (let i = 1; i <= 1_500; i++) {
      parts[`ppt/slides/slide${i}.xml`] = `<p:sld><a:p><a:r><a:t>s${i}</a:t></a:r></a:p></p:sld>`;
    }
    const buf = zip(parts);
    let text = '';
    const spent = joinedChars(() => {
      text = extractOfficeText(buf, 'pptx');
    });
    expect(text).toContain('--- Slide 1500 ---\ns1500');
    expect(spent).toBeLessThan(500_000);
  });
});
