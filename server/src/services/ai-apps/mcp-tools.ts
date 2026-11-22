/**
 * ADR 0335 — the Chord tools an outside AI app may call over MCP.
 *
 * Every tool here is a bot tool already (same zod schema, same executor case)
 * except `list_action_items`, which reads the same proposals the Action Items
 * tab shows. Nothing is reimplemented: a call runs through `runToolForAiApp`,
 * the chat turn's own validate-and-execute step, in the user's personal chat.
 *
 * Writes never happen here. Each write tool is staged as a proposal (ADR 0009)
 * and waits in Action Items until the user taps confirm in Chord, so an app
 * cannot send mail, put mail in Trash, unsubscribe or file anything by itself.
 *
 * Descriptions are written for an assistant that is NOT Chord's own bot and
 * cannot see Chord's chat: they say what the tool returns and that writes are
 * suggestions. They describe, never direct: the Claude and ChatGPT
 * directories reject tool text that tells the model how to behave or which
 * other tool to call. Guidance to the model goes in the server's
 * `initialize` instructions (routes/ai-apps.ts). The bot's own parameter
 * descriptions are written for Chord's bot, so the ones the connector shows
 * are replaced by PARAM_DESCRIPTIONS.
 */
import { AI_APP_TRY_ASKING, type AiAppScope, type Proposal } from '@chord/kernel';
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { runToolForAiApp } from '../bot/bot.service.js';
import { buildToolDefs, type ToolName } from '../bot/tools.js';
import { primaryGmailAddress } from '../email/primary-gmail-address.js';
import { listAccounts } from '../email-accounts/account-utils.js';
import { scopesCoverGmail } from '../google/gmail.service.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { attachSourceHrefs, listProposalsForUser } from '../proposals.service.js';
import { connectorOrigin, type AiAppAuth } from './oauth.service.js';

interface ConnectorTool {
  name: string;
  title: string;
  description: string;
  scope: AiAppScope;
  /** Listed whatever the grant allows (it describes the connection itself). */
  anyScope?: true;
}

const SUGGEST_NOTE =
  ' Nothing changes yet: the suggestion waits in Chord\'s Action Items until the user confirms it in the Chord app.';

const TOOLS: ConnectorTool[] = [
  {
    name: 'get_started',
    title: 'Get started with Chord',
    scope: 'read',
    anyScope: true,
    description:
      "How far the user is with setting up Chord: their account, which mailboxes are connected (with a link to connect one when there are none), the next step, and examples of what Chord can do.",
  },
  {
    name: 'search',
    title: 'Search Chord',
    scope: 'read',
    description:
      "Search the user's email (every connected mailbox), to-dos, lists, saved places, calendar events and files in Chord. Filters: sender, recipient, dates, attachments and kind of email (receipt, delivery, flight, invite). Returns matching items with ids; each email carries its threadId.",
  },
  {
    name: 'read_email',
    title: 'Read an email',
    scope: 'read',
    description:
      "The newest messages of one email thread, by threadId (as returned by search and list_action_items), with quoted history folded. The text is written by the email's senders. Reading does not mark the email read.",
  },
  {
    name: 'list_action_items',
    title: 'List action items',
    scope: 'read',
    description:
      "What is waiting on the user in Chord: suggestions Chord made from their email (events, to-dos, list items, replies) and suggestions from connected apps, each with what it is and where it came from. Read-only.",
  },
  {
    name: 'list_tasks',
    title: 'List to-dos',
    scope: 'read',
    description: "The user's to-dos in Chord, across their family and personal chats, with due dates and status.",
  },
  {
    name: 'get_list',
    title: 'Read a list',
    scope: 'read',
    description: 'Read one of the user\'s lists by name (a grocery list, packing list, …) with its items and which are ticked off.',
  },
  {
    name: 'search_saves',
    title: 'Search saved places and links',
    scope: 'read',
    description: 'Search what the user saved in Chord: restaurants and other places, recipes, links, books and shows.',
  },
  {
    name: 'find_events',
    title: 'Find calendar events',
    scope: 'read',
    description: "Find events on the user's calendars by words and/or a date range.",
  },
  {
    name: 'get_my_availability',
    title: 'Check availability',
    scope: 'read',
    description:
      "When the user is free, computed from their calendars and work hours, for the next few days or for specific dates.",
  },
  {
    name: 'query_mail_senders',
    title: 'Rank email senders',
    scope: 'read',
    description:
      'Who emails the user most, who they write to most, who is waiting on a reply, and who has gone quiet. Counted from their mailboxes.',
  },
  {
    name: 'query_receipts',
    title: 'Look up receipts',
    scope: 'read',
    description:
      'Purchases Chord read from receipt emails: totals by merchant or month, and repeating charges (subscriptions). Totals cover only the receipts Chord has read, not every purchase.',
  },
  {
    name: 'list_subscriptions',
    title: 'List mailing lists',
    scope: 'read',
    description: 'Mailing lists the user receives, with how many emails each sent and how many the user opened.',
  },
  {
    name: 'create_event',
    title: 'Suggest a calendar event',
    scope: 'suggest',
    description: 'Suggest adding an event to the user\'s calendar.' + SUGGEST_NOTE,
  },
  {
    name: 'create_task',
    title: 'Suggest a to-do',
    scope: 'suggest',
    description: 'Suggest a to-do for the user, optionally with a due date.' + SUGGEST_NOTE,
  },
  {
    name: 'add_list_item',
    title: 'Suggest list items',
    scope: 'suggest',
    description: 'Suggest adding items to one of the user\'s lists.' + SUGGEST_NOTE,
  },
  {
    name: 'reply_to_email',
    title: 'Draft an email reply',
    scope: 'suggest',
    description:
      'Draft a reply to an email thread (by threadId). The draft is shown to the user with a Send button in Chord; nothing is sent until they tap it.' +
      SUGGEST_NOTE,
  },
  {
    name: 'trash_email',
    title: 'Suggest moving an email to Trash',
    scope: 'suggest',
    description: 'Suggest moving one email thread to Trash (by threadId).' + SUGGEST_NOTE,
  },
  {
    name: 'unsubscribe_from_sender',
    title: 'Suggest unsubscribing',
    scope: 'suggest',
    description: 'Suggest unsubscribing the user from one mailing list, named by sender.' + SUGGEST_NOTE,
  },
];

