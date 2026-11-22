# 0277 — Findings has its own chat

**Status:** Accepted, 2026-10-19. Amends ADR 0249 (how a Findings question is
answered).

## Context

ADR 0249 made each sample question on the Findings tab ("What am I paying for
every month?") post itself into the personal 1:1 chat and open that chat.
Two problems, both reported by the owner:

- **It is jarring.** One tap leaves the tab you were reading and drops you
  into a different screen, mid-conversation with everything else.
- **The answer is read against the wrong context.** The personal chat's last
  20 messages (reminders, trips, the morning briefing) are in the prompt, so
  a mail question competes with whatever was said there, and the answer then
  sits in that chat's history and colours later turns.

## Decision

- **The question is answered in the tab.** The chips and a text box sit in a
  small chat inside Findings (`mobile/src/findings-chat.tsx`). Follow-ups
  work; "New chat" clears it; leaving the tab ends it.
- **The client holds the conversation; the server stores nothing.**
  `POST /me/findings/chat` takes the whole conversation (at most 40 messages
  of 4,000 characters, last one the user's) and returns `{ reply, cards }`.
  No message row, no broadcast, no proposal. The model sees only that
  conversation, so the personal chat neither leaks in nor is added to.
- **Read-only mail tools only**: `query_mail_senders`, `query_receipts`,
  `list_subscriptions`, `search`, `read_email`, read under the personal
  chat's scope (ADR 0084/0246). A real write tool the model reaches for is
  refused as "not available here".
- **A change is handed to the personal chat, already specific.** For an
  unsubscribe, a to-do, an event or a reply, the model calls
  `hand_off_to_chat { request }`, a tool that exists only here (a "side
  tool", answered by the Findings service, not the executor). `request` is one
  first-person message that stands alone, because the chat bot never saw this
  conversation: the sender's name and address for an unsubscribe, the email's
  subject, sender and date, the to-do's title, date and amount. The response
  carries `handoff: { message }`; the app posts it to the personal chat AS
  THE USER and opens that chat, so the bot there acts on it at once (an
  unsubscribe still stages its confirm card, ADR 0246). The server posts
  nothing itself, so the message is the user's and appears exactly as sent.
  One hand-off per turn; the model says it is taking them there, never that
  it is done.
- **The same tool loop as the chat.** `runSideChatTurn` in `bot.service.ts`
  runs `runNativeLoop` / `runTextFenceTurn` with two new turn options:
  `onlyTools` (offered and run), `quiet` (no SSE) and `sideTools` (offered and
  answered by the caller; on the text-fence path their fences are taken out
  before the parser, which drops unknown names). The prompt is its own:
  persona line, local time, the ADR 0246 mail recipes, and the fence catalogue
  for providers without native tools.
- Same gate and meter as the other AI surfaces: entitlement → 402, tokens
  recorded as `bot_turn` unless BYOK (ADR 0196), a fixable BYOK failure says
  so (ADR 0044).
- Cards the tools return (an email, a receipt) are shown under the answer and
  open in the app (`href`) or the browser (`url`).

No new bot tool: this adds a place to ask, not a new capability — the same
questions already work in the personal chat.

## Consequences

- A Findings conversation is gone when the tab is left or the app restarts.
  That is the point (no corrupted context), and nothing in it needs keeping:
  every answer is recomputed from the mailbox.
- Asking for a change leaves Findings for the personal chat, on purpose: that
  is where confirm cards live and where the result belongs. The hand-off
  message is the only thing that crosses over.

## Rejected

- **Keep posting to the personal chat, but don't navigate.** Fixes the jump,
  not the shared context, and the answer would land unseen.
- **A hidden second chat group per user.** Persisted history nobody asked
  for, and dozens of places treat `kind` as personal-or-shared.
- **Allowing the write tools here too.** A proposal needs a chat message to
  hang its card on; read-only keeps this surface simple and honest.
- **Handing over the whole Findings conversation.** It would bring back the
  mixed context this ADR removes; one specific message carries what is needed.
- **The server posting the hand-off.** The app posting it as the user reuses
  the ordinary send path and bot turn, with nothing new to keep in sync.

## Addendum 2026-10-30: a hand-off names only real addresses

Prod: the hand-off asked to leave twelve mailing lists, each named with an
invented `name@example.com` address, and the chat could match none of them.
The hand-off is posted as the user and acted on at once, so `hand_off_to_chat`
now refuses (`handedOff: false`, `unknownAddresses`) a request naming an
address that the user did not type in this conversation and that is not a
sender or recipient in their own mail; the model is told to copy
`senderEmail` from `list_subscriptions` or give the name alone, and tries
again. An assistant message in the conversation does not count as a source:
it is where an invented address would come from. Side tools may now be async.

## Addendum 2026-11-01: a hand-off waits for a tap

An audit found the hand-off could run an email's words as the user's own
request: Findings reads mail (`search`, `read_email`), so an instruction
inside an email can be copied by the model into `request`, and the app
posted that text to the personal chat as the user with no tap, where the bot
acted on it at once. The address check (2026-10-30) limits WHERE such a
request can point, not WHETHER it runs. Now the app shows the hand-off in the
Findings chat as a card with the exact message and **Send to chat** /
**Cancel**; only Send posts it (as the user) and opens the chat. The server
still only returns `handoff: { message }` and posts nothing; the tool tells
the model `sent: false` and that nothing has been sent, and the fallback
reply asks for the tap. The address check is unchanged.
A side tool that throws now answers the model with the fixed ADR 0102
failure sentence (logged at error) instead of ending the Findings turn.
