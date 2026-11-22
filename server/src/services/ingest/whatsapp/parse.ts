export interface ParsedChatMessage {
  sentAt: Date;
  sender: string;
  body: string;
  hasAttachment: boolean;
  attachmentFilename: string | null;
}

const FORMAT1_RE =
  /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM|am|pm)?\]\s+(.*)/;

const FORMAT2_RE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?\s+-\s+(.*)/;

const SENDER_RE = /^(.+?): ([\s\S]*)/;
const ATTACHMENT_RE = /^(.+) \(file attached\)$/;
const ZERO_WIDTH_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

interface Pending {
  sentAt: Date;
  sender: string | null;
  body: string;
}

function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH_RE, '');
}

function normaliseHour(hour: number, ampm: string | undefined): number {
  if (!ampm) return hour;
  const ap = ampm.toUpperCase();
  if (ap === 'AM' && hour === 12) return 0;
  if (ap === 'PM' && hour !== 12) return hour + 12;
  return hour;
}

function fullYear(raw: number): number {
  return raw < 100 ? 2000 + raw : raw;
}

export function parseChat(content: string): ParsedChatMessage[] {
  const results: ParsedChatMessage[] = [];
  let pending: Pending | null = null;

  const commit = (): void => {
    if (!pending) return;
    if (pending.sender === null) {
      pending = null;
      return;
    }
    const body = pending.body.trim();
    let finalBody = body;
    let hasAttachment = false;
    let attachmentFilename: string | null = null;

    const attachMatch = ATTACHMENT_RE.exec(body);
    if (attachMatch) {
      hasAttachment = true;
      attachmentFilename = attachMatch[1];
    } else if (body === '<Media omitted>') {
      finalBody = '';
    }

    results.push({
      sentAt: pending.sentAt,
      sender: pending.sender,
      body: finalBody,
      hasAttachment,
      attachmentFilename,
    });
    pending = null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripZeroWidth(rawLine);

    const m1 = FORMAT1_RE.exec(line);
    if (m1) {
      commit();
      const [, dayStr, monStr, yearStr, hStr, minStr, secStr, ampm, rest] = m1;
      const sentAt = new Date(
        fullYear(parseInt(yearStr, 10)),
        parseInt(monStr, 10) - 1,
        parseInt(dayStr, 10),
        normaliseHour(parseInt(hStr, 10), ampm),
        parseInt(minStr, 10),
        parseInt(secStr, 10),
      );
      const sm = SENDER_RE.exec(rest);
      pending = { sentAt, sender: sm ? sm[1] : null, body: sm ? sm[2] : rest };
      continue;
    }

    const m2 = FORMAT2_RE.exec(line);
    if (m2) {
      commit();
      const [, monStr, dayStr, yearStr, hStr, minStr, secStr, ampm, rest] = m2;
      const sentAt = new Date(
        fullYear(parseInt(yearStr, 10)),
        parseInt(monStr, 10) - 1,
        parseInt(dayStr, 10),
        normaliseHour(parseInt(hStr, 10), ampm),
        parseInt(minStr, 10),
        secStr ? parseInt(secStr, 10) : 0,
      );
      const sm = SENDER_RE.exec(rest);
      pending = { sentAt, sender: sm ? sm[1] : null, body: sm ? sm[2] : rest };
      continue;
    }

    if (pending !== null) {
      pending.body += '\n' + line;
    }
  }

  commit();
  return results;
}
