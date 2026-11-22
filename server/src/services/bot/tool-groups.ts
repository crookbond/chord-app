/**
 * ADR 0322 — a chat turn is sent the tools it is likely to need, not all of
 * them. The full catalogue (~120 tools) was ~35k tokens of every round trip;
 * most turns use one or two tools from the core set below.
 *
 * Every tool is in CORE or in exactly one group (pinned by a test). A group
 * is added when its words appear in the user's own latest message(s) (never a
 * bot reply; words name the group, not everyday talk), when a running
 * skill or a pending offer names one of its tools, or when the model asks for
 * it with `more_tools`. Leaving a tool out is a cost choice, never a guard:
 * the loop still runs a tool the model calls by name, and loads its group.
 */
import type { LlmToolDef } from '@/services/llm/types.js';

import type { ToolName } from './tools.js';

export const CORE_TOOLS: readonly ToolName[] = [
  'create_event',
  'update_event',
  'delete_event',
  'find_events',
  'create_task',
  'update_task',
  'complete_task',
  'list_tasks',
  'add_list_item',
  'get_list',
  'rename_list',
  'move_list_to_saves',
  'save_place',
  'save_link',
  'save_media',
  'search_saves',
  'search',
  'search_web',
  'suggest_external_action',
  'remember_fact',
  'list_memories',
  'correct_memory',
  'forget_memory',
  'send_file',
  'look_at_attachment',
  'reference_file',
  'start_skill',
  'skill_step',
];

