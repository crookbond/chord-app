/**
 * ADR 0335 — an AI app (Claude, ChatGPT, …) the user connected to Chord over
 * MCP. The words here are the ones the consent page and Settings show, so the
 * server's scope check and what the user agreed to can never say different
 * things.
 */

/** `read`: look at mail, to-dos, lists and the calendar. `suggest`: put a
 *  suggestion in Action Items that the user confirms in Chord. */
export const AI_APP_SCOPES = ['read', 'suggest'] as const;
export type AiAppScope = (typeof AI_APP_SCOPES)[number];

export const AI_APP_SCOPE_TEXT: Record<AiAppScope, string> = {
  read: 'Read your email, to-dos, lists, saved places and calendar, and see when you are free',
  suggest:
    'Suggest events, to-dos, list items and email replies. Each one waits in Action Items until you confirm it in Chord: it cannot send mail, change or delete anything by itself',
};

/**
 * The scopes a request names, in canonical order. Absent or empty = both (a
 * client that asks for nothing in particular is asking for the connector).
 * Any name we do not know makes the whole request invalid, so a client never
 * believes it holds a power the user was not shown.
 */
export function parseAiAppScope(scope: string | null | undefined): AiAppScope[] | null {
  const words = (scope ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...AI_APP_SCOPES];
  const known = new Set<string>(AI_APP_SCOPES);
  if (words.some((w) => !known.has(w))) return null;
  return AI_APP_SCOPES.filter((s) => words.includes(s));
}

/** What the consent page shows about one waiting authorization. */
export interface AiAppRequestView {
  id: string;
  /** The name the client registered with. Self-asserted, so the page shows the
   *  redirect host beside it. */
  clientName: string;
  clientUri: string | null;
  /** Host the browser goes back to after the answer. */
  redirectHost: string;
  scopes: AiAppScope[];
}

/** Where the consent page sends the browser after Allow or Deny. */
export interface AiAppDecisionResult {
  redirectTo: string;
}

/** One app the user has connected (Settings, and the bot's list). */
export interface ConnectedAiApp {
  id: string;
  name: string;
  clientUri: string | null;
  scopes: AiAppScope[];
  connectedAt: string;
  lastUsedAt: string | null;
}

/**
 * Things to ask an AI app once Chord is connected (consent page + the
 * connector's `get_started` tool). Each names the connector tools that answer
 * it and the scope those need; a server test checks the tools exist and need
 * no more than that scope, so the list promises only what the connector does.
 */
export const AI_APP_TRY_ASKING: readonly { ask: string; scope: AiAppScope; uses: readonly string[] }[] = [
  { ask: "What's waiting on me in Chord?", scope: 'read', uses: ['list_action_items'] },
  { ask: 'Find the email from the school about the field trip and tell me what it says.', scope: 'read', uses: ['search', 'read_email'] },
  { ask: 'Am I free Thursday afternoon? Suggest a time for coffee with Sam.', scope: 'suggest', uses: ['get_my_availability', 'create_event'] },
  { ask: 'Add milk and eggs to my grocery list.', scope: 'suggest', uses: ['add_list_item'] },
  { ask: 'Draft a reply to the plumber saying Tuesday works.', scope: 'suggest', uses: ['search', 'reply_to_email'] },
  {
    ask: 'Which mailing lists do I never open? Unsubscribe me from the worst one.',
    scope: 'suggest',
    uses: ['list_subscriptions', 'unsubscribe_from_sender'],
  },
  { ask: 'How much did I spend on Amazon last month?', scope: 'read', uses: ['query_receipts'] },
];
