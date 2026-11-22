/**
 * ADR 0288 — the "based on:" row names only files a file tool used this turn.
 *
 * The prod case (owner's personal chat, 2026-10-22): a restaurant answer drawn
 * from saved places was footed "based on" four legal PDFs, because a query
 * word was a substring of each file's summary and a summary word ("options",
 * "link") was a substring of the reply.
 */
import { describe, expect, it } from 'vitest';

import { citedFiles } from '@/services/bot/file-citations.js';
import type { AttachmentWithExcerpts } from '@/services/bot/retrieval.js';

const GROUP = 'g_personal';

function file(
  id: string,
  filename: string,
  summary: string,
  excerpts: string[],
  extra: Partial<AttachmentWithExcerpts> = {},
): AttachmentWithExcerpts {
  return {
    id,
    filename,
    summary,
    extractedText: null,
    indexedAt: '2026-09-01T00:00:00.000Z',
    pinned: 0,
    created_at: '2026-09-01T00:00:00.000Z',
    owningGroupId: GROUP,
    blobMissing: false,
    excerpts: excerpts.map((snippet, chunkIdx) => ({ chunkIdx, kind: 'text' as const, snippet })),
    ...extra,
  };
}

// The four files the prod footer named, with the kind of text such contracts carry.
const PROD_FILES = [
  file(
    'a_insurance',
    '316 West 84th Street Corp - 26-27 Insurance Proposal - All Lines.pdf',
    'Insurance proposal for the 2026-27 policy year with coverage options, premiums by line and a link to bind coverage; quotes dated Friday.',
    [
      '…coverage «options» for each line; the effective «date» is 12:01 AM on the renewal «date»…',
      '…binding instructions must be received by «Friday»; follow the «link» in the cover email…',
    ],
  ),
  file(
    'a_redline',
    'Change-Pro Redline - Project Street - LSD Side Letter.pdf',
    'Redline of the side letter comparing draft dates, with the parties’ options to extend and more changes to closing.',
    ['…the closing «date» shall be no later than «Friday», the extension «options» set out below…'],
  ),
  file(
    'a_alteration',
    'Alteration Agreement_Berkowitz Signed.pdf',
    'Signed alteration agreement; work hours, completion date and the board’s options on default.',
    ['…work may be performed Monday through «Friday» only; the completion «date» is binding…'],
  ),
  file(
    'a_john',
    'John Doe.pdf',
    'Personal document for John Doe listing dates, options and contact details.',
    ['…as of the «date» below… more «options» are listed on the following page…'],
  ),
];

describe('citedFiles', () => {
  // Asked: "@Chord can you suggest a restaurant for Friday? Date night with Alice";
  // replied with two restaurants and "Would you like a reservation link or more options?"
  it('names none of the four legal PDFs under the prod restaurant answer', () => {
    const cited = citedFiles({
      attachments: PROD_FILES,
      groupId: GROUP,
      usedFileIds: new Set(),
    });
    expect(cited.map((a) => a.filename)).toEqual([]);
  });

  // The prod case (owner's personal chat, 2026-10-25): a /plan reply built from
  // the calendar and list_tasks was footed "based on: SQ008517.pdf ·
  // SQ008238.pdf" (NYAC statements). The to-do's own words also sat in the
  // injected statement text, so the phrase rule read the reply as a quote. The
  // reply text no longer reaches citedFiles; the end-to-end version of this case
  // is in file-citations.integration.test.ts.
  it('names no file under a plan-my-day reply that repeats a to-do also in a PDF', () => {
    const statements = [
      file('a_sq008517', 'SQ008517.pdf', 'New York Athletic Club monthly statement.', [
        '…please arrange for paying the «New York Athletic Club balance» by Saturday to avoid a late charge…',
      ]),
      file('a_sq008238', 'SQ008238.pdf', 'New York Athletic Club statement.', [], {
        extractedText: 'Member statement. Paying the New York Athletic Club balance by Saturday keeps the account current.',
      }),
    ];
    const cited = citedFiles({
      attachments: statements,
      groupId: GROUP,
      // asked: '/plan'; replied: '… To-do: paying the New York Athletic Club balance by Saturday …'
      usedFileIds: new Set(),
    });
    expect(cited.map((a) => a.filename)).toEqual([]);
  });

  it('names no file the reply merely quotes when no file tool used it', () => {
    const cited = citedFiles({
      attachments: PROD_FILES,
      groupId: GROUP,
      // asked: '@Chord when can the contractor work under the alteration agreement?'
      // replied: 'Per the alteration agreement, work may be performed Monday through Friday only.'
      usedFileIds: new Set(),
    });
    expect(cited).toEqual([]);
  });

  it('names a file a file tool used, even when the reply paraphrases it', () => {
    const cited = citedFiles({
      attachments: PROD_FILES,
      groupId: GROUP,
      // asked: 'send me the insurance proposal'
      usedFileIds: new Set(['a_insurance']),
    });
    expect(cited.map((a) => a.id)).toEqual(['a_insurance']);
  });

  it('never names a file owned by another group, even one a tool used', () => {
    const other = file('a_other', 'Other group plan.pdf', 'Plan.', ['…the trip leaves on Monday morning at nine sharp…'], {
      owningGroupId: 'g_other',
    });
    const cited = citedFiles({
      attachments: [other],
      groupId: GROUP,
      // asked: 'when does the trip leave?'
      usedFileIds: new Set(['a_other']),
    });
    expect(cited).toEqual([]);
  });
});