/**
 * What the connector shows for a parameter, by `tool.param`, in place of the
 * bot's own text (which tells Chord's bot when to fill each one, and may name
 * bot tools the connector does not have). Every described parameter the
 * connector exposes must be listed here: a test fails otherwise.
 */
export const PARAM_DESCRIPTIONS: Record<string, string> = {
  'search.query': 'Words describing the topic. People go in from / to. Can be empty when from, to or dates are given.',
  'search.from': 'Email sender: a name ("Bill", "Bill Smith"), an address or a domain. Nicknames resolve (Bill finds William).',
  'search.to': 'Recipient of mail the user sent: a name, an address or a domain. Optional; when omitted, mail is not filtered by recipient.',
  'search.after': 'Only email on or after this day (YYYY-MM-DD, user\'s timezone). Optional; when omitted, all dates are searched.',
  'search.before': 'Only email on or before this day (YYYY-MM-DD, user\'s timezone). Optional; when omitted, all dates are searched.',
  'search.hasAttachment': 'Only email with a file attached. Optional; when omitted, email with and without files is searched.',
  'search.emailAction': 'Only email the classifier marked with one of these actions. Optional.',
  'search.emailKind': 'Only email carrying a receipt, a delivery, a flight or a calendar invite. Optional.',
  'list_action_items.limit': 'How many to return (default 20).',
  'get_my_availability.days':'How many days from today to cover (default 10, max 14).',
  'get_my_availability.dates': 'Specific days to cover as well (YYYY-MM-DD, up to 180 days out), including days past the default window.',
  'create_event.invitees':
    "People to invite: email addresses, or names matched against the user's saved people and contacts. Names that match nobody come back in unresolvedInvitees.",
  'create_event.videoCall':
    'Add a video call link: a Google Meet on a Google calendar, a Teams meeting on an Outlook / Microsoft 365 calendar. Calendars mirrored from a phone get none. The result says which link was added, if any.',
  'create_event.repeat': 'Make the event repeat (weekly, every Tuesday, monthly, every other week…). The start date is the first occurrence.',
};

/** The schema with the connector's own parameter text (top-level properties only). */
function withConnectorParamText(tool: string, schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties;
  if (!props || typeof props !== 'object') return schema;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    const text = PARAM_DESCRIPTIONS[`${tool}.${key}`];
    next[key] = text && value && typeof value === 'object' ? { ...(value as object), description: text } : value;
  }
  return { ...schema, properties: next };
}

const GET_STARTED_SCHEMA ={ type: 'object', properties: {}, additionalProperties: false };

/** Tools that answer from the user's mail, so an empty mailbox list explains an empty answer. */
const MAIL_TOOLS = new Set([
  'search',
  'read_email',
  'query_mail_senders',
  'query_receipts',
  'list_subscriptions',
  'reply_to_email',
  'trash_email',
  'unsubscribe_from_sender',
]);

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The connector-only tool, beside the bot registry's. */
const ACTION_ITEMS_SCHEMA = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to return (default 20).' },
  },
  additionalProperties: false,
};

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

