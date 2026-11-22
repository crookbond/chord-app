# CHORD — Spec Addendum — Companion App

> Authentication · Personal AI Chat · Context Model · Mirror Roadmap

> _Imported from `Chord_Companion_concise.docx` (source docx is gitignored). Treat as **reference, not contract** — see [README.md](./README.md)._

# A. Authentication

## A.1 Two Auth Paths

| User type | Auth method | Credentials needed | Access granted |
| --- | --- | --- | --- |
| Group admin | Email + password or magic link at chord.app | Email used at signup | Full — group management, settings, billing |
| All other members | WhatsApp OTP | WhatsApp phone number | Group-scoped — personal AI chat, tasks, trips, lists. No settings. |

> Admin is the only user who needs an email account. All others authenticate via WhatsApp OTP only.

## A.2 WhatsApp OTP Flow

| Step | Action | Detail |
| --- | --- | --- |
| 1 | Enter phone number | E.164 format. Country code picker pre-selected from device locale. |
| 2 | OTP sent via WhatsApp | Chord Business API sends 6-digit code. Valid 10 minutes. Resend after 60s. |
| 3 | Enter OTP | Masked input. Auto-advance on 6th digit. |
| 4 | Backend verifies + links | Looks up all groups where this wa_phone appears. Auto-links if one match. Shows group selector if multiple. |
| 5 | Account created or linked | New account created with wa_phone as sole credential, or linked to existing account. |
| 6 | Land on dashboard | Direct to /dashboard scoped to their group. No onboarding wizard needed. |

## A.3 Auto-Link Outcomes

| Scenario | Behavior |
| --- | --- |
| Number in exactly one group | Auto-linked. User lands on that group's dashboard. |
| Number in multiple groups | Group selector shown. User switches groups later from app. |
| Number in no groups | 'Ask your admin to add you, or enter a group invite code.' |
| Number belongs to child persona (under 13) | Blocked. 'This account is managed by a parent.' |

## A.4 Session Management

| Scenario | Behavior |
| --- | --- |
| Session expiry (30d inactivity) | Re-verify via WhatsApp OTP. No password needed. |
| User changes WhatsApp number | Re-verify with new number. Admin updates wa_phone in settings. |
| Multiple devices | Same account active on multiple devices. Re-verify on each new device. |
| Admin revokes access | JWT invalidated immediately. 'You've been removed from this group' on next open. |
| Teen (13–17) | Same OTP flow. Parental consent flag checked at login — blocks if not set. |

> No-password design is intentional. OTP via WhatsApp is equivalent in security to email magic links and requires no new credential for the user to manage.

# B. Personal AI Chat

The app's primary screen is a private 1:1 conversation between the user and Chord. It is not a mirror of the WhatsApp group thread.

| It is | It is not |
| --- | --- |
| Private — only you and Chord | A copy of the WhatsApp group thread |
| Persistent — full history across sessions | A replacement for the family group chat (v3+ vision) |
| No per-message cost — richer responses allowed | Shared with other group members |
| Proactive — Chord sends nudges here | A notification inbox |

## B.1 Capabilities

### Query

- 'What's on my plate this week?' → your tasks + relevant group events
- 'When is my next flight?' → your travel legs across all trips
- 'What's left on the grocery list?' → full interactive list
- 'What time is Nolan's cello?' → group calendar lookup

### Manage tasks

- 'Add a task: call the insurance company' → task assigned to you
- 'Mark the expense report as done' → conversational resolution
- 'Remind me about the dentist tomorrow morning' → in-app reminder set

### Deep-linked actions

- 'Call an Uber to Nolan's school' → Uber pre-filled from persona memory
- 'Search flights to Seattle for the March trip' → Expedia pre-filled with trip dates

### Update memory

- 'Remember my new office is 200 Park Avenue' → persona memory updated
- 'Nolan's cello teacher moved to 44 West 77th' → group memory updated

## B.2 Context Scope

Rule: your things fully, shared things read-only, other people's private things never.

| Context type | Visible? | Example |
| --- | --- | --- |
| Tasks assigned to me | Yes — full | 'Submit expenses · due Friday' |
| Tasks I created (assigned to others) | Read only | 'Reserve Nobu · assigned to Alice' |
| Tasks assigned to others (not by me) | No | — |
| Trips I'm a participant in | Yes — full | Seattle trip · Mar 14–18 |
| Trips I'm not on | No | — |
| Group calendar events | Read only | Nolan's cello · Tues 4:30 PM |
| My personal calendar events | Yes — full | My dentist · Wed 2 PM |
| Shared lists | Yes — full | Grocery list · 14 items |
| Group memory (addresses, allergies) | Yes — full | Home: 45 Riverside Dr |
| My persona memory | Yes — full | My office: 45 Park Ave |
| Others' persona memory | Logistical only | Ben's school — not his preferences |
| Others' private AI queries | Never | — |
| Saves (group wishlist) | Yes — full | Saved places for Miami |

## B.3 Personal vs WhatsApp @Chord

| Dimension | @Chord in WhatsApp | Personal AI chat |
| --- | --- | --- |
| Audience | Whole group | Private |
| Per-message cost | Yes | No |
| Response richness | Plain text + one link | Cards, deep links, interactive lists, maps |
| Proactive messages | Never | Yes — reminders, nudges, trip gaps |
| Response length | Truncated at 5–6 lines | Full detail |
| Conversation history | Lost as thread scrolls | Persistent, searchable |
| Follow-up questions | Never | Natural back-and-forth |
| Deep links | Not available | Full suite |

## B.4 Proactive Messages

| Trigger | Message | Push notification? |
| --- | --- | --- |
| Birthday 5–7 days out | 'Ben's birthday in 5 days — anything to plan?' | Opt-in |
| Task reminder fires | 'Reminder: Submit expenses · due today' | Yes — always (user-set) |
| Trip completeness gap | 'Seattle trip missing Nolan's return flight.' | Opt-in |
| Document indexed | 'Indexed lease renewal — renewal deadline Mar 1.' | No |
| Task auto-resolved | 'Marked Book Miami flights done — confirmation indexed.' | No |

> Max one unsolicited proactive message per user per day. Task reminders (user-set) are exempt from this limit.

## B.5 UI

- Home screen of the app — not a tab.
- Chord messages left-aligned. User messages right-aligned.
- Rich cards inline: task confirm, trip cards, save cards, deep link buttons.
- Tap any Chord message → source attribution tooltip.
- Input bar: text field + attach icon for direct document ingestion.
- History is persistent and searchable across sessions.

# C. Roadmap — Group Chat Mirror (v3+)

Long-term goal: the Chord app becomes the family's group conversation surface. Messages sent in the app appear in WhatsApp; WhatsApp messages appear in the app thread. One conversation, two surfaces.

> Parked for v3+. Requires solving message attribution — app messages appear in WhatsApp as 'John via Chord', not from John's own number. Product decision pending.

## What Changes in v3+

- App chat becomes a group thread — all members' messages visible.
- App messages mirrored to WhatsApp via Business API (attributed as 'via Chord').
- WhatsApp messages mirrored into app thread in real time via webhook.
- Chord's app responses are rich; WhatsApp version is plain text equivalent.
- Personal AI chat remains available as a separate tab.

> Strategic note: once the family's conversation history lives in Chord — searchable, driving tasks and memory — switching cost becomes very high. WhatsApp retains the messages; Chord retains the messages and the intelligence layer.

