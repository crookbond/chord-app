import type { Message } from './types/message';
import type { Task } from './types/task';
import type { ListItem } from './types/list';
import type { Save } from './types/save';
import type { GroupEvent, Rsvp } from './types/event';
import type { Memory } from './types/memory';
import type { Persona } from './types/persona';
import type { Proposal, ProposalResolvedEvent } from './types/proposal';
import type { Accommodation, TravelLeg, Trip, TripReservation } from './types/trip';
import type { EmailSyncResult, EmailThreadUpdatedEvent } from './types/email';
import type { DeviceContactLookupRequest } from './types/contact-discovery';
import type { GroupId, UserId, IsoDateTime } from './types/ids';

export interface BotSaveOffer {
  /** The message whose body contained the URL. */
  messageId: string;
  url: string;
  title: string;
}

export type BotCardKind =
  | 'task'
  | 'save'
  | 'trip'
  | 'list'
  | 'event'
  | 'action'
  | 'email'
  | 'contact'
  | 'memory'
  | 'choices';

/** ADR 0281 — where a learned fact stands, as shown on its chat card. */
export type MemoryNoticeStatus = 'proposed' | 'saved' | 'replaced' | 'removed';

/** Structured card attached to the bot's reply; rendered inline below the bubble. */
export interface BotCard {
  kind: BotCardKind;
  title: string;
  subtitle?: string;
  /** Small grey bottom line — e.g. "due Mar 14" / "AA 412 · JFK→SEA". */
  meta?: string;
  /**
   * Secondary detail/snippet line, rendered distinctly (muted, up to two
   * lines) from `subtitle`/`meta` — a search result's own content, e.g. an
   * email's body snippet, an unfinished list's item names, or a save's note.
   * Optional; omitted when a hit has nothing more to show than its title.
   */
  preview?: string;
  /**
   * Tappable deep link. Set on `kind: 'action'` cards from the
   * `suggest_external_action` tool (PR-F). Mobile renders the card as a
   * Pressable that opens the URL in the system browser.
   */
  url?: string;
  /**
   * Optional native-app deep link (e.g. `findmy://`). When set, the
   * Chord mobile app tries `appUrl` first via Linking.canOpenURL and
   * falls back to `url`. Bridged surfaces (Telegram, Slack, Discord,
   * plain) ignore this and always ship `url` — custom schemes don't
   * route reliably from those clients.
   */
  appUrl?: string;
  /**
   * ADR 0059 — in-app navigation target (an expo-router path, e.g.
   * `/catchup/tasks`, `/calendar`, `/groups/<id>`). Set on search-result
   * cards so tapping a hit jumps to the relevant screen INSIDE the app
   * (via `router.push`), rather than opening a URL. Mobile only; bridged
   * surfaces ignore it (they get the card as a text block). A card uses
   * `href` (in-app nav) OR `url` (external browser), not both.
   */
  href?: string;
  /**
   * ADR 0059 — a file card (a `search` hit that is an attachment). When set,
   * tapping the card OPENS the actual file — the OS viewer / Quick Look on
   * native (PDFs, docs), an auth-fetched blob tab on web (images render
   * inline). Takes precedence over `href`/`url`. `title` is the filename;
   * `mimeType` lets native pick the right viewer. Mobile only.
   */
  attachmentId?: string;
  mimeType?: string;
  /**
   * ADR 0157 — a `kind: 'contact'` card. The bot needs this person's email to
   * finish inviting them to an event and could not resolve it. Mobile renders
   * "Add <contactName> from Contacts", opens the OS contact picker, and posts
   * the chosen email back into the chat. Bridged surfaces show it as a text
   * prompt to reply with the address.
   */
  contactName?: string;
  /**
   * ADR 0281 — a `kind: 'memory'` card: a fact Chord just learned. Mobile
   * shows Keep / Not right (proposed) or Forget (saved) to `memoryForUserId`
   * only — the person whose message taught it. The server rewrites
   * `memoryStatus` and `meta` on the stored card when the fact changes.
   */
  memoryId?: string;
  memoryStatus?: MemoryNoticeStatus;
  memoryForUserId?: string;
  /**
   * ADR 0299 — a `kind: 'choices'` card: tappable answers to the question the
   * bot just asked. Mobile shows each as a chip that posts its text into the
   * chat as the user's reply; bridged surfaces show `subtitle` (the same
   * answers in one line) for the user to type.
   */
  replies?: string[];
  /**
   * ADR 0029 — callback button for IM surfaces (Telegram today). When
   * set, bridged renderers emit a tappable button whose press routes
   * `verb:id` back to the bot as a callback event. A card uses either
   * `url` (open URL on tap) or `callback` (round-trip a payload), never
   * both. The mobile app ignores `callback`; it has its own native
   * affordances (proposal pills etc.) for the same actions.
   */
  callback?: BotCardCallback;
  /**
   * ADR 0029 — multi-button row. When set, the card renders as a
   * single inline-keyboard row with these buttons (Telegram). Use this
   * to put confirm/reject side-by-side on one row, vs. the default
   * one-button-per-card layout. URL and callback are per-button (each
   * button is either URL or callback, never both). Mobile ignores.
   *
   * Precedence: when `buttons` is set, `url` / `callback` on the card
   * itself are ignored. The card's `title` / `subtitle` / `meta` still
   * surface in mobile / plain renderers as a text block.
   */
  buttons?: BotActionButton[];
}

