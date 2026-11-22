# Features

What the product does today. The original inspiration is the demo brainstorm in
[`references/chord_demo_flows.html`](./references/chord_demo_flows.html) — this file
describes what actually shipped, which has grown well past it.

Every non-obvious decision has an ADR in [`notes/`](./notes/); the table in
[`CLAUDE.md`](../CLAUDE.md) is the index. Where a feature is gated by an env flag,
the flag is named.

## Identity

- **Google-only for real users** (ADR 0014). `AUTH_MODE=google` — signing in with
  Google is the entire sign-up; there are no passwords. Native iOS uses its own
  public OAuth client (ADR 0041); Android runs the web client through a verified
  App Link at `/nativeauth` because Google dropped custom-scheme redirects for
  Android clients (ADR 0081).
- **`AUTH_MODE=demo`** (the default in `example.env`, for local dev and tests) keeps
  the legacy username-only session: type a name, get a token, no OAuth. The
  `POST /session` route 403s outside demo mode.
- On sign-up the server auto-creates a **personal group** (`kind='personal'`) so the
  chat list is never empty. It is stored as the bare name `My Chord` — clients
  render the title from the user's preferred name (`John · My Chord`), and the
  stored label is what shows on bridges. The legacy `{displayName} · My Chord`
  naming self-heals on read.
- **Phone number** is an attribute, not an identity (ADR 0064) — verified E.164 via
  SMS OTP, used for deterministic contact discovery (ADR 0065). Google stays the
  login and calendar anchor.
- **Account deletion** (ADR 0043) — `DELETE /api/v1/me` tears down solo-owned data,
  best-effort revokes Google, keeps and anonymises shared groups, and reassigns
  ownership of files to a remaining member.

## Surfaces

The mobile app (iOS / Android / web from one Expo codebase) has five top-level tabs:

| Tab | Route | What it is |
|---|---|---|
| **Email** | `/email` | Attention-weighted map of the mailbox (ADR 0068) |
| **Chats** | `/groups` | Group + personal chats |
| **To Do's** | `/catchup/[tab]` | Everything Chord has filed for you (ADR 0070) |
| **Calendar** | `/calendar` | Day / week / month, two-way synced (ADR 0040) |
| **Settings** | `/settings` | Five sections of collapsed cards (ADR 0078) |

The label is "To Do's" but **the route is still `/catchup/*`** — renaming it would
break the in-app links ADR 0059 emits.

### Inside Claude and ChatGPT (ADR 0335)

Chord is also a remote MCP connector (`/api/mcp`, OAuth 2.1 with Chord as the
authorization server). A user connects it from Claude or ChatGPT, approves it on
Chord's consent page (`/connect`), and can then ask that assistant about their
mail, to-dos, lists and calendar. Anything it wants to change (an event, a to-do,
a list item, a reply, Trash, unsubscribe) waits in Action Items as "Suggested by
<app>" until the user confirms it in Chord. Disconnect in Settings → Connected AI
apps or by telling Chord. Off unless `MCP_CONNECTOR_ENABLED`.

## Chat

- **Groups** — multi-person chats; others join by 6-char invite code or a shareable
  `/join/<CODE>` link that survives the Google redirect (ADR 0047), deep-linking
  into the app when installed (ADR 0048).
- **Personal chat** — a one-member group. Chord always replies here.
- **Messages** — text + optional `attachmentId` / `replyToId`.
- **SSE stream** per group (ADR 0002) delivers new messages, bot acks, and resource
  updates live. Streams park on backgrounding and reopen on foreground (ADR 0082).
- **Bridges** — Telegram, WhatsApp (Twilio), Slack, and Discord connectors mirror an
  external group into a Chord group, so relatives never have to install anything.
  Each self-disables when its credentials are absent.

## Bot (`@Chord`)

The bot is an implicit member of every group, not a user row.

- **Gating** — personal chat: always. Shared group: on `@chord` (case-insensitive,
  word-boundary; aliases via `BOT_MENTION_ALIASES`), plus a **follow-up window** —
  after a mention it answers the group's next `BOT_FOLLOWUP_TURNS` (default 3)
  messages from any member without a re-mention (ADR 0051).
- **Context per turn** — system prompt, attachment summaries selected by pinned
  status + keyword retrieval, a recency-aware message window (3-day cutoff with a
  20-message floor, time-gap separators, anchored on the triggering message —
  ADR 0035), the group roster with the sender marked `(you)` (ADR 0007), and
  relevant memory rows. Scope is strictly per-group (ADR 0004, enforced twice by
  ADR 0032: SQL pre-filter + result scrubber).