export interface ToolGroup {
  id: string;
  /** One line for the `more_tools` description. */
  about: string;
  tools: readonly ToolName[];
  /** Lower-cased conversation text matching any of these loads the group. */
  words: RegExp;
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: 'calendar',
    about: 'availability, conflicts, guests and RSVPs, calendar feeds, default calendar and colors, sharing an event with a group',
    tools: [
      'get_my_availability',
      'find_conflicts',
      'get_event_status',
      'record_rsvp',
      'answer_invitation',
      'email_event_guests',
      'share_event',
      'import_calendar',
      'set_default_calendar',
      'set_calendar_color',
      'set_work_hours',
      'answer_calendar_question',
      'meeting_holds',
      'wait_for_invite',
    ],
    words:
      /calendar|availab|work ?hours|working hours|\bwork days?\b|office hours|\b(am i|are (we|you)|is \w+) free\b|free (time|slot)|\bbusy\b|conflict|clash|double.?book|overlap|\binvit(e|ation)|\brsvp|\bguests?\b|\battend(ee|ing|s)\b|\bics\b|ical|webcal|share (it|this|that|the event) with|count me (in|out)|who'?s coming|can'?t make it|\bdeclin(e|ing) (it|the|that)|waiting on|\bheld\b|stop holding/,
  },
  {
    id: 'trips',
    about: 'trips, flights, trains, hotels, reservations, passengers, merging and moving legs',
    tools: [
      'create_trip',
      'update_trip',
      'get_trip_status',
      'add_travel_leg',
      'add_accommodation',
      'add_reservation',
      'move_leg',
      'move_accommodation',
      'merge_trips',
      'set_trip_passengers',
      'set_leg_passenger',
      'set_event_trip',
      'share_trip',
    ],
    words:
      /\btrips?\b|travel|flights?\b|\bfly(ing)? (to|from|out|back|home)\b|airport|airline|hotel|airbnb|vacation|itinerar|reservation|\btrains?\b|amtrak|passenger|\b(this|that|the|first|second|return|outbound) leg\b|layover|cruise|rental car|boarding pass|\bpnr\b/,
  },
  {
    id: 'email',
    about: 'reading, replying to, forwarding, composing, trashing and sharing email; questions about senders and receipts',
    tools: [
      'read_email',
      'summarize_email',
      'reply_to_email',
      'forward_email',
      'compose_email',
      'cancel_email_send',
      'trash_email',
      'update_email',
      'update_emails_matching',
      'share_email_with_group',
      'query_mail_senders',
      'query_receipts',
    ],
    words:
      /e-?mail(?! (address|signature))|\bmails?\b|gmail|outlook|inbox|\bunread\b|\breply (to|all)\b|\bforward (it|this|that|the)\b|\bthreads?\b|\bsenders?\b|receipts?\b|\bspen(t|d|ding)\b|purchases?\b|paying for|\bmy orders\b|\border(ed)? from\b|\bdrafts?\b|\bunsend|write back/,
  },
  {
    id: 'email_settings',
    about: 'mailing lists and unsubscribing, filters, routing, sort rules and categories, signature, digest, default mailbox, briefing exclusions',
    tools: [
      'list_subscriptions',
      'unsubscribe_from_sender',
      'unsubscribe_from_senders',
      'trash_future_mail',
      'stop_trashing_mail',
      'add_mail_filter',
      'list_mail_filters',
      'remove_mail_filter',
      'set_email_route',
      'list_email_routes',
      'add_email_sort_rule',
      'list_email_sort_rules',
      'remove_email_sort_rule',
      'create_email_category',
      'set_email_category_order',
      'set_email_signature',
      'set_email_digest',
      'set_default_mailbox',
      'set_mailbox_color',
      'set_briefing_exclusion',
      'list_briefing_exclusions',
    ],
    words:
      /unsubscri|mailing lists?|newsletters?|\bfilters?\b|\bfolders?\b|\blabels?\b|\broute\b|routing|\bsort (rules?|emails?|mail|my mail)\b|\bcategor(y|ies)\b|signature|digest|mailbox|\bjunk\b|\bspam\b|future (mail|emails)|leave (the|that|this) list|(out of|from) (the |my )?briefing/,
  },
  {
    id: 'people',
    about: 'people and contacts, birthdays and dates, phone numbers, the family plan roster',
    tools: [
      'add_person',
      'update_person',
      'list_people',
      'get_person_profile',
      'add_important_date',
      'get_contact_info',
      'lookup_contact',
      'save_contact',
      'add_family_member',
      'remove_family_member',
      'list_family_members',
    ],
    words:
      /birthday|\bbday|anniversar|\bcontacts?\b|\b(phone|cell|mobile) (number|no)\b|'s number\b|e-?mail address|(home|street|mailing|their|his|her)( \w+)? address\b|'s address\b|\bpeople\b|\badd (\w+ )+as (a )?(person|contact)\b|family (plan|member|roster)|\broster\b/,
  },
  {
    id: 'chats',
    about: 'messaging another person or group, inviting someone to a chat, chat invites, leaving, renaming or deleting chats and messages, relaying',
    tools: [
      'message_user',
      'message_group',
      'relay',
      'invite_to_chat',
      'respond_to_chat_invite',
      'rename_group',
      'leave_group',
      'delete_group',
      'delete_messages',
    ],
    words:
      /\b(the|this|that|our|family|group|a) chats?\b|\bchat with\b|\bgroup chat|send (a |the )?message|\bmessage (him|her|them|mom|dad|my|the)\b|\btell (him|her|them)\b|\btell (?!me\b)\w+ (that|to|about)\b|\btext (him|her|them)\b|let (?!me\b)\w+ know|\bask (him|her|them)\b|invite .{1,40} to (the |this |our |a )?(chat|group)|chat invit|(leave|rename|delete) (the |this |that |our |my )?(\w+ )?(group|chat)\b|delete .{0,20}messages?\b|clear (the |this |my )?(chat|history)\b|\brelay\b|\bpass (it|this|that) on\b/,
  },
  {
    id: 'account',
    about: 'plan, billing and token usage, own AI key, weather location, morning briefing time and channel, name, phone verification, blocking and reporting, AI consent, connected AI apps',
    tools: [
      'get_billing_status',
      'get_checkout_link',
      'set_subscription_renewal',
      'change_subscription_plan',
      'connect_openrouter',
      'set_weather_location',
      'set_nudge_time',
      'send_briefing',
      'set_briefing_channel',
      'set_my_name',
      'verify_phone',
      'withdraw_ai_consent',
      'block_user',
      'unblock_user',
      'list_blocked_users',
      'report_message',
      'list_connected_apps',
      'disconnect_app',
    ],
    words:
      /billing|\bsubscription|\b(my|chord|paid|individual|annual|monthly|chord's) plan\b|pricing|\btokens?\b|\bcredits?\b|\brenew(al)? my\b|\bupgrade|\bdowngrade|(credit|payment) card|openrouter|api key|own key|byok|\b(ai|which|what) model\b|weather|my location|time ?zone|my name\b|^call me\b|verify (my )?(phone|number)|verification code|consent|privacy|\bblock (him|her|them|this person|\w+ from)\b|\bunblock|\breport (him|her|them|this|that|a message|the message)\b|\babuse|\bsettings\b|whatsapp|briefing|\bnudge|\bconnected apps?\b|\bdisconnect\b|\b(claude|chatgpt)\b/,
  },
  {
    id: 'forms',
    about: 'filling in a form or PDF',
    tools: ['start_form_fill', 'complete_form_fill'],
    words: /\bforms?\b|fill (in|out)|\bpdf\b|sign (it|this|the)/,
  },
];

