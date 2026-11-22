# ADR 0022 — Quiet-mode bot replies: silent receipts for directives, instant bubbles for Q&A

**Status:** Accepted — supersedes the streaming half of [ADR 0003](./0003-text-based-tool-protocol.md).

## Context

Until this ADR, every bot turn produced a streaming chat bubble — tokens
trickled in via `bot.token` SSE events and the user's chat scroll-jacked
while Chord typed out replies like "Added 3 items to your Costco list".

The bubble is fine when the prose is the answer (e.g. *"What's on Friday?"*
→ a sentence). It is *flow-disrupting* when the user issued a directive:
they have already moved on, and the prose is structurally redundant with
the `bot.card` payload that already conveys the action ("Costco list ·
milk, bread, eggs").

The bot already knows post-turn whether any tool fired
(`bot.service.ts` — `anyToolsExecuted` / `toolNames`), but had no UI
affordance to suppress the bubble.

## Decision

Stop emitting `bot.token`. Buffer the LLM stream server-side and pick a
surface mode at end-of-turn:

| Surface | Trigger | Persist | SSE end signal | Client UX |
|---|---|---|---|---|
| `receipt` | ≥1 tool fired | `chord_visible=0` | `bot.receipt` | Tiny strip under user's trigger message: `└ ✓ Chord` + tool pills + cards. No bot bubble. |
| `visible` | no tool fired | `chord_visible=1` | `bot.done` + `message` | Normal bot bubble, rendered all at once at `bot.done` (no creeping animation). |
| `silent-bridge` | trigger was `chord_visible=0` (existing IM-bridge case) | `chord_visible=0` | none on Chord channel | Reply delivered via connector to the bridge; Chord SSE is inert (unchanged from prior). |

`bot.start`, `bot.tool`, `bot.card`, and `bot.sources` continue to fire
identically in receipt and visible modes — only the receipt vs bubble
*render parent* differs on the client.

The bot's prose still persists on the (invisible) `messages` row in
receipt mode, so the LLM has continuity for follow-up turns ("what did
you do?").

## Rejected alternatives

- **Compact bot row** (still a chat row, but rendered as a single muted
  line). Still adds a row; receipt strip is more flow-preserving.
- **Hold-and-coalesce** (delay the bot reply N seconds; if anyone posts
  again in the window, drop it). Race-prone in fast group chats.
- **Reaction-only on the trigger message** (✓ emoji, no card). Loses the
  card affordance which is genuinely useful (tappable trip, list items).
- **Per-user opt-out preference**. Worth revisiting if real users want
  streaming back; ship one default first.

## Consequences

- **Pro**: Directives don't scroll-jack. Q&A still gets a real bubble. No
  typewriter effect on either path.
- **Con**: Lose live "Chord is thinking…" streaming feedback. Mitigated
  by the fact that turns now finish in a few seconds at most; long turns
  could be revisited if needed.
- **Con**: If the LLM produces useful prose alongside a tool call (e.g.
  "Created the trip — but you don't have flights yet, want me to suggest
  some?"), the prose is dropped from chat. It still persists at
  `chord_visible=0` so the user can ask "what did you say?" to surface
  it. A future "Chord said more" expander affordance is the natural
  follow-up if this turns out to matter.
- **Wire compatibility**: `bot.token` is deprecated, not removed. Old
  clients still subscribed to it simply receive nothing.

## Verification

1. Manual: post `@Chord add to Costco list — milk, bread, eggs` in a
   group. No bubble; receipt strip appears under the user's message
   with tool pill + card. Then post `@Chord what's on tomorrow?` —
   normal bubble, no streaming.
2. `npm test --workspace=server` — `turn.integration.test.ts` covers
   both surface modes (receipt for directive, message+bot.done for Q&A).
3. Sim: `npm run sim --workspace=server` — `TurnCapture` now treats
   `bot.receipt` as a turn-end signal alongside `bot.done`. Pass rate
   unchanged.

## Addendum 2026-10-31: a card waiting for a tap is not a done write

Prod: a personal-chat "Unsubscribe from 12 lists" card could not be tapped
on web or phone. Staging a card counts as a tool run, so the turn took the
receipt path - but nothing had happened yet, the app draws the confirm
buttons only under a visible bot reply, and Action Items lists only cards
from email. The bot's note about two lists left off the card was hidden too,
and nothing reached WhatsApp (the forwarder sends `message` events only).

- A turn that leaves a card pending (a `pending` proposal with this turn's
  trigger as `proposed_by_message_id`) goes out as a **visible** reply
  (`leftCardWaiting` in `bot.service.ts`). Writes that already happened
  keep the receipt.
- The app also draws the confirm buttons in the receipt strip, so cards
  staged by turns before this change can be answered.
