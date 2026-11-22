# CHORD — Product Specification v4.0

> WhatsApp-First · App-Complete · Account-Owned

> _Imported from `Chord_Spec_v4_concise.docx` (source docx is gitignored). Treat as **reference, not contract** — see [README.md](./README.md)._

| Field | Value |
| --- | --- |
| Status | Draft — Architecture Complete |
| Stack (account + web) | TypeScript · Next.js · PostgreSQL · Auth.js |
| Stack (WhatsApp) | TypeScript · WhatsApp Business API (Meta Cloud) |
| Stack (native app) | Expo + React Native (iOS, Android, Web) |
| AI layer | LLM + vector store (per-group namespace) |
| Primary daily interface | WhatsApp — the family's existing group |
| Account + rich UI | chord.app + native app |

# 1. Vision

Chord is a family coordination layer inside WhatsApp. Chord joins the family's existing group, listens passively, and responds only when explicitly invoked or when a document is forwarded. The chord.app web app and native app are where the family manages tasks, trips, lists, and documents.

> WhatsApp Business API cost constraint: every outbound message costs money. Chord is silent unless invoked. All rich UI — task panels, trip cards, list management — is in the app.

## Core Principles

- Account owns all data. WhatsApp is a command interface, not the data layer.
- Responds only when @Chord is used or a document is forwarded.
- One message per event. Never a follow-up series.
- Rich browsing and management is app-only.
- Groups are hermetic. No data crosses group boundaries.
- Tasks auto-archive. No manual housekeeping.

# 2. Three-Layer Architecture

| Layer | Technology | Job | Interaction frequency |
| --- | --- | --- | --- |
| Account + web | Next.js · PostgreSQL · Auth.js | Identity, group setup, member management, calendar, settings, full UI | Regularly — daily browsing |
| WhatsApp channel | WhatsApp Business API (Meta Cloud) | Receive messages; surface query answers and confirmations; ingest forwarded docs | Daily — quick queries only |
| Native app | Expo + React Native | Deep links, push reminders, full task/trip/saves UI | Optional — preferred mobile UI |

## 2.1 chord.app Routes

| Route | Purpose |
| --- | --- |
| /signup | Email + password or magic link |
| /onboarding | Name group, add members, connect WhatsApp number, connect calendar |
| /dashboard | Home: recent activity, task summary, trip status |
| /tasks | Full task panel — grouped by assignee |
| /trips | Trip overview — completeness, legs, accommodation, car rentals |
| /saves | Browse saved places — filter by location, status, person |
| /lists | Grocery, packing, custom lists |
| /memory | View and edit stored facts |
| /settings | Group config, members, email allowlist, external contacts |
| /invite/[token] | Accept group invitation |

## 2.2 WhatsApp Channel — What Chord Does

- Reads all messages passively for context and memory extraction.
- Responds only when @Chord is used or a document is forwarded.
- Sends one confirmation per event (task created, document indexed).
- Never responds to general family conversation.
- Rate limit: max 10 messages/hour per group, min 2s between messages.
- No proactive nudges via WhatsApp — app only.

## 2.3 Channel Capability Comparison

| Capability | WhatsApp | chord.app | Native app |
| --- | --- | --- | --- |
| Quick queries (@Chord) | Yes | No | Yes |
| Task creation | Yes — text confirm | No | Yes |
| Task panel (full UI) | No | Yes | Yes |
| Document ingestion | Yes — forward | Via email ingestion | Yes — direct attach |
| Deep links | No | No | Yes |
| Push reminders | No (24h window) | No | Yes |
| Trip completeness cards | Text only | Yes | Yes — visual |
| Lists (full UI) | Query only | Yes | Yes |
| Saves browsing | Query only | Yes | Yes |
| Settings / member management | No | Yes | Yes |

# 3. Identity & Accounts

Every user has an Account. WhatsApp phone number is a property of the account, not the account itself.

## 3.1 Signup Flow

