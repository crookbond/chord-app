# ADR 0348 — An email card adds the meeting, and invites no one

**Status:** Accepted, 2026-11-19
**Amends:** ADR 0315 addendum (meeting cards carry invitees), ADR 0346 phase 5 (who sends)

## What happened

Prod, RudderStack mailbox, thread "Re: APAC plans for Rudderstack":

- 18 Nov, 19:05 UTC: Molly (the CEO's assistant) asked Jake: "Tuesday next week ... between 7:00 and 8:00 AM ET?"
- 18 Nov, 19:13: her invitation, "Jake Evans // RudderStack: APAC 2027", Tue 24 Nov 7:00 AM, arrived on the user's RudderStack calendar (guests: Sean, Jake, the user).
- 20 Nov, 01:52: Jake: "I have accepted the Tuesday invite."

From that last email Chord staged a card "APAC plans meeting with Jake", Tue 7:00 AM, to invite Jake, Molly and Sean ("who sends" unknown, so the card asked). The user tapped ✓ at 02:05, and Chord made its own event and sent everyone on the thread a second invitation to a meeting already on all of their calendars. The user deleted it.

## Causes

- **✓ sent invitations.** A meeting card's ✓ both added the event and invited everyone on the email (ADR 0315 addendum). When nobody had said who sends, the card's own line read "✓ sends yours". Adding a meeting to your own calendar and emailing other people are two decisions, and one tap made both.
- **The meeting already on the calendar did not stop the card.** Staging checks the ADR 0223 rule: same start and the same people, meaning every address on one side is on the other. Molly was on the card but not on her own invitation's guest list, so the two did not count as the same. The ADR 0346 meeting rule (core people, more than half shared, assistants left out) already called them the same. The card showed "✓ Already on your calendar" while still offering to create and invite.

## Decision

**Nothing from an email card is sent to anyone unless the user explicitly asks for it on that card.** In chat, the user asks in their own words, and that stays as it is.

- **✓ adds the meeting to the user's calendar only.** Confirming an email `create_event` card does not invite anyone. The card's invitees are only a suggestion (`confirmProposal` drops `invitees` and `whoSends` unless the confirm carries `sendInvites: true`). A call link is still added, since with no guests nobody is emailed.
- **Inviting is a separate box on the card**: "Also send invitations to Jake, Molly, Sean". It is unticked every time the card is shown and nothing remembers it (`ConfirmProposalRequest.sendInvites`). Only the app shows it. WhatsApp, Telegram and a typed YES add the meeting only, and the user can say "invite them" in chat afterwards.
- **The note after confirming says what happened**: either "Added ..., no invitations were sent; open it to invite ...", or the list of people the calendar invited.
- **A meeting already on the calendar gets no card.** Staging, the sweep over pending cards, and confirm all use the ADR 0346 rule (`meetingAlreadyOnCalendar` over `calendarFitFor`). A card whose meeting is already there is not staged, is withdrawn if it was pending, and adds nothing if confirmed anyway.
- Invitation cards (Yes/Maybe/No, ADR 0104) and change cards (ADR 0248/0343) are unchanged. Each of their buttons names the one thing it sends.

## Rejected

- **Keeping ✓ = invite and only fixing duplicate detection.** The next meeting the rule misses sends a second round of invitations again, and a tap that mails a list of people should say so on the button.
- **A second "Add and invite" button.** It sits next to ✓ and invites a mis-tap. A box the user must tick on purpose makes inviting a deliberate act.
- **Remembering the box.** One meeting's choice is not the next one's.
- **Matching on titles.** The two events had different titles; people and time are what identify the meeting.
