/**
 * Mail filters nobody asked for are dropped (ADR 0279, the ADR 0229 rule
 * applied to search).
 *
 * Asked "show me emails from mallory", prod's model called search with every
 * optional filter filled in: emailKind "delivery", a six-week date window,
 * all four email actions, hasAttachment false and to "". The kind alone
 * limited the search to parcel mail, so a correspondent with plenty of mail
 * came back with none and the bot told the user there was nothing from him.
 *
 * A filter is kept only when the user's own recent words could have asked for
 * it. With nothing to read (no triggering message) every filter is taken as
 * given.
 */
import type { EmailAction } from '@chord/kernel';

export interface MailFilterArgs {
  from?: string;
  to?: string;
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  emailAction?: EmailAction[];
  emailKind?: 'receipt' | 'delivery' | 'flight' | 'invite';
}

const words = (list: string) => new RegExp(`\\b(?:${list})\\b`, 'i');

const KIND_WORDS: Record<NonNullable<MailFilterArgs['emailKind']>, RegExp> = {
  receipt: words('receipts?|orders?|ordered|purchases?|purchased|bought|paid|payments?|invoices?|charged?|charges|spent|spend|spending|refunds?'),
  delivery: words('deliver(?:y|ies|ed|ing)?|packages?|parcels?|shipping|shipped|shipments?|tracking|track|arriv(?:e|es|ed|ing|al)'),
  flight: words('flights?|fly|flying|flew|planes?|airlines?|boarding|itinerar(?:y|ies)'),
  invite: words('invites?|invited|invitations?|rsvps?|meetings?|events?|calendar'),
};

const ATTACHMENT_WORDS = words(
  'attach(?:ed|ment|ments)?|files?|pdfs?|docs?|documents?|photos?|pictures?|images?|scans?|scanned|spreadsheets?|forms?',
);

const ACTION_WORDS = words(
  'reply|replies|replied|respond|response|answer|answered|to-?dos?|to do|actions?|needs?|waiting|owe|pending|follow(?:-| )?up|fyi|informational',
);

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAYS = 'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const DATE_WORDS = new RegExp(
  `\\b(?:${MONTHS}|${WEEKDAYS}|today|tonight|yesterday|tomorrow|days?|weeks?|weekends?|months?|years?|ago|since|before|after|until|between|spring|summer|fall|autumn|winter|christmas|thanksgiving)\\b` +
    '|\\b\\d{4}\\b|\\b\\d{1,2}[/-]\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)\\b',
  'i',
);

const ALL_ACTIONS = 4;

export interface GuardedFilters {
  args: MailFilterArgs;
  /** Names of the filters dropped, for the log. */
  dropped: string[];
}

/**
 * `userText` is the user's own recent messages, or null when there is no
 * message to read. Empty strings are always "not set".
 */
export function dropUnaskedMailFilters(args: MailFilterArgs, userText: string[] | null): GuardedFilters {
  const out: MailFilterArgs = { ...args };
  const dropped: string[] = [];
  const drop = (key: keyof MailFilterArgs) => {
    if (out[key] !== undefined) dropped.push(key);
    delete out[key];
  };
  if (typeof out.from === 'string' && !out.from.trim()) drop('from');
  if (typeof out.to === 'string' && !out.to.trim()) drop('to');
  if (out.hasAttachment === false) drop('hasAttachment');
  // Every action at once filters nothing in, and leaves out mail not yet sorted.
  if (out.emailAction && (out.emailAction.length === 0 || new Set(out.emailAction).size >= ALL_ACTIONS)) drop('emailAction');
  if (!userText) return { args: out, dropped };

  const said = (re: RegExp) => userText.some((t) => re.test(t));
  if (out.emailKind && !said(KIND_WORDS[out.emailKind])) drop('emailKind');
  if (out.hasAttachment && !said(ATTACHMENT_WORDS)) drop('hasAttachment');
  if (out.emailAction && !said(ACTION_WORDS)) drop('emailAction');
  if ((out.after || out.before) && !said(DATE_WORDS)) {
    drop('after');
    drop('before');
  }
  return { args: out, dropped };
}