| Step | Action | System behavior |
| --- | --- | --- |
| 1 | Open chord.app/signup | Email + password form or Continue with Google. |
| 2 | Submit email | Create account. Send verification email. |
| 3 | Verify email | Click link → account verified. |
| 4 | Name group | Pre-suggested '[Last name] family'. Creates Group record. |
| 5 | Add members | Name + role per person. Adults get invite link by email. |
| 6 | Connect WhatsApp | Enter WhatsApp number. Chord sends OTP via WhatsApp DM. Confirm → wa_phone stored. |
| 7 | Add Chord to group | User adds Chord's business number to their WhatsApp group. Chord confirms when detected. |
| 8 | Connect calendar | Google Calendar OAuth or Apple CalDAV. Optional. |
| 9 | Email ingestion | Auto-generated group address shown. Prompt to save it. |
| 10 | Done | Redirect to /dashboard. One welcome message to WhatsApp group. |

## 3.2 Persona Types

| Persona | Account? | WhatsApp? | chord.app? | Assignable? |
| --- | --- | --- | --- | --- |
| Adult (18+) | Yes — email | Yes — own number | Full | Yes |
| Teen (13–17) | Yes — parental consent | Yes — own number | Limited (no settings) | Yes |
| Child (under 13) | No — persona ref | No | No | Yes (adult relays) |
| Guest adult (18+) | Yes — invite link | Yes — own number | Scoped to group | Yes |
| Guest child | No | No | No | Yes (adult relays) |

# 4. WhatsApp Interaction Model

## 4.1 When Chord Responds

| Trigger | Behavior |
| --- | --- |
| @Chord [query] in group | Process query. One response message. |
| Direct message to Chord's number | Process as personal query. Respond in DM. |
| Document or image forwarded | Ingest. One confirmation with key facts. |
| Anything else | Silent. No response. |

## 4.2 Intent Types

| Intent | Example | WhatsApp output | App output |
| --- | --- | --- | --- |
| Retrieval | @Chord what time is the tutor? | Plain text + source | Streamed text + source card |
| Task creation | @Chord book Nobu Saturday | One-line confirm + 'View in app' | Confirm card + deep link |
| List query | @Chord grocery list | Top 5 + 'Full list in app →' | Full interactive list |
| Suggestion | @Chord what to do in Miami? | Top 2–3 saves + 'More in app →' | Saves cards |
| Completion | @Chord I booked the flights | 'Marked done — [task]' | Task auto-resolved |
| Where is | @Chord where is Ben? | One-line location answer | Location card + map |
| Memory write | Nolan is allergic to peanuts | Silent store | Silent store |
| Document ingested | PDF forwarded | Key facts — one message | Rich document card |

## 4.3 Response Rules

- One message per event — task + conflict + summary combined, never separate.
- If response exceeds 5–6 lines: one-line summary + 'Full details in app →'.
- Clarifying questions: two numbered options only, never open-ended.
- Source attribution inline: 'from: school calendar · 2d ago'.
- Undo affordance appended to every action: 'Reply wrong to undo'.
- Confidence ≥ 0.7: act immediately. < 0.7: ask binary clarification.

## 4.4 WhatsApp Commands

| Command | Action |
| --- | --- |
| @Chord tasks | Open task count by person + 'Full list in app →' |
| @Chord my tasks | Tasks assigned to sender |
| done | Mark last referenced task complete |
| reassign [name] | Reassign last referenced task |
| wrong / undo | Reverse last AI action (within 60s) |
| @Chord where is [name] | Location lookup |

# 5. Document Ingestion

| Entry point | How | WhatsApp message sent? |
| --- | --- | --- |
| WhatsApp forward | Forward PDF, image, or voice note to group or Chord DM. Business API downloads media. | Yes — key facts, one message |
| Email forward | Forward to group ingestion address (e.g. doe-family@chord.app). | No — silent |
| Calendar attachment | Auto-detected on calendar sync. | No — silent |
| Direct attach (app) | File upload in app UI. | No — visible in app only |
| URL in WhatsApp group | Scraped for place detection. | Only if place detected: 'Save [place]? Reply save' |

## 5.1 Auto-Summary Rules

| Doc type | Size | WhatsApp response |
| --- | --- | --- |
| Structured (flight, hotel, reservation, invite) | Any | Key facts in one message |
| Reference doc (handbook, policy, contract) | < 20 pages | Silent — 'Indexed: [title]' in app only |
| Any doc | >= 20 pages or >= 5MB | Silent during index. One message when done. |
| Image with useful text | Any | Key fields extracted — one message |
| Casual photo | Any | Silent — no response |
| Voice note | Any | Whisper transcription → NLP pipeline |