- **Quiet mode** (ADR 0022) — tokens are buffered, not streamed. A turn opens with
  `bot.start`, then lands either as a silent `bot.receipt` (directive turns produce
  no chat bubble — the tool result card is the feedback) or a single `message` +
  `bot.done` (Q&A turns).
- **Providers** — `LLM_PROVIDER` is one of `openai` (also covers Ollama / vLLM via
  `OPENAI_BASE_URL`), `anthropic`, `gemini`, or `mock`. All three real providers use
  native function-calling in an iterative loop (ADR 0005); the text-fence protocol
  (ADR 0003) survives only as the fallback for providers without native tool
  support — `mock`, and text-only Ollama / vLLM behind the OpenAI shim.
  `LLM_PROVIDER=mock` runs the whole flow with no API key.
- **BYOK** — users can supply their own key. A failing key never silently falls back
  to the system key; the error is classified (auth / credit / transient) and
  surfaced (ADR 0044).

## Tools

**48 tools** today — the registry is `services/bot/tools.ts`; both protocols validate
against the same zod schemas. Grouped roughly:

| Area | Tools |
|---|---|
| Tasks & lists | `create_task`, `update_task`, `complete_task`, `list_tasks`, `add_list_item`, `get_list`, `rename_list` |
| Calendar | `create_event`, `update_event`, `delete_event`, `find_events`, `find_conflicts`, `get_event_status`, `record_rsvp`, `import_calendar` |
| Saves & references | `save_link`, `save_place`, `save_media`, `save_contact`, `search_saves`, `lookup_contact` |
| Trips | `create_trip`, `add_travel_leg`, `set_leg_passenger`, `set_trip_passengers`, `add_accommodation`, `add_reservation`, `get_trip_status` |
| People & memory | `add_person`, `update_person`, `add_important_date`, `list_people`, `get_contact_info` (a one-name lookup in the asker's phone Contacts first, saved People as fallback, ADR 0212), `list_memories` |
| Email | `set_email_route`, `list_email_routes`, `summarize_email`, `reply_to_email` (drafts only — see below) |
| Retrieval | `search` (unified, read-only, across every entity type — ADR 0059), `look_at_attachment`, `send_file` |
| Messaging & admin | `relay`, `message_user`, `suggest_external_action`, `rename_group`, `set_my_name`, `set_nudge_time`, `set_weather_location`, `start_form_fill`, `complete_form_fill` |

`search` results render as tappable cards that deep-link to the right screen
(ADR 0059). `send_file` re-posts the actual attachment — the bot never fabricates a
download URL (ADR 0036).

`reply_to_email` is the **only** tool that proposes rather than commits. Every other
write lands immediately, because a task or a list item is cheap to undo; a sent email
is not, and it leaves the building under the user's name. So the bot drafts and the
user taps Send (`chord_email.md` §3.4). It replies to the sender only — reply-all is
deliberately not expressible, since the draft card shows the text and not the
recipients.

Every tool execution broadcasts an SSE event so open views update live.

## Email

Gated by `GMAIL_ENABLED`. `GMAIL_PROVIDER=mock` serves a fixture mailbox so connect →
sync → reply run without credentials.

- **Multi-account** (ADR 0080) — `gmail`, `outlook` (Graph), and `imap`
  (Yahoo / AOL / iCloud via preset + app password), plus secondary Gmail mailboxes.
  The primary Gmail mailbox still lives on the user row.
- **Classification** — an in-repo LLM classifier (`EMAIL_CLASSIFIER=llm`) sorts
  threads into a two-level category tree, with deterministic sender routing for
  known senders that skips the LLM entirely (ADR 0066). Fail-closed on LLM error.
- **The AI view, four ways** (ADR 0068, reshaped by 0146/0147) — a chip picker
  under the Urgent Strip switches between **Feed** (every open decision as
  one urgency-ranked list — dated items soonest-first, then family-first /
  marketing-last), **Cards** (one expandable card per category), **Sections**
  (grouped by kind: To-dos / Events / Lists), and **Map** (the original
  attention-weighted treemap, still the only one with the per-category
  "current state" boards — delivery/flight/ledger rollups, ADR 0087/0135/
  0138). The choice is a per-device preference, not a single default.
- **Magic suggestions** (ADR 0063) — anything that looks like a commitment becomes a
  *proposal*, not a write. Proposals dock beside their email row, land in
  **To Do's › Action Items**, and are confirmed or rejected there. Calendar invites
  skip the LLM: the `.ics` is parsed deterministically and keyed on the invite UID
  so it reconciles with a Google-side accept in either order (ADR 0074).
- **Search** — the Email tab has a 🔍 that opens the ADR 0062 search modal pinned
  to mail. The engine was always there; it was reachable only from the personal 1:1
  chat. Reaches sent and archived mail (ADR 0108) and the text inside a message,
  not just its subject and preview (ADR 0110) — the sync now stores every body,
  which costs the same Gmail call it was already making.
- **Read state** — opening a thread marks it read (once per thread, so marking it
  unread again sticks); the action bar toggles read/unread.
- **Two calendars, one name** (ADR 0137) — the one you own wins; if it is a
  real tie, Chord asks which you meant instead of guessing and then
  quietly remembering the guess.
- **Events go to a calendar that exists** (ADR 0136) — when your phone
  mirrors a Google calendar under the same name, Chord writes to the
  Google one. A remembered choice is re-checked, so one bad pick cannot
  silently strand every later event in a group.
- **Mail can hand you a to-do** (ADR 0132) — an email with an obligation in
  it suggests a real task, with its deadline when the email states one —
  so it reaches the morning briefing and goes overdue where you can see it.
- **Formatting that survives** (ADR 0131) — **bold**, links and lists in a
  message, with a preview before it goes. A plain message is sent exactly
  as it always was.
- **Send as an alias** (ADR 0130) — if Gmail has verified you to send as
  another address, Chord offers it in the composer. Only verified ones,
  because an unverified alias is quietly sent from your own address.
- **Snooze** (ADR 0129) — put a thread aside until later today, tomorrow
  or next week, alone or a pile at once. A new reply wakes it early;
  reading it does not. Chord-only, and the folder says so.
- **Triage a pile of mail at once** (ADR 0128) — long-press to select,
  swipe left to archive (or Trash) and right to toggle read, and act on
  the whole selection. If some
  of it doesn't go through, it tells you which.
- **The AI stops reading the junk mail** (ADR 0127) — suggestions and
  people-facts are mined from your real mail, not from blasts. Anything
  that asks something of you, or comes from someone you know, is always
  read — so a school newsletter with a form in it still gets through.
- **Search the way you already type** (ADR 0126) — `from:`, `has:attachment`
  and date ranges, on both the app's search and the bot's.
- **Search trusts the classifier over a keyword match** (ADR 0152) — searching
  "school" no longer means "contains the string school"; if the word names one
  of your own AI-view categories, search shows that category's mail instead,
  catching a school email that never says "school" and dropping a promo that
  merely mentions it in passing. Falls back to plain keyword/body search when
  nothing classified matches.
- **Browse your labels** (ADR 0125) — derived from the mirror, so it works
  on any provider that has them and says so plainly on those that don't.
  A label reads across folders, because filing is labelling plus archiving.
- **A vacation reply on every mailbox** (ADR 0124) — Chord sends it, so
  Gmail, Outlook and IMAP all get one with no new permissions. It answers
  each person once, never a mailing list, and never marks your mail read.
- **Mail rules you can see** (ADR 0123) — the routing rules that decide
  which group a piece of mail belongs to are editable in Settings, not
  only sayable to the bot. They route; they deliberately do not file.
- **Rules learned from a correction** (ADR 0150) — after you route an
  email-derived to-do into a shared group by hand, one tap makes it a
  standing "mail from this sender → that group" rule. The rule only
  pre-selects the destination on the next such suggestion; nothing reaches
  a shared group without a confirm. The confirm card now always shows
  where ✓ will send.
- **Leaving a mailing list** (ADR 0122) — one Unsubscribe button that does
  the most it honestly can: a real RFC 8058 one-click where the sender
  supports it, an emailed request where they don't, and their own page
  where that is all there is. It never claims more than it did.
- **A thread does not repeat itself** (ADR 0121) — quoted history folds
  behind one tap, older messages fold to a line that shows who wrote and
  what they said, and the newest opens. Print on the web, Share on a phone.
- **Images do not phone home** (ADR 0120) — remote images are blocked until
  you ask for them, with a per-sender "Always" that holds on every device.
  Inline `background-image` is stripped too, which is the half most
  image blocking misses. Attachments the sender embedded still show.
- **The list scrolls, and says which mailbox** (ADR 0119) — keyset pagination
  through the Traditional list, a per-mailbox filter, and a chip on each row
  when more than one mailbox is attached.
- **Real push** (ADR 0118, off by default) — Gmail `users.watch`, Graph
  subscriptions and IMAP IDLE all nudge the same sync, so mail shows up in
  seconds rather than at the next poll. Polling still runs underneath: a
  broken subscription makes a mailbox slower, never broken.
- **New-mail notifications** (ADR 0117) — new mail pushes to your phone, on
  every provider, with its own toggle under Briefings & notifications. Read,
  archived and bulk mail stay quiet; one push per sync rather than one per
  message.
- **Every provider does the same things** (ADR 0116) — Outlook and IMAP mirror
  their Sent folder too, so Sent and Archive mean the same thing on any
  mailbox; attachments reach the knowledge base from all of them. Size
  limits stay per provider, because parity is what a mailbox can do rather
  than the smallest ceiling among them.
- **Undo send** (ADR 0115) — a sent message is held for a few seconds before
  it goes, with an Undo bar. The hold is the server's, so closing the app
  still sends it; undo puts the message back in Drafts, and so does a send
  that fails, carrying the reason.
- **Recipient autocomplete** (ADR 0114) — the composer completes from people
  you have actually corresponded with and from your own People entries. Never
  a global address lookup.
- **Drafts** (ADR 0113) — compose, reply and forward autosave what you typed
  (debounced, and again on the way out), so nothing is lost to a phone call.
  Chord keeps its own drafts rather than the provider's, which is what makes
  autosave cheap; the Drafts folder says so. A reply draft is keyed by its
  thread, so it is one draft however many sittings it takes.
- **Forward** (ADR 0112) — its own screen, since a forward is addressed to
  people who were never in the conversation: no threading headers, the original
  quoted under the standard block, an optional note. The original's files are
  fetched from the provider and travel with it — and a file that cannot be
  fetched refuses the whole forward rather than sending it thin.
- **Attachments on send** (ADR 0111) — compose and reply carry files on every
  provider. The request sends Chord attachment **ids**, so a picked file is
  uploaded into the personal group first and stays there afterwards, searchable
  and re-sendable. Size limits are per provider and refused before the message
  goes, never dropped silently.
- **Compose + reply** (ADR 0107 / 0069) — `POST /me/email/send` starts a new
  message on any connected mailbox (raw MIME on both Gmail paths, Graph
  `sendMail` on Outlook, SMTP on IMAP), with a From picker that appears only
  when more than one mailbox is attached. Reply / reply-all keep the
  Chord-managed signature and send `multipart/alternative`.
- **Folders** (ADR 0108) — long-press the Email tab for Inbox, Sent and Archive.
  A folder is a predicate over the labels the mirror already holds, not a second
  sync: Gmail's backfill lists all mail, so those threads were always there,
  hidden by one `is_archived = 0`. Drafts and Trash stay stubs on purpose. Only
  Gmail mirrors a whole mailbox, so on Outlook/IMAP Sent holds what Chord sent
  — the folder says so.
- **Managing stays in the provider** (ADR 0107) — trash, star, snooze,
  move and folders are the provider's job, so every thread carries a deep link
  out. Gmail links to the thread itself (through `#all/`, so archived mail
  resolves); Outlook and the IMAP presets link to the mailbox and say so; a
  custom IMAP host gets no button rather than a guessed one.
- **Reply** (ADR 0069) — full reply / reply-all with a Chord-managed plain-text
  signature; sends `multipart/alternative`.
- **Convergence** (ADR 0073) — archived and trashed mail disappears from the inbox
  listing and from every AI pass (ADR 0108 keeps it reachable from the Archive
  folder and from search); trashing a thread retracts its *pending* proposals
  (decided ones and created entities are never touched).
- **Attachments** (ADR 0071, `EMAIL_ATTACHMENTS_ENABLED`, default on) — real Gmail
  attachments are saved into the personal group through the normal upload pipeline,
  so extraction, FTS, and `send_file` all work on them.
- **User-declared routing** (ADR 0077) — "school email → family group" rules are
  consulted before the LLM matcher.
- **People extraction** (ADR 0076, `EMAIL_PERSONS_ENABLED`, default **on**) — mines
  non-bulk mail for people and family facts, surfaced as proposals; a user's
  first pass auto-writes up to 12 high-confidence people. Dogfood it against a
  real mailbox with `npm run dogfood:persons` (dry run by default —
  [`docs/tasks/persons-dogfood.md`](./tasks/persons-dogfood.md)).

## Calendar

- **User-owned event copies** (ADR 0040) linked by `ical_uid` and versioned by
  `sequence` — not group-owned. Two-way sync with last-write-wins on `updated_at`
  and tombstoned deletes.
- **Selectable target calendar**; `group_ids` (JSONB) controls which groups see a
  given event. Events under 5 minutes are free.
- **Unified calendar settings** (ADR 0072) — one list per calendar with a Block
  switch and a Mirror switch; Google-backed device calendars fold into their Google
  row so nothing imports twice. Apple EventKit availability flows through.
- **Reconnect nudge** (ADR 0042) — a once-per-disconnect deep-link card when a Google
  token dies; events created while offline still sync on reconnect.
- **Timezone anchoring** (ADR 0074) — a bare datetime always gets a real user's
  offset rather than assuming UTC.
- **Past dates are questioned, not written** (ADR 0100) — when the bot tries to
  create an event on a date that already went by, or to reschedule one
  backwards (a stale year, a weekday that passed), the write is refused and the
  bot reads the date back and asks. Ingest and calendar import still file
  history, and editing an already-past event's title or location is untouched.

## To Do's

Seven sub-tabs, **Action Items first** (ADR 0070):

| Sub-tab | Contents |
|---|---|
| **Action Items** | Pending proposals with `gmail:` provenance — confirm / reject, with an audit trail |
| **Tasks** | Tasks merged across every group, with who asked and where from. Due dates render on the row; items >48h past due mute and sink below live work. **Drop** (⋯ menu) retires one without claiming it was finished |
| **Lists** | Named lists; check / uncheck items |
| **Saves** | Links, places, media, notes; filterable by trip |
| **Trips** | Flights, stays, and per-leg passengers gathered per trip |
| **Finance** | Deliberate scaffold — not implemented |
| **Attachments** | Files across groups (`files` key unchanged; ADR 0037) |

## Attachments & retrieval

- Upload to a group; stored at `data/files/group/{gid}/{attId}/{filename}`.
- Extraction runs fire-and-forget: text-like formats read as UTF-8, PDFs via
  `pdf-parse`, up to 40 000 chars kept, plus a short LLM summary.
- **Postgres `tsvector` FTS** over filenames, summaries, and extracted text
  (ADR 0021 → 0038). No embeddings (ADR 0006).
- Pinned attachments are always injected into that group's bot context.
- Delete is path-aware — the disk file is unlinked only when no shared copy still
  references it (ADR 0037).

## Notifications & briefings

- **Push** (ADR 0054, `PUSH_ENABLED`) — Expo push mirrors the SSE hub, so nudges,
  bot replies, and new messages reach a group's members (minus the sender).
  Per-category toggles, quiet hours (briefing exempt), and per-group mute.
- **Daily briefing** at a user-configurable time (ADR 0034) — the day's events,
  what's due, and an attention-first email section appended to it (ADR 0072).
  To-dos decay rather than repeat: dated work retires itself a week past due
  and stale items collapse into one counted line, so the briefing can no
  longer read the whole backlog back every morning (ADR 0092).

## Billing

`BILLING_ENABLED` gates the whole surface; off by default.

- **A free token allowance, then the AI surface gates** (ADR 0079, 0325). Every
  account gets 10M free tokens once, counted from sign-up with no time limit
  (`FREE_TOKEN_ALLOWANCE`; it replaced the 30-day trial). Entitlement resolves
  BYOK → paid plan / family / grandfathered → free tokens. With nothing left, bot
  turns post a Settings nudge instead of an LLM turn and email AI passes skip — but the mirror, reader, and reminders keep
  working, and the daily briefing still arrives as a deterministic no-LLM teaser.
- **Stripe checkout without the SDK** (ADR 0075) — raw REST session-create plus a
  hand-rolled HMAC signature verify. Card-only; refunds and IAP deferred.

## Demo flows → what shipped

| Flow in the brainstorm | Today |
|---|---|
| 1 · Miami planning | Pinned PDFs in context; tool-created tasks, events, saves |
| 2 · Costco list + save restaurant | `add_list_item`; `save_link` with a trip label |
| 3 · Personal chat | Personal group auto-created; `save_place` / `save_media` / `save_contact` |
| 4 · Potluck RSVPs | `create_event` + `record_rsvp`. Reacting without an `@`-mention now works within the follow-up window (ADR 0051), but there is still no always-on silent tracking |
| 5 · Potluck status | `get_event_status` answers directly |

See [tasks/](./tasks/) for remaining work.
