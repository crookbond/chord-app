/**
 * Canonical API paths. Keep in sync with server/src/routes.
 * Clients import these so a rename in one place breaks compile everywhere.
 */
export const API = {
  base: '/api/v1',

  health: '/api/v1/health',
  healthReady: '/api/v1/health/ready',

  session: '/api/v1/session',
  sessionLogout: '/api/v1/session/logout',
  /** Web only: turn a token kept by an older build into the httpOnly cookie. */
  sessionAdopt: '/api/v1/session/adopt',
  authGoogle: '/api/v1/auth/google',
  /** ADR 0156 — Sign in with Apple (native iOS). */
  authApple: '/api/v1/auth/apple',
  /** Where Apple posts the browser back to after a web sign-in (form_post). */
  authAppleCallback: '/api/v1/auth/apple/callback',
  /** ADR 0293 — Sign in with Microsoft; also connects the Outlook mailbox. */
  authMicrosoft: '/api/v1/auth/microsoft',
  authReview: '/api/v1/auth/review',
  authGoogleCalendar: '/api/v1/auth/google/calendar',
  /** ADR 0062 — incremental consent for the gmail.modify scope. */
  authGoogleGmail: '/api/v1/auth/google/gmail',
  meLinkSignupRef: '/api/v1/me/link-signup-ref',
  meCalendarStatus: '/api/v1/me/calendar/status',
  meCalendarSync: '/api/v1/me/calendar/sync',
  meCalendarDisconnect: '/api/v1/me/calendar/disconnect',
  meCalendarSources: '/api/v1/me/calendar/sources',
  meCalendarSource: (id: string) => `/api/v1/me/calendar/sources/${id}`,
  meDefaultCalendar: '/api/v1/me/calendar/default',
  /** ADR 0057 — device calendar read-up: client posts a batch of selected
   *  device calendars + their events for the −30/+60 window. */
  meDeviceCalendarSync: '/api/v1/me/device-calendar/sync',
  /** DELETE — the phone stopped mirroring this calendar: forget its events now. */
  meDeviceCalendar: (deviceCalendarId: string) =>
    `/api/v1/me/device-calendar/${encodeURIComponent(deviceCalendarId)}`,
  meImportantDays: '/api/v1/me/important-days',
  /** ADR 0062 — global search across the searcher's groups. */
  meSearch: '/api/v1/me/search',
  /** ADR 0063/0194 — token balance + which model tier the user is on. */
  meBilling: '/api/v1/me/billing',
  /** ADR 0075 — create a Stripe Checkout session; returns the hosted URL. */
  meBillingCheckout: '/api/v1/me/billing/checkout',
  /** ADR 0075 — Stripe event webhook (signature-verified, no session). */
  webhookStripe: '/api/v1/webhooks/stripe',
  /** ADR 0231 — Stripe's hosted page: change plan, card, or cancel. */
  meBillingPortal: '/api/v1/me/billing/portal',
  /** ADR 0236 — stop (or resume) a Stripe subscription's renewal at period end. */
  meBillingRenewal: '/api/v1/me/billing/renewal',
  /** ADR 0236 — switch a Stripe subscription to another plan/interval in place. */
  meBillingPlan: '/api/v1/me/billing/plan',
  /** ADR 0231 — RevenueCat (App Store) event webhook (shared-secret, no session). */
  webhookRevenueCat: '/api/v1/webhooks/revenuecat',
  /** ADR 0231 — the family plan roster. */
  meFamily: '/api/v1/me/family',
  meFamilyMember: (id: string) => `/api/v1/me/family/${id}`,
  meFamilyInvite: (id: string) => `/api/v1/me/family/${id}/invite`,
  meFamilyAccept: '/api/v1/me/family/accept',
  meFamilyLeave: '/api/v1/me/family/leave',
  /** ADR 0234 - post one email thread into a group the user is in. */
  meEmailThreadShare: (id: string) => `/api/v1/me/email/threads/${id}/share`,
  mePeople: '/api/v1/me/people',
  /** ADR 0078 — staged add_person/add_important_date proposals for the People screen. */
  mePeoplePending: '/api/v1/me/people/pending',
  mePerson: (id: string) => `/api/v1/me/people/${id}`,
  /** ADR 0212 — the phone's answer to a `contact.lookup` request. */
  meContactLookup: (requestId: string) => `/api/v1/me/contact-lookups/${requestId}`,
  mePersonImportantDates: (id: string) => `/api/v1/me/people/${id}/important-dates`,
  meImportantDate: (id: string) => `/api/v1/me/important-dates/${id}`,
  meSettings: '/api/v1/me/settings',
  /** User-scoped SSE (email.synced / email.thread.updated / email.tiles.updated). */
  meStream: '/api/v1/me/stream',
  meListeningMode: '/api/v1/me/listening-mode',
  meName: '/api/v1/me/name',
  meModelKey: '/api/v1/me/model-key',
  meAiConsent: '/api/v1/me/ai-consent',
  /** ADR 0235 - begin connecting the user's OpenRouter account as their key. */
  meOpenRouterStart: '/api/v1/me/model-key/openrouter/start',
  /** ADR 0235 - where openrouter.ai sends the browser back (no session; the
   *  single-use `state` is the credential). */
  openRouterCallback: (state: string) => `/api/v1/openrouter/callback/${state}`,
  /** ADR 0335 — the MCP connector (remote MCP, Streamable HTTP) and its
   *  OAuth 2.1 endpoints. Outside /api/v1: they are protocol surfaces whose
   *  shape is fixed by the MCP and OAuth specs, not Chord's own API. */
  mcp: '/api/mcp',
  oauthAuthorize: '/api/oauth/authorize',
  oauthToken: '/api/oauth/token',
  oauthRegister: '/api/oauth/register',
  oauthRevoke: '/api/oauth/revoke',
  /** The consent page reads one waiting authorization, then answers it. */
  meAiAppRequest: (id: string) => `/api/v1/me/ai-app-requests/${id}`,
  meAiAppRequestApprove: (id: string) => `/api/v1/me/ai-app-requests/${id}/approve`,
  meAiAppRequestDeny: (id: string) => `/api/v1/me/ai-app-requests/${id}/deny`,
  meAiApps: '/api/v1/me/ai-apps',
  meAiApp: (id: string) => `/api/v1/me/ai-apps/${id}`,
  meNudge: '/api/v1/me/nudge',
  meTimezone: '/api/v1/me/tz',
  /** ADR 0091 — explicit weather location for the briefing. */
  meWeatherLocation: '/api/v1/me/weather-location',
  /** ADR 0258 - the phone's own location, when the user has allowed it. */
  meLocation: '/api/v1/me/location',
  /** ADR 0091 — mute/unmute the briefing on one external channel. */
  meBriefingChannel: (id: string) => `/api/v1/me/briefing-channels/${id}`,
  mePushToken: '/api/v1/me/push-token',
  meNotificationPrefs: '/api/v1/me/notification-prefs',
  /** Email digest + sync-tiles-to-labels prefs (partial patch). */
  meEmailPrefs: '/api/v1/me/email/prefs',
  meCatchupFolders: '/api/v1/me/catchup/folders',
  meCatchupFolderContents: (id: string) => `/api/v1/me/catchup/folders/${id}/contents`,
  meCatchupAssignment: (entityType: string, entityId: string) =>
    `/api/v1/me/catchup/assignments/${entityType}/${entityId}`,
  me: '/api/v1/me',
  meTrips: '/api/v1/me/trips',
  meTasks: '/api/v1/me/tasks',
  /** ADR 0311 addendum - replay one to-do or list change made offline. */
  meTodoSync: '/api/v1/me/todo-sync',
  meLists: '/api/v1/me/lists',
  meEvents: '/api/v1/me/events',
  meEventsLive: '/api/v1/me/events/live',
  meRsvps: '/api/v1/me/rsvps',
  meTrust: '/api/v1/me/trust',
  meTrustSender: (senderId: string) => `/api/v1/me/trust/${senderId}`,
  meTrustCandidates: '/api/v1/me/trust/candidates',
  mePermissionRequests: '/api/v1/me/permission-requests',
  mePermissionRequestRespond: (id: string) => `/api/v1/me/permission-requests/${id}/respond`,
  meSaves: '/api/v1/me/saves',
  meFiles: '/api/v1/me/files',

  // Phone identity + contact discovery (ADR 0064 / 0065).
  mePhone: '/api/v1/me/phone',
  mePhoneStart: '/api/v1/me/phone/start',
  mePhoneVerify: '/api/v1/me/phone/verify',
  /** ADR 0298 — people the user has blocked (GET), block someone (POST). */
  meBlocks: '/api/v1/me/blocks',
  /** ADR 0298 — unblock one person (DELETE). */
  meBlock: (userId: string) => `/api/v1/me/blocks/${userId}`,
  /** ADR 0301 — report a message in a shared chat (POST). */
  meReports: '/api/v1/me/reports',
  meContacts: '/api/v1/me/contacts',
  meContactsResolve: '/api/v1/me/contacts/resolve',
  meMemories: '/api/v1/me/memories',

  // ── In-app Gmail reader (ADR 0060/0061/0062) ──────────────────────────
  meEmailStatus: '/api/v1/me/email/status',
  meEmailSync: '/api/v1/me/email/sync',
  meEmailDisconnect: '/api/v1/me/email/disconnect',
  /** AI tile level: `?parent=<catId>` (omit for root tiles). */
  meEmailTiles: '/api/v1/me/email/tiles',
  /** Open email decisions for the AI shell (ADR 0083): pending gmail-
   *  provenance proposals with category join + coverage counts. */
  meEmailDecisions: '/api/v1/me/email/decisions',
  /** Traditional list or a category's threads:
   *  `?mode=traditional|category&category=<catId>&cursor=`. */
  meEmailThreads: '/api/v1/me/email/threads',
  /** GET ?provenance=gmail:<id> → `{ threadId }`, 404 when that mail is no longer mirrored. */
  meEmailSourceThread: '/api/v1/me/email/source-thread',
  meEmailThread: (id: string) => `/api/v1/me/email/threads/${id}`,
  /** POST EmailSendRequest - compose a new message (not a reply). */
  meEmailSend: '/api/v1/me/email/send',
  meEmailCompose: '/api/v1/me/email/compose',
  meEmailDrafts: '/api/v1/me/email/drafts',
  meEmailDraft: (id: string) => `/api/v1/me/email/drafts/${id}`,
  meEmailRecipients: '/api/v1/me/email/recipients',
  /** GET - receipts read from the user's mail, month totals, repeating charges (ADR 0246). */
  meEmailReceipts: '/api/v1/me/email/receipts',
  /** POST - one turn of the Findings tab's own chat about mail (ADR 0277). Stores nothing. */
  meFindingsChat: '/api/v1/me/findings/chat',
  meEmailImageSenders: '/api/v1/me/email/image-senders',
  /** ADR 0136 — fetches a remote image so the device never does. Authenticated
   *  by `?k=` (an <img> cannot send the session header), not by the session. */
  meEmailImageProxy: '/api/v1/me/email/image',
  meEmailInlineImage: '/api/v1/me/email/inline',
  meEmailRoutes: '/api/v1/me/email/routes',
  meEmailCategoryOrder: '/api/v1/me/email/category-order',
  meEmailMailboxColor: '/api/v1/me/email/mailbox-color',
  meEmailMailboxSignature: '/api/v1/me/email/mailbox-signature',
  /** ADR 0326 - upload a picture for a signature; answers its public link. */
  meEmailSignatureImages: '/api/v1/me/email/signature-images',
  /** ADR 0326 - a signature picture, public (recipients' mail apps load it). */
  signatureImage: (id: string) => `/api/v1/signature-images/${id}`,
  meEmailVacation: '/api/v1/me/email/vacation',
  meEmailLabels: '/api/v1/me/email/labels',
  meEmailSendAs: '/api/v1/me/email/send-as',
  meEmailThreadsModify: '/api/v1/me/email/threads/modify',
  meEmailThreadSnooze: (id: string) => `/api/v1/me/email/threads/${id}/snooze`,
  meEmailRoute: (id: string) => `/api/v1/me/email/routes/${id}`,
  meEmailOutbox: '/api/v1/me/email/outbox',
  meEmailOutboxItem: (id: string) => `/api/v1/me/email/outbox/${id}`,
  meEmailThreadReply: (id: string) => `/api/v1/me/email/threads/${id}/reply`,
  meEmailThreadCompose: (id: string) => `/api/v1/me/email/threads/${id}/compose`,
  meEmailThreadSummarize: (id: string) => `/api/v1/me/email/threads/${id}/summarize`,
  meEmailThreadReplyAsks: (id: string) => `/api/v1/me/email/threads/${id}/reply-asks`,
  meEmailThreadDraft: (id: string) => `/api/v1/me/email/threads/${id}/draft`,
  meEmailThreadForward: (id: string) => `/api/v1/me/email/threads/${id}/forward`,
  meEmailThreadForwardPreview: (id: string) => `/api/v1/me/email/threads/${id}/forward/preview`,
  meEmailThreadModify: (id: string) => `/api/v1/me/email/threads/${id}/modify`,
  meEmailThreadUnsubscribe: (id: string) => `/api/v1/me/email/threads/${id}/unsubscribe`,
  /** The mailing lists the user is on, busiest first (GET). */
  meEmailSubscriptions: '/api/v1/me/email/subscriptions',
  /** Leave several mailing lists in one request (POST EmailUnsubscribeManyRequest). */
  meEmailSubscriptionsUnsubscribe: '/api/v1/me/email/subscriptions/unsubscribe',
  /** Send senders' future mail to Trash, or stop (POST EmailAutoTrashRequest). */
  meEmailAutoTrash: '/api/v1/me/email/subscriptions/auto-trash',
  /** ADR 0309 — filing rules: GET list, POST add (AddEmailFilingRuleRequest). */
  meEmailFilters: '/api/v1/me/email/filters',
  meEmailFilter: (id: string) => `/api/v1/me/email/filters/${id}`,
  /** Classifier ingest (ADR 0061 Mode B): POST an EmailClassificationSnapshot. */
  meEmailClassification: '/api/v1/me/email/classification',
  // ── Additional mailboxes (ADR 0080) ──────────────────────────────────
  meEmailAccounts: '/api/v1/me/email/accounts',
  /** POST ConnectOutlookRequest — attach an Outlook / Microsoft 365 mailbox. */
  meEmailAccountsOutlook: '/api/v1/me/email/accounts/outlook',
  /** POST ConnectGmailAccountRequest — attach a secondary Gmail mailbox. */
  meEmailAccountsGmail: '/api/v1/me/email/accounts/gmail',
  /** POST ConnectImapRequest — attach a Yahoo/AOL/iCloud/custom IMAP mailbox. */
  meEmailAccountsImap: '/api/v1/me/email/accounts/imap',
  /** DELETE — detach the account and wipe its mirror. */
  meEmailAccount: (id: string) => `/api/v1/me/email/accounts/${id}`,
  meEmailAccountSync: (id: string) => `/api/v1/me/email/accounts/${id}/sync`,
  /** POST — retry a `reconnect`-flagged mailbox with its STORED credential. */
  meEmailAccountReconnect: (id: string) => `/api/v1/me/email/accounts/${id}/reconnect`,
  /** Download one email attachment (provider-dispatched, streamed through). */
  meEmailMessageAttachment: (messageId: string, attId: string) =>
    `/api/v1/me/email/messages/${messageId}/attachments/${encodeURIComponent(attId)}`,
  /** Live junk-folder peek across all mailboxes (never mirrored). */
  meEmailJunk: '/api/v1/me/email/junk',
  /** POST JunkRescueRequest — "not junk": move to inbox, next sync mirrors it. */
  meEmailJunkRescue: '/api/v1/me/email/junk/rescue',

  groups: '/api/v1/groups',
  group: (id: string) => `/api/v1/groups/${id}`,
  groupJoin: '/api/v1/groups/join',
  /** ADR 0318 - POST InviteByEmailRequest. */
  chatInviteByEmail: '/api/v1/chat-invites',
  /** GET ChatInvite[] waiting for the signed-in user. */
  meChatInvites: '/api/v1/me/chat-invites',
  meChatInviteAccept: (id: string) => `/api/v1/me/chat-invites/${id}/accept`,
  meChatInviteDecline: (id: string) => `/api/v1/me/chat-invites/${id}/decline`,
  groupLeave: (id: string) => `/api/v1/groups/${id}/leave`,
  groupInviteRegenerate: (id: string) => `/api/v1/groups/${id}/invite/regenerate`,
  groupMessages: (id: string) => `/api/v1/groups/${id}/messages`,
  /** POST DeleteMessagesRequest - remove selected (or all) chat messages. */
  groupMessagesDelete: (id: string) => `/api/v1/groups/${id}/messages/delete`,
  groupRead: (id: string) => `/api/v1/groups/${id}/read`,
  groupNotifications: (id: string) => `/api/v1/groups/${id}/notifications`,
  groupStream: (id: string) => `/api/v1/groups/${id}/stream`,
  groupFiles: (id: string) => `/api/v1/groups/${id}/files`,
  groupSearch: (id: string) => `/api/v1/groups/${id}/search`,
  attachment: (id: string) => `/api/v1/attachments/${id}`,
  groupTasks: (id: string) => `/api/v1/groups/${id}/tasks`,
  groupLists: (id: string) => `/api/v1/groups/${id}/lists`,
  groupSaves: (id: string) => `/api/v1/groups/${id}/saves`,
  groupEvents: (id: string) => `/api/v1/groups/${id}/events`,
  groupPlaces: (id: string) => `/api/v1/groups/${id}/places`,
  groupContacts: (id: string) => `/api/v1/groups/${id}/contacts`,
  groupMedia: (id: string) => `/api/v1/groups/${id}/media`,
  groupMemories: (id: string) => `/api/v1/groups/${id}/memories`,
  groupTrips: (id: string) => `/api/v1/groups/${id}/trips`,
  groupTrip: (id: string, tripId: string) => `/api/v1/groups/${id}/trips/${tripId}`,
  /** Soft-delete recovery (Trips tab "Deleted" section). */
  groupTripRestore: (id: string, tripId: string) => `/api/v1/groups/${id}/trips/${tripId}/restore`,
  /** Fold another trip's legs/accommodations/reservations into `tripId` (the
   *  Trips tab's drag-to-combine gesture); body is `{ mergeTripId }`. */
  groupTripMerge: (id: string, tripId: string) => `/api/v1/groups/${id}/trips/${tripId}/merge`,
  /** Reverse one specific merge (the "Undo" toast right after a mis-drop);
   *  body is `UndoMergeTripsRequest`. */
  groupTripUnmerge: (id: string, tripId: string) => `/api/v1/groups/${id}/trips/${tripId}/unmerge`,
  /** Hard-remove a single leg/accommodation off a trip (e.g. a cancelled one
   *  the user wants gone) without deleting the whole trip. */
  groupTripLeg: (id: string, tripId: string, legId: string) =>
    `/api/v1/groups/${id}/trips/${tripId}/legs/${legId}`,
  groupTripAccommodation: (id: string, tripId: string, accomId: string) =>
    `/api/v1/groups/${id}/trips/${tripId}/accommodations/${accomId}`,
  /** Re-parent one leg/accommodation onto a DIFFERENT trip (the Trips tab's
   *  per-row drag gesture — split one item out of a merge, or fix a
   *  mis-filed leg/stay, without moving the whole trip). Body is
   *  `{ targetTripId }`. */
  groupTripLegMove: (id: string, tripId: string, legId: string) =>
    `/api/v1/groups/${id}/trips/${tripId}/legs/${legId}/move`,
  groupTripAccommodationMove: (id: string, tripId: string, accomId: string) =>
    `/api/v1/groups/${id}/trips/${tripId}/accommodations/${accomId}/move`,
  groupPersonas: (id: string) => `/api/v1/groups/${id}/personas`,
  groupPersonasPromote: (id: string) => `/api/v1/groups/${id}/personas/promote`,
  groupProfile: (id: string) => `/api/v1/groups/${id}/profile`,
  attachmentShare: (id: string) => `/api/v1/attachments/${id}/share`,

  task: (id: string) => `/api/v1/tasks/${id}`,
  list: (id: string) => `/api/v1/lists/${id}`,
  listItems: (id: string) => `/api/v1/lists/${id}/items`,
  listMoveToSaves: (id: string) => `/api/v1/lists/${id}/move-to-saves`,
  listItem: (id: string) => `/api/v1/list-items/${id}`,
  save: (id: string) => `/api/v1/saves/${id}`,
  event: (id: string) => `/api/v1/events/${id}`,
  eventRsvps: (id: string) => `/api/v1/events/${id}/rsvps`,
  eventGuests: (id: string) => `/api/v1/events/${id}/guests`,
  eventVideoCall: (id: string) => `/api/v1/events/${id}/video-call`,
  /** ADR 0328 — a family member answers the invitation they were sent. */
  eventAnswer: (id: string) => `/api/v1/events/${id}/answer`,
  rsvp: (id: string) => `/api/v1/rsvps/${id}`,
  mediaItem: (id: string) => `/api/v1/media-items/${id}`,
  memoryConfirm: (id: string) => `/api/v1/memories/${id}/confirm`,
  memoryReject: (id: string) => `/api/v1/memories/${id}/reject`,
  persona: (id: string) => `/api/v1/personas/${id}`,
  fact: (id: string) => `/api/v1/facts/${id}`,

  groupProposals: (id: string) => `/api/v1/groups/${id}/proposals`,
  meProposals: '/api/v1/me/proposals',
  proposalConfirm: (id: string) => `/api/v1/proposals/${id}/confirm`,
  proposalReject: (id: string) => `/api/v1/proposals/${id}/reject`,
  /** ADR 0104 — answer a calendar invitation (yes / maybe / no). */
  proposalRsvp: (id: string) => `/api/v1/proposals/${id}/rsvp`,
  /** ADR 0346 - answer the card's question about an overlapping event. */
  proposalOverlap: (id: string) => `/api/v1/proposals/${id}/overlap`,
  /** ADR 0346 - slots held in Chord while an invitation is on its way. */
  meHolds: '/api/v1/me/holds',
  meHold: (meetingId: string) => `/api/v1/me/holds/${meetingId}`,
  /** ADR 0346 phase 5 - "wait for theirs" on a card asking who sends the invite. */
  proposalWaitForInvite: (id: string) => `/api/v1/proposals/${id}/wait-for-invite`,

  demoReset: '/api/v1/demo/reset',

  ingestWhatsApp: '/api/v1/ingest/whatsapp',
  ingestIcs: '/api/v1/ingest/ics',
  devProactiveScan: '/api/v1/_dev/proactive-scan',

  groupConnectors: (id: string) => `/api/v1/groups/${id}/connectors`,
  meConnectors: '/api/v1/me/connectors',
  groupConnectorPair: (id: string) => `/api/v1/groups/${id}/connectors/pair`,
  groupConnectorPairStatus: (id: string, code: string) =>
    `/api/v1/groups/${id}/connectors/pair/${code}`,
  groupConnectorBinding: (
    id: string,
    platform: string,
    externalChannelId: string,
  ) => `/api/v1/groups/${id}/connectors/${platform}/${externalChannelId}`,

  waitlist: '/api/v1/waitlist',
} as const;

/** Session cookie + Authorization fallback header name. */
export const SESSION_HEADER = 'x-chord-token';

/** Mode-B classifier ingest (ADR 0066). Empty EMAIL_CLASSIFIER_SERVICE_TOKEN disables. */
export const CLASSIFIER_TOKEN_HEADER = 'x-chord-classifier-token';
export const SESSION_COOKIE = 'chord.sid';

/**
 * A write authenticated by the session COOKIE must carry this header, or the
 * server refuses it (403). A page on another site cannot add a custom header
 * without a CORS preflight the server refuses, so its forged form or fetch
 * fails. Writes authenticated by the token header need no second header.
 */
export const CSRF_HEADER = 'x-chord-csrf';