export interface BotCardCallback {
  /** Short verb (≤ 4 chars recommended) routed by the connector
   *  inbound callback handler. Known verbs today: `p+`, `p-`. */
  verb: string;
  /** The entity id this verb operates on (e.g. proposal id). Encoded
   *  as `${verb}:${id}` for transports like TG that cap payload at
   *  64 bytes. */
  id: string;
}

export interface BotActionButton {
  label: string;
  /** Open a URL when tapped. Mutually exclusive with `callback`. */
  url?: string;
  /** Round-trip a payload to the bot's callback handler. Mutually
   *  exclusive with `url`. */
  callback?: BotCardCallback;
}

export interface BotCardPayload {
  messageId: string;
  cards: BotCard[];
}

/**
 * A single tool invocation inside a bot turn. Emitted once per tool call,
 * after the call has executed, so clients can render a visible trace of
 * what the bot did ("⚙ Added 2 items to Costco list").
 */
export interface BotToolEvent {
  messageId: string;
  /** Tool registry name, e.g. `add_list_item`, `create_trip`. */
  name: string;
  /** One-line human summary returned by the executor. */
  summary: string;
  /**
   * `error` = the call threw (an internal fault). `declined` = it ran to
   * completion but its own result said nothing happened (`created: false`,
   * `updated: false`, a past-date refusal, an unresolvable repeat, an
   * ambiguous match needing a pick, …) — a validation refusal, not a bug,
   * but just as much "don't show this as a success" as `error` is. Before
   * this distinction existed every non-throwing result was `ok`, so a
   * declined `create_event` rendered as a cheerful "created event · <why
   * it refused>" pill — indistinguishable from an actual success.
   */
  status: 'ok' | 'error' | 'declined';
}

/**
 * Attachments that were injected into the LLM context for this bot turn.
 * Clients render them as a "based on: …" footer under the bot's reply so the
 * memory pillar is visible on stage.
 */
export interface BotSourcesEvent {
  messageId: string;
  sources: Array<{
    attachmentId: string;
    filename: string;
    summary?: string;
    pinned: boolean;
  }>;
}

/**
 * Emitted once at the very top of a bot turn — before any `bot.token`,
 * `bot.tool`, or `bot.done` fires — so consumers can bind the bot
 * reply's `messageId` to the trigger message ahead of every other
 * event. Without this, clients have to buffer bot.* events keyed by
 * `messageId` and reconcile them when the eventual `message` event
 * (carrying `replyToId`) arrives, which forces ugly state in any
 * concurrent-turn-aware client (e.g. load simulator, web admin UI).
 */
export interface BotStartEvent {
  /** The user-visible message that triggered this turn. */
  triggerMessageId: string;
  /** The bot reply's message id — present on every later bot.* event. */
  messageId: string;
}