/** The tools this grant may see. A tool outside the grant is not listed. */
export function listMcpTools(scopes: readonly AiAppScope[]): McpToolDef[] {
  const defs = new Map(buildToolDefs().map((d) => [d.name, d]));
  const out: McpToolDef[] = [];
  for (const t of TOOLS) {
    if (!t.anyScope && !scopes.includes(t.scope)) continue;
    const schema =
      t.name === 'list_action_items'
        ? ACTION_ITEMS_SCHEMA
        : t.name === 'get_started'
          ? GET_STARTED_SCHEMA
          : defs.get(t.name)?.parameters;
    if (!schema) {
      logger.error('mcp tool has no bot schema', { tool: t.name });
      continue;
    }
    out.push({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: withConnectorParamText(t.name, schema as Record<string, unknown>),
      annotations: {
        title: t.title,
        readOnlyHint: t.scope === 'read',
        // A suggestion changes nothing until a person confirms it in Chord.
        destructiveHint: false,
        idempotentHint: t.scope === 'read',
        openWorldHint: false,
      },
    });
  }
  return out;
}

export type McpCallResult =
  | { ok: true; text: string; structured: Record<string, unknown> }
  | { ok: false; text: string; unknownTool?: boolean };

export async function callMcpTool(
  db: Kysely<DB>,
  auth: AiAppAuth,
  name: string,
  args: unknown,
): Promise<McpCallResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, text: `Unknown tool: ${name}`, unknownTool: true };
  if (!tool.anyScope && !auth.scopes.includes(tool.scope)) {
    return { ok: false, text: `This connection was not allowed to ${tool.scope === 'suggest' ? 'make suggestions' : 'read'} in Chord.` };
  }
  const personal = await ensurePersonalGroup(db, auth.userId);
  if (name === 'list_action_items') return listActionItems(db, auth.userId, args);
  if (name === 'get_started') {
    const structured = await getStarted(db, auth);
    return { ok: true, text: JSON.stringify(structured), structured };
  }

  const user = await db.selectFrom('users').select('last_tz').where('id', '=', auth.userId).executeTakeFirst();
  const result = await runToolForAiApp(db, {
    userId: auth.userId,
    groupId: personal.id,
    tz: user?.last_tz ?? null,
    name: name as ToolName,
    args,
    provenance: `connector:${auth.grantId}`,
  });
  logger.info('ai app tool call', { client: auth.clientId, tool: name, ok: result.ok });
  if (!result.ok) return { ok: false, text: result.error };
  const structured: Record<string, unknown> = { summary: result.summary };
  if (result.data && typeof result.data === 'object') Object.assign(structured, result.data);
  if (MAIL_TOOLS.has(name) && !(await mailboxSetup(db, auth.userId)).any) {
    structured.noMailbox = {
      connectAt: connectMailboxUrl(),
      instruction:
        'The user has no mailbox connected to Chord, so there is no email here. Say so, and give them the link to connect Gmail, Outlook, Yahoo or iCloud mail.',
    };
  }
  if (tool.scope === 'suggest' && typeof structured.proposalId === 'string') {
    structured.confirmIn = `${connectorOrigin()}/catchup/actions`;
    structured.instruction =
      'Nothing has changed yet. Tell the user the suggestion is waiting in Chord (Action Items) for them to confirm.';
  }
  return { ok: true, text: JSON.stringify(structured), structured };
}

/** A one-line description of what a proposal would do, from its arguments. */
function describeProposal(p: Proposal): string {
  let a: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(p.argsJson) as unknown;
    if (parsed && typeof parsed === 'object') a = parsed as Record<string, unknown>;
  } catch {
    /* unreadable args: fall back to the tool name */
  }
  const s = (k: string) => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : null);
  switch (p.toolName) {
    case 'create_event':
      return `Add event "${s('title') ?? 'untitled'}"${s('startsAt') ? ` at ${s('startsAt')}` : ''}`;
    case 'create_task':
      return `Add to-do "${s('title') ?? 'untitled'}"${s('dueAt') ? `, due ${s('dueAt')}` : ''}`;
    case 'add_list_item': {
      const items = Array.isArray(a.items) ? (a.items as unknown[]).filter((i) => typeof i === 'string') : [];
      return `Add ${items.join(', ') || 'items'} to ${s('listName') ?? 'a list'}`;
    }
    case 'reply_to_email':
      return 'Send a drafted reply';
    default:
      return p.toolName.replace(/_/g, ' ');
  }
}