# 6. Task Management

## 6.1 Task Lifecycle

| Status | Meaning | WhatsApp signal |
| --- | --- | --- |
| open | Created, assigned or unassigned | One-line confirmation |
| active | Assignee acknowledged | Silent |
| done | Completed by action, doc, or statement | One quiet line |
| superseded | No longer relevant | 'Archived — [reason]' |
| archived | Auto-removed, always recoverable | Silent |

## 6.2 Auto-Archive Rules

| Condition | Action |
| --- | --- |
| Done — 7 days elapsed | Auto-archive silently |
| Open with due_at — 48h overdue | Flag stale — muted, bottom of list |
| Open with due_at — 7 days overdue | Auto-archive. In-app recovery prompt only. |
| Has action_url — 24h past due | Auto-archive |
| Has remind_at set | Never archive before reminder fires |
| No due_at | Never auto-archive |

## 6.3 LLM-Evaluated Completion

Completion is never keyword-matched. Every incoming signal triggers an LLM evaluation against open tasks. The LLM returns resolved, superseded, or still open based on intent — not word overlap.

| Signal | Outcome |
| --- | --- |
| 'I booked the flights' | Resolved — speaker + open flight task + context align |
| 'John picked up Nolan' | Resolved — attributed to John |
| 'We decided not to go to Miami' | Superseded — active Miami tasks archived |
| Delhi hotel confirmation, same March dates | Resolved + destination mismatch flag — one message |
| Flight confirmation PDF forwarded | Resolved silently, key facts surfaced |

## 6.4 live_until

Tasks referencing a future event get a live_until timestamp derived from the calendar at creation. Hard floor — task cannot auto-archive or be superseded before this date.

| Task | live_until derived as |
| --- | --- |
| Book spring break | End of spring break (from school calendar) |
| Plan the holidays | January 2 |
| Figure out summer camp | Camp end date |

## 6.5 Notifications

| Scenario | WhatsApp | App |
| --- | --- | --- |
| Task created | One confirmation | Badge on Tasks tab |
| Task auto-archived | Silent | Silent |
| Reminder fires | Only if within 24h conversation window | In-app nudge — always |
| Document indexed (structured) | Key facts one message | Source card inline |
| Proactive nudge (birthday etc.) | Never | Quiet in-app message |

# 7. Shared Lists

| List type | Description |
| --- | --- |
| Grocery | Shared shopping list. Items checked off when purchased. |
| Packing | Trip-scoped. Auto-generated from memory or manual. |
| To-do | Household chores and errands. |
| Custom | Any named list the family creates. |

## 7.1 WhatsApp Commands

- @Chord add [item] to [list] → 'Added milk to grocery list. 14 items now.'
- @Chord what's on the grocery list? → Top 5 + 'Full list in app →'
- @Chord remove [item] from [list] → one-line confirmation
- Full list management (reorder, bulk clear, archive) → app only

# 8. Trip Planning

| Entity | Scope | Key fields |
| --- | --- | --- |
| Trip | Group | destination, start_date, end_date, participants[] |
| TravelLeg | Per persona | mode, origin, destination, depart_at, arrive_at, carrier, flight_no, confirmation, source_doc |
| Accommodation | Group | property_name, address, checkin_date, checkout_date, room_count, confirmation |
| CarRental | Group | pickup_at, dropoff_at, pickup_location, car_class, confirmation |

## 8.1 WhatsApp Behavior

| Action | WhatsApp output |
| --- | --- |
| Flight confirmation forwarded | 'Indexed — AA 412 · JFK→SEA · Mar 14 · John, Alice, Ben. View trip in app →' |
| Hotel confirmation forwarded | 'Indexed — Kimpton Seattle · Mar 14–18. View trip in app →' |
| @Chord when does everyone arrive? | All arrival times, compact format |
| @Chord is Alice's flight booked? | Yes/no + flight details |
| Trip completeness check | App only — rich completeness card on dashboard |
| Hard conflict detected | One message: 'Heads up — [conflict]. Details in app →' |

## 8.2 Completeness Check

