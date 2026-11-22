# 0296 — A card on WhatsApp is answered with a button or a word

- **Status:** Accepted
- **Date:** 2026-10-25
- **Amends:** ADR 0029 (IM inline actions), ADR 0053 §7 (WhatsApp quick replies), ADR 0248

## Context

A card the bot proposes in chat (send, forward or reply to an email, move to
Trash, unsubscribe, leave or delete a chat, delete messages, change plan, and
any tool staged in propose mode) is built in `proposeCardFor`
(`bot/executor.ts`) for the Chord app: its small print says "tap to send" or
"tap to confirm", and the app answers it from the stored proposal. The card
carried **no buttons**. The upload path (`content_classifier.ts`) did attach
`p+` / `p-` buttons, so screenshots worked on WhatsApp and Telegram, but chat
proposals did not.

So WhatsApp received, as plain text:

> Leave Soccer — proposed — awaiting confirmation (you stop receiving its messages · tap to confirm)

There was nothing to tap. A typed "yes" went to the model, which has no tool
that confirms a proposal, and the `@Chord confirm` shortcut exists only on the
app's message route. The only way to answer was to open the app. The same
gap applied to Telegram, whose renderer also only turned `kind: 'action'`
cards into buttons (a proposed email is an `email` card).

Two more things made it worse on WhatsApp:

- With buttons, the quick-reply body was the bot's prose alone, so the card's
  own text (the draft, the chat being left) would not have been shown above
  the buttons.
- WhatsApp sends at most three reply buttons in a session. Two proposals in
  one turn are four buttons, and the renderer fell back to plain text, where
  "tap" is wrong again.

## Decision

1. **Every staged proposal card carries its buttons**: a confirm button named
   for the action (`Send`, `Move to Trash`, `Unsubscribe`, else `Confirm`) and
   `Cancel`, as `p+` / `p-` callbacks. The app ignores `buttons`. The confirm
   word matches what the prompt tells the model to say ("tap Send when it
   looks right").
2. **The IM renderers read buttons from any card kind** and drop the app's
   "tap …" hint from the card's meta (`renderers/proposal-answer.ts`). On
   WhatsApp the card's text now goes above the buttons; a bare action card
   (whose title is already its button, the upload case) is not repeated.
   Telegram shows such a card's text line and a button row.
3. **When WhatsApp cannot carry the buttons**, the message ends with
   "Reply YES to confirm, or NO to cancel." (or "…all of these…" for several),
   added after the clip so a long message cannot cut it off.
4. **A typed YES / NO is an answer** (`connectors/reply-answer.ts`), checked in
   the inbound pipeline before a bot turn. It resolves the sender's OWN
   pending proposals in that chat that were staged after their previous
   message on the same app and within 30 minutes, one per bundle, through the
   same handler as a button press (so membership and per-tool rules such as
   ADR 0242's "only the asker" still apply). The reply is the same short
   result a button press gets. If nothing matches, the message goes to the
   bot as before.

Two other lines that reached WhatsApp were reworded: the upload announcement
("… in this screenshot. Want me to add them?") and the ADR 0248 change note,
which now says "Open Action Items in the Chord app to apply it" instead of
"Tap Apply in Action Items".

## Found alongside: leave / delete cards could never be confirmed

Testing a WhatsApp "yes" end to end showed that confirming a `leave_group`
or `delete_group` card failed everywhere, the app included, with "calling the
transaction method for a Transaction is not supported". `confirmProposal`
commits inside its own transaction and `leaveGroup` / `deleteGroup` opened a
second one (ADR 0259). The existing tests committed the tool directly and
never went through `confirmProposal`, so they passed. Both now reuse the
caller's transaction (`db.isTransaction`), the pattern `lists.service.ts` and
`trips.service.ts` already use, with tests that confirm through
`confirmProposal`. The other unguarded `db.transaction()` calls in services
(trip merge/move/share, phone, identity, pairing) are not reachable from a
proposal confirm.

## Consequences

- A WhatsApp or Telegram user can answer every chat proposal where they are.
- "Yes" right after a card is now taken as the answer and does not reach the
  model. A user who meant something else by "yes" within that window gets the
  card confirmed. The narrow rule (own cards, set off by their own last
  message on this app, 30 minutes) is what keeps that rare.
- A card staged in the app is not answered by a WhatsApp "yes", unless the
  user also wrote on WhatsApp just before the app staged it.
- The model's own prose can still say "tap"; with buttons present that is now
  true, and in the text fallback the YES / NO line follows it.
- English words only.

## Alternatives rejected

- **A WhatsApp list message** (up to 10 rows) for more than three buttons: a
  new interactive type on the Meta connector, untested against the live API,
  and Twilio would still need the text path.
- **Numbered replies** ("reply 1 or 2"): more to explain in a chat message for
  a case (two cards in one turn) that is uncommon.
- **Routing "yes" through the model with a confirm tool**: a model deciding
  which card a "yes" meant is the guess this avoids, and costs a turn.
- **Changing the app's card text**: the hint is true in the app; the IM
  renderers are where it stops being true.