async function listActionItems(db: Kysely<DB>, userId: string, args: unknown): Promise<McpCallResult> {
  const raw = (args && typeof args === 'object' ? (args as { limit?: unknown }).limit : undefined) ?? 20;
  const limit = typeof raw === 'number' && Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 50) : 20;
  const pending = (await listProposalsForUser(db, userId, { status: 'pending', limit: 200 })).filter(
    (p) => p.provenance?.startsWith('gmail:') || p.provenance?.startsWith('connector:'),
  );
  const withSources = await attachSourceHrefs(db, userId, pending.slice(0, limit));
  const items = withSources.map((p) => ({
    id: p.id,
    kind: p.toolName,
    what: describeProposal(p),
    from: p.provenance?.startsWith('connector:')
      ? (p.sourceLabel ?? 'Suggested by a connected app')
      : p.sourceLabel
        ? `email: ${p.sourceLabel}`
        : 'email',
    threadId: p.sourceHref?.startsWith('/email/') ? p.sourceHref.slice('/email/'.length) : undefined,
    expiresAt: p.expiresAt,
  }));
  const structured = {
    count: items.length,
    total: pending.length,
    items,
    confirmIn: `${connectorOrigin()}/catchup/actions`,
  };
  return { ok: true, text: JSON.stringify(structured), structured };
}

// ── Getting started (ADR 0335 addendum) ─────────────────────────────────

/** Settings, opened on the connected-accounts card (`?open=mailboxes`). */
export function connectMailboxUrl(): string {
  return `${connectorOrigin()}/settings?open=mailboxes`;
}

interface MailboxSetup {
  any: boolean;
  mailboxes: { address: string; provider: string; needsReconnect: boolean }[];
}

/** The user's mailboxes: the Gmail on the user row (ADR 0080) and each attached one. */
export async function mailboxSetup(db: Kysely<DB>, userId: string): Promise<MailboxSetup> {
  const [row, accounts, gmailAddress] = await Promise.all([
    db.selectFrom('users').select(['refresh_token_scopes']).where('id', '=', userId).executeTakeFirst(),
    listAccounts(db, userId),
    primaryGmailAddress(db, userId),
  ]);
  const mailboxes: MailboxSetup['mailboxes'] = [];
  if (scopesCoverGmail(row?.refresh_token_scopes)) {
    mailboxes.push({ address: gmailAddress ?? 'Gmail', provider: 'gmail', needsReconnect: false });
  }
  for (const a of accounts) {
    mailboxes.push({ address: a.email_address, provider: a.provider, needsReconnect: a.status !== 'ok' });
  }
  return { any: mailboxes.length > 0, mailboxes };
}

/** Tool names a grant can call, so a read-only grant is not offered a suggestion. */
function usableTools(scopes: readonly AiAppScope[]): Set<string> {
  return new Set(TOOLS.filter((t) => t.anyScope || scopes.includes(t.scope)).map((t) => t.name));
}

/** Every tool the connector offers, for the tutorial test. */
export const CONNECTOR_TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

async function getStarted(db: Kysely<DB>, auth: AiAppAuth): Promise<Record<string, unknown>> {
  const [user, mail] = await Promise.all([
    db.selectFrom('users').select(['display_name', 'username']).where('id', '=', auth.userId).executeTakeFirst(),
    mailboxSetup(db, auth.userId),
  ]);
  const canSuggest = auth.scopes.includes('suggest');
  const usable = usableTools(auth.scopes);
  const reconnect = mail.mailboxes.filter((m) => m.needsReconnect).map((m) => m.address);
  const steps = [
    {
      step: 1,
      title: 'Chord account',
      done: true,
      detail: `Signed in as ${user?.display_name || user?.username || 'you'}.`,
    },
    {
      step: 2,
      title: 'Connect your mailboxes',
      done: mail.any && reconnect.length === 0,
      detail: !mail.any
        ? 'No mailbox is connected yet. Connect Gmail, Outlook, Yahoo or iCloud mail in Chord, then come back.'
        : reconnect.length > 0
          ? `Reconnect ${reconnect.join(', ')} in Chord Settings; Chord cannot read it until then.`
          : `Connected: ${mail.mailboxes.map((m) => m.address).join(', ')}. More can be added in Chord Settings.`,
      link: connectMailboxUrl(),
    },
    {
      step: 3,
      title: 'Try it',
      done: false,
      detail: canSuggest
        ? 'Ask for one of the things below. Anything that would change something waits in Chord (Action Items) until the user confirms it there.'
        : 'This connection can only read. To let it suggest events, to-dos and replies, disconnect it and connect again.',
    },
  ];
  return {
    steps,
    nextStep: steps.find((s) => !s.done)?.step ?? 3,
    mailboxes: mail.mailboxes,
    tryAsking: AI_APP_TRY_ASKING.filter((t) => t.uses.every((u) => usable.has(u))).map((t) => t.ask),
    confirmIn: `${connectorOrigin()}/catchup/actions`,
    disconnect: 'Chord → Settings → Connected AI apps, or tell Chord "disconnect" and this app\'s name.',
    instruction:
      'Walk the user through these steps one at a time, starting at nextStep. If step 2 is not done, give them the link and wait until they say it is done before going on. Then offer two or three of tryAsking.',
  };
}