Runs on every new document added to a trip. Checks per participant: inbound leg, outbound leg, every night covered, airport transport, car rental overlap. Output: app card listing gaps only. WhatsApp message only on hard conflict.

## 8.3 Location Queries

| Priority | Source | Example response |
| --- | --- | --- |
| 1 | Active TravelLeg (in transit) | 'Ben is on AA 412 JFK→SEA, lands at 10:15 AM — ~45 min out.' |
| 2 | Active Accommodation | 'Ben is in Seattle — Kimpton through Thursday.' |
| 3 | Active calendar event | 'Ben should be in English class until 3:15 PM.' |
| 4 | Next calendar event today | 'Ben has soccer at 4:30 PM — nothing scheduled now.' |
| 5 | Fallback | 'I don't have Ben's current location. Open Find My? (app required)' |

# 9. Saves — Places & Wishlist

## 9.1 Entry Points

- URL in WhatsApp → place detected → 'Save [Place]? Reply save'
- Place mentioned → '@Chord save Oxomoco'
- Explicit 'save this' → works on anything in context
- Calendar event with venue → auto-detected, save prompt in app
- Hotel confirmation indexed → auto-creates Save, status: visited
- Maps link → place name + location extracted from URL

## 9.2 WhatsApp Queries

| Query | Response |
| --- | --- |
| @Chord restaurants saved in Miami | Top 3 with notes + 'Full list in app →' |
| @Chord what to do in Miami? | Top 2 saves + 'More in app →' |
| Reply 'save' to prompt | 'Saved [Place] · [auto-captured note]' |
| @Chord we went to Carbone | 'Marked Carbone visited. Add a note? Reply with one.' |

# 10. Memory

## 10.1 Scopes

- Persona — birthday, school, office, allergies, preferences, recurring commitments
- Group — home address, recurring places, traditions, routines
- Event — birthdays, anniversaries, school terms, recurring appointments

## 10.2 Extraction

| Source | Example | Confidence |
| --- | --- | --- |
| Passive chat | 'Nolan is allergic to peanuts' / 'Our office moved to 45 Park Ave' | High — silent |
| Document parsing | School calendars, lease, medical forms | High — silent |
| Explicit write | '@Chord remember Ben's dorm is 120 Morningside' | High — one-line confirm |
| Inferred from activity | Tutor every Tuesday on calendar | Low — confirmed on first use |

## 10.3 Privacy Rules

| Memory type | Group visible? | Reason |
| --- | --- | --- |
| Logistical facts (address, school, birthday) | Yes | Needed for coordination |
| Health and safety (allergies, medical) | Yes — always | Safety overrides privacy |
| Personal opinions and preferences | Never | Person's to express |
| Private DM query answers | Never | Private query = private answer |
| Group decisions made in this group | Yes | Shared group context |

> Groups are hermetic. Memory never crosses group boundaries even if the same user belongs to multiple groups.

# 11. Deep Links (App Only)

Tasks in the app carry an optional action button opening a native app with context pre-filled. User always has the final tap.

| Action | App | Pre-filled from |
| --- | --- | --- |
| Send a text | Messages / WhatsApp | Contact phone + pre-typed message |
| Request a ride | Uber | Pickup: home. Dropoff: persona address from memory |
| Search flights | Expedia / Kayak | Trip origin, destination, dates, passenger count |
| Make a reservation | OpenTable | Restaurant name, date, party size |
| Navigate | Apple Maps / Google Maps | Destination address |
| Call | Phone | Contact phone number |
| Compose email | Mail | Recipient, subject, pre-written body |

# 12. Backend

## 12.1 Infrastructure

| Component | Technology | Role |
| --- | --- | --- |
| Primary DB | PostgreSQL 16 | All structured entities |
| Vector store | Pinecone | Document embeddings, per-group namespace |
| Cache / queue | Redis + BullMQ | Rate limiting, session cache, async jobs |
| File storage | AWS S3 or Cloudflare R2 | Raw files, encrypted at rest |
| Email | Resend | Verification, invites, ingestion address |
| Auth | Auth.js (NextAuth v5) | Sessions, OAuth, JWT |
| Transcription | OpenAI Whisper | Voice notes → text |
| WhatsApp | Meta Cloud API | Inbound/outbound, media download, webhooks |
| LLM | Anthropic Claude (claude-sonnet-4-6) | Intent, retrieval, task extraction, memory |
| Embeddings | OpenAI text-embedding-3-small | Document chunking + semantic search |