/**
 * Emitted at the end of a *directive* turn (≥1 tool fired). The bot reply
 * row is persisted at `chord_visible=0`, so neither `bot.done` nor
 * `message` fires for it. Clients render the turn as a receipt strip
 * attached under the trigger message — using the `bot.tool` and
 * `bot.card` events emitted earlier in the turn (keyed on `messageId`).
 *
 * Q&A turns (no tool fired) skip this event and fire the standard
 * `message` + `bot.done` pair instead, so the bubble appears all at once.
 */
export interface BotReceiptEvent {
  triggerMessageId: string;
  /** The bot reply's message id — same id `bot.tool` / `bot.card` reference. */
  messageId: string;
  status: 'ok' | 'error';
  /** Names of tools that fired in the turn, in execution order. */
  toolNames: string[];
}

/**
 * SSE event names emitted on /api/v1/groups/:id/stream.
 * Payload types are listed in `SseEventMap` below.
 */
export const SSE = {
  message: 'message',
  /** Messages were deleted from the chat; clients drop them by id. */
  messagesDeleted: 'messages.deleted',
  botStart: 'bot.start',
  /**
   * @deprecated As of quiet-mode (ADR 0022) the server no longer emits
   * `bot.token` — replies are buffered server-side and surfaced via
   * `bot.receipt` (directive turns) or a single `message` event (Q&A
   * turns). The constant is kept for old clients/listeners that still
   * subscribe; nothing fires.
   */
  botToken: 'bot.token',
  botReceipt: 'bot.receipt',
  botDone: 'bot.done',
  taskCreated: 'task.created',
  taskUpdated: 'task.updated',
  listUpdated: 'list.updated',
  /** ADR 0105 — a To Do's entity changed in a group the recipient belongs to.
   *  Rides the USER channel, because the hub spans every group. */
  todosChanged: 'todos.changed',
  saveAdded: 'save.added',
  eventCreated: 'event.created',
  eventUpdated: 'event.updated',
  eventDeleted: 'event.deleted',
  rsvpUpdated: 'rsvp.updated',
  memoryCreated: 'memory.created',
  memoryProposed: 'memory.proposed',
  memoryResolved: 'memory.resolved',
  personaCreated: 'persona.created',
  personaUpdated: 'persona.updated',
  personaDeleted: 'persona.deleted',
  proposalCreated: 'proposal.created',
  proposalResolved: 'proposal.resolved',
  botSaveOffer: 'bot.save-offer',
  botCard: 'bot.card',
  botTool: 'bot.tool',
  botSources: 'bot.sources',
  tripUpdated: 'trip.updated',
  tripDeleted: 'trip.deleted',
  travelLegCreated: 'travel_leg.created',
  accommodationCreated: 'accommodation.created',
  reservationCreated: 'reservation.created',
  attachmentDeleted: 'attachment.deleted',
  ingestProgress: 'ingest.progress',
  ingestDone: 'ingest.done',
  connectorBound: 'connector.bound',
  connectorUnbound: 'connector.unbound',
  connectorRenamed: 'connector.renamed',
  groupRenamed: 'group.renamed',
  groupRead: 'group.read',
  /** ADR 0212 — ask the asker's phone to look up one name in its Contacts.
   *  Broadcast only on a personal (1:1) chat's channel. */
  contactLookup: 'contact.lookup',
  /** ADR 0060/0061 — in-app Gmail reader, broadcast on the user's personal channel. */
  emailSynced: 'email.synced',
  emailThreadUpdated: 'email.thread.updated',
  emailTilesUpdated: 'email.tiles.updated',
  ping: 'ping',
  streamEnd: 'stream.end',
} as const;

export type SseEventName = (typeof SSE)[keyof typeof SSE];