export const MORE_TOOLS_NAME = 'more_tools';

const GROUP_BY_TOOL = new Map<string, string>(
  TOOL_GROUPS.flatMap((g) => g.tools.map((t) => [t as string, g.id] as const)),
);
const CORE = new Set<string>(CORE_TOOLS);

/** The group a tool belongs to, or null for a core tool / unknown name. */
export function groupOfTool(name: string): string | null {
  return GROUP_BY_TOOL.get(name) ?? null;
}

/** Groups whose words appear in `text` (already lower-cased or not). */
export function groupsForText(text: string): Set<string> {
  const t = text.toLowerCase();
  return new Set(TOOL_GROUPS.filter((g) => g.words.test(t)).map((g) => g.id));
}

/** Groups holding any tool named in `text` (skill instructions, pending offers). */
export function groupsNamingTools(text: string): Set<string> {
  const out = new Set<string>();
  for (const [tool, group] of GROUP_BY_TOOL) {
    if (text.includes(tool)) out.add(group);
  }
  return out;
}

/**
 * The defs to send: core first, then the chosen groups in their fixed order,
 * so turns share the longest possible prefix (provider prompt caching keys on
 * it). `available` is already filtered for persona and chat kind.
 */
export function selectToolDefs(
  available: readonly LlmToolDef[],
  groups: ReadonlySet<string>,
  afterCore: readonly LlmToolDef[] = [],
): LlmToolDef[] {
  const byName = new Map(available.map((d) => [d.name, d]));
  const out: LlmToolDef[] = [];
  for (const name of CORE_TOOLS) {
    const d = byName.get(name);
    if (d) out.push(d);
  }
  out.push(...afterCore);
  for (const g of TOOL_GROUPS) {
    if (!groups.has(g.id)) continue;
    for (const name of g.tools) {
      const d = byName.get(name);
      if (d) out.push(d);
    }
  }
  // A tool in neither list (a new one nobody placed) is sent rather than lost;
  // the coverage test fails the build until it is placed.
  for (const d of available) {
    if (!CORE.has(d.name) && !GROUP_BY_TOOL.has(d.name) && d.name !== MORE_TOOLS_NAME) out.push(d);
  }
  return out;
}

/**
 * The `more_tools` def. Lists every group with what it covers and its tool
 * names, so the model knows what it can load. Static text, so it caches.
 */
let moreToolsCached: LlmToolDef | null = null;

export function moreToolsDef(): LlmToolDef {
  if (!moreToolsCached) moreToolsCached = buildMoreToolsDef();
  return moreToolsCached;
}

function buildMoreToolsDef(): LlmToolDef {
  const lines = TOOL_GROUPS.map((g) => `- ${g.id}: ${g.about}. Tools: ${g.tools.join(', ')}.`);
  return {
    name: MORE_TOOLS_NAME,
    description:
      'Load more tools for this turn. Only some tools are sent each turn to keep replies fast; ' +
      'call this FIRST, before answering, whenever the request needs a tool you were not given. ' +
      'After it returns, the loaded tools are available on your next step. Never tell the user ' +
      'you cannot do something a group below covers: load the group instead. Groups:\n' +
      lines.join('\n'),
    parameters: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: { type: 'string', enum: TOOL_GROUPS.map((g) => g.id) },
          description: 'The groups to load.',
        },
      },
      required: ['groups'],
    },
  };
}