## 12.2 Schema (abbreviated)

```
accounts (account_id, email, email_verified, password_hash, display_name, created_at)
wa_accounts (wa_id, account_id, wa_phone, waba_id, status, linked_at)
groups (group_id, name, ingestion_email, wa_group_jid, created_by, created_at)
group_members (member_id, group_id, account_id?, role, display_name, wa_phone?, wa_verified, parental_consent)
personas (persona_id, group_id, member_id?, name, role, is_managed)
tasks (task_id, group_id, assignee_id?, title, due_at, remind_at, live_until, status, completion_note, archive_reason, source, action_label, action_url, action_label_2, action_url_2, created_at)
lists (list_id, group_id, name, type[grocery|packing|todo|custom], trip_id?)
list_items (item_id, list_id, text, checked, checked_by?, checked_at?)
memories (memory_id, group_id, persona_id?, type, key, value, source, confidence, superseded_by?)
saves (save_id, group_id, name, category, location, url, saved_by, note, status, source)
trips (trip_id, group_id, name, destination, start_date, end_date)
trip_participants (trip_id, persona_id)
travel_legs (leg_id, trip_id, persona_id, mode, origin, destination, depart_at, arrive_at, carrier, flight_no, confirmation, source_doc_id?)
accommodations (accommodation_id, trip_id, property_name, address, checkin_date, checkout_date, room_count, confirmation)
car_rentals (rental_id, trip_id, pickup_at, dropoff_at, pickup_location, car_class, confirmation)
documents (doc_id, group_id, uploaded_by, filename, mime_type, storage_url, index_status, source)
document_permissions (permission_id, doc_id, group_id?, role_filter[all|adult_only], granted_by)
calendar_events (event_id, group_id, persona_id?, external_id, title, start_at, end_at, location, is_recurring)
external_contacts (contact_id, group_id, name, phone, email, notes)
wa_messages (message_id, group_id, sender_persona_id?, wa_message_id, direction, content_type, intent_fired, created_at)
```

# 13. Security & Privacy

| Area | Rule |
| --- | --- |
| Auth tokens | AES-256-GCM encrypted before DB write |
| Document files | S3 server-side encryption (SSE-S3 or SSE-KMS) |
| Passwords | bcrypt, cost factor >= 12 |
| Group isolation | Every query includes group_id filter. Vector store namespaced by group_id. |
| WhatsApp access | Chord only reads groups it was explicitly added to. Never forwards between groups. |
| User disclosure | Users informed at signup that Chord reads messages in groups where it is a member. |

# 14. Roadmap

## Phase 1 — Core (v1)

- chord.app: signup, onboarding, group management, member management
- WhatsApp Business API: webhook ingestion, @Chord invocation, document forwarding
- NLP pipeline: retrieval, task creation, completion, suggestion, memory write
- Document indexing: PDF, OCR, voice transcription, email ingestion
- Task management: create, assign, auto-archive, WhatsApp commands
- Lists: grocery, to-do, custom — WhatsApp add/query, full UI in app
- Memory: passive extraction, query answers, privacy enforcement
- Calendar: Google Calendar OAuth, event sync, attachment detection

## Phase 2 — Native App (v2)

- App pairing: link to existing account via phone number + OTP
- Rich task panel: grouped by assignee, all states
- Deep links: Uber, Expedia, Kayak, OpenTable, Maps, Messages
- Push notifications: task reminders, proactive nudges, birthday prompts
- Trip UI: completeness cards, conflict detection, participant view
- Saves browsing: filter by location, status, person
- Packing list auto-generation from trip + persona memory

## Phase 3 — Enhancements (v3+)

- Apple Calendar (CalDAV) and Outlook integration
- GPS live location → slots into 'Where is X?' lookup
- Live flight tracking → real-time position and ETA
- Level 3 deep links: Uber API, Twilio — full automation with user OAuth
- WhatsApp message templates for reminders outside 24h window
- Group chat mirror: app thread syncs bidirectionally with WhatsApp group