export interface SseEventMap {
  [SSE.message]: Message;
  [SSE.messagesDeleted]: { groupId: string; ids: string[] };
  [SSE.botStart]: BotStartEvent;
  [SSE.botToken]: { messageId: string; delta: string };
  [SSE.botReceipt]: BotReceiptEvent;
  [SSE.botDone]: { messageId: string };
  [SSE.taskCreated]: Task;
  [SSE.taskUpdated]: Task;
  [SSE.listUpdated]: { listId: string; item?: ListItem };
  [SSE.todosChanged]: { groupId: string };
  [SSE.saveAdded]: Save;
  [SSE.eventCreated]: GroupEvent;
  [SSE.eventUpdated]: GroupEvent;
  [SSE.eventDeleted]: { id: string; ownerUserId?: string };
  [SSE.rsvpUpdated]: Rsvp;
  [SSE.memoryCreated]: Memory;
  [SSE.memoryProposed]: Memory;
  [SSE.memoryResolved]: { id: string; status: 'confirmed' | 'rejected' };
  [SSE.personaCreated]: Persona;
  [SSE.personaUpdated]: Persona;
  [SSE.personaDeleted]: { id: string; groupId: string };
  [SSE.proposalCreated]: Proposal;
  [SSE.proposalResolved]: ProposalResolvedEvent;
  [SSE.botSaveOffer]: BotSaveOffer;
  [SSE.botCard]: BotCardPayload;
  [SSE.botTool]: BotToolEvent;
  [SSE.botSources]: BotSourcesEvent;
  [SSE.tripUpdated]: Trip;
  [SSE.tripDeleted]: { id: string };
  [SSE.travelLegCreated]: TravelLeg;
  [SSE.accommodationCreated]: Accommodation;
  [SSE.reservationCreated]: TripReservation;
  [SSE.attachmentDeleted]: { id: string };
  [SSE.ingestProgress]: IngestProgressEvent;
  [SSE.ingestDone]: IngestDoneEvent;
  [SSE.connectorBound]: ConnectorBoundEvent;
  [SSE.connectorUnbound]: ConnectorUnboundEvent;
  [SSE.connectorRenamed]: ConnectorRenamedEvent;
  [SSE.groupRenamed]: { groupId: string; name: string };
  [SSE.groupRead]: GroupReadEvent;
  [SSE.contactLookup]: DeviceContactLookupRequest;
  [SSE.emailSynced]: EmailSyncResult;
  [SSE.emailThreadUpdated]: EmailThreadUpdatedEvent;
  [SSE.emailTilesUpdated]: { userId: UserId };
  [SSE.ping]: { t: number };
  [SSE.streamEnd]: StreamEndEvent;
}

/**
 * Emitted on the Chord group's SSE channel when an external connector
 * binding is established (e.g. via the Telegram pairing-code flow) so
 * the mobile group-settings UI can update without polling.
 */
export interface ConnectorBoundEvent {
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  externalChannelId: string;
  /** Best-effort human-readable label (chat title, channel name). */
  externalDisplay: string | null;
}

export interface ConnectorUnboundEvent {
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  externalChannelId: string;
}

export interface ConnectorRenamedEvent {
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp';
  externalChannelId: string;
  alias: string;
}

/**
 * Emitted when a member marks the group read (opens the chat). Broadcast
 * on the group channel so the member's *other* devices clear the unread
 * cursor in real time — read state is server-authoritative and shared
 * across a user's sessions. Recipients filter by `userId`: only the user
 * who read should advance their own cursor.
 */
export interface GroupReadEvent {
  groupId: GroupId;
  userId: UserId;
  lastReadAt: IsoDateTime;
}

/**
 * Emitted by the server immediately before it closes the response intentionally.
 * The client treats this as a clean end-of-stream: it closes the EventSource
 * (preventing auto-reconnect) and does NOT surface an error. Absence of this
 * event when the connection drops means the disconnect was unplanned (crash,
 * network) and the client may reconnect / show a "reconnecting" state.
 */
export type StreamEndReason =
  | 'shutdown'
  | 'unauthorized'
  | 'forbidden'
  | 'group_deleted';

export interface StreamEndEvent {
  reason: StreamEndReason;
}

/** Emitted per extraction window while the WhatsApp-import background job runs. */
export interface IngestProgressEvent {
  phase: 'extracting';
  window: number;
  totalWindows: number;
  entitiesSoFar: number;
}

/** Emitted once when the WhatsApp-import background job finishes. */
export interface IngestDoneEvent {
  entitiesExtracted: number;
  durationMs: number;
  error?: string;
}
