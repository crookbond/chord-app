# 0029 — Inline-keyboard actions on Telegram (proposals + signup deep link)

**Status**: accepted
**Date**: 2026-05-16

## Context

Two flows post "tap to confirm" / "tap to sign up" prose to Telegram with
no actual affordance:

1. **Screenshot bundle proposals** (`content_classifier.ts:postBundleAnnouncement`).
   The mobile app renders confirm/reject pills under the announcement; in
   Telegram the user sees only the text "📎 I see N items — tap to confirm"
   with nothing tappable.
2. **Welcome-DM + in-group shadow signup notice** (`welcome-dm.service.ts`).
   The text instructs the user to sign up, but the URL is plain text the
   user has to long-press / copy.

Telegram has first-class support for inline-keyboard buttons:
`url` buttons (jump to a URL) and `callback_data` buttons (round-trip a
short payload back to the bot as a `callback_query` update). The TG
connector already renders URL buttons for `kind: 'action'` cards from
`suggest_external_action`, but `callback_data` is unimplemented and no
flow attaches action cards to the proposal or signup messages.

## Decision

Add a callback-button capability to the connector layer and use it for
the two flows above:

1. **`BotCard` gains an optional `callback` field**
   `{ verb: string; id: string }`. When set, the TG renderer emits a
   `callback_data` button with the payload encoded as `verb:id`. Cards
   that set `url` continue to emit `url` buttons (existing behavior). A
   card sets one or the other, never both.

2. **TG long-poll subscribes to `callback_query`** in addition to
   `message` / `my_chat_member`. A new handler decodes the payload,
   looks up the TG user's Chord identity, checks group membership, and
   dispatches to a verb-specific handler. Every callback ends with
   `answerCallbackQuery` (Telegram requires this to dismiss the spinner)
   carrying a short toast string.

3. **Two verbs at launch**:
   - `p+` — confirm proposal by id.
   - `p-` — reject proposal by id.

   Encoded as `p+:prop_abc12` etc. Two characters leaves >60 bytes for
   the id — well clear of Telegram's 64-byte cap, with room for longer
   id schemes later.

4. **Server-side wiring**:
   - `content_classifier.postBundleAnnouncement` attaches one `confirm`
     and one `reject` callback-button card per proposal as
     `message_cards` rows. The outbound publisher already loads those
     when mirroring to bound channels.
   - `welcome-dm.service.ts` (both `renderWelcome` and
     `renderShadowGroupSignupNudge`) returns prose **plus** a URL action
     card pointing at `SIGNUP_URL`. The render layer already turns
     URL action cards into TG buttons; we wire the cards through the
     connector send by passing them alongside the text.

5. **Stale-button handling**: when the underlying entity (proposal) is
   already resolved or expired, the callback handler still responds —
   we just route the resolution-state into the toast text. We do **not**
   edit the original message's reply_markup to remove the resolved
   button; that's a polish item for a follow-up ADR (requires storing
   `message_id` per TG-sent message, which we don't today).

6. **Auth model**: the TG user pressing the button must have a Chord
   identity (shadow or real) tied to the originating group via
   `group_members`. Strangers tapping buttons in groups they're not in
   get a "you're not a member of this group" toast. Shadow users **can**
   confirm proposals — they have a guest membership and proposals are
   group-scoped; this matches the in-app behavior where guest members
   can confirm.

## Alternatives considered

- **URL deep-link buttons that bounce to the Chord app for confirm/reject.**
  Works without any callback_query plumbing, but adds a context-switch
  for every action. Two-tap (open app, tap confirm) instead of one-tap
  loses most of the win. Reserve for cases where the action genuinely
  needs in-app context (today: none we know of).
- **Server-side mapping table for callback payloads** (token → action).
  Would let us run arbitrarily-long payloads under TG's 64-byte cap. Not
  needed at launch — both verbs fit in the budget directly — and adds a
  GC story (rows have to expire) we don't yet need. Adopt later if a
  verb needs richer arguments.
- **Edit the message's reply_markup on resolution.** Nicer UX (the
  resolved button greys out / disappears). Deferred because it requires
  the outbound publisher to track the `message_id` Telegram returned
  for each send — a real schema/migration story. Toast-on-stale covers
  the correctness gap in the meantime.
- **Per-platform card schemas** (Slack Block Kit, Discord components,
  TG inline_keyboard each with their own card kind). Premature
  generalization. The shared `kind: 'action'` card with `url` *or*
  `callback` fits TG cleanly today; Slack/Discord can extend the
  renderer when we actually ship those flows.

## Consequences

### What this commits us to

- **Callback handler is now part of the connector inbound surface.**
  Adding new verbs (memory accept/reject, RSVP yes/no/maybe, etc.) goes
  through the same path. Keep the verb registry small and well-named.
- **TG's 64-byte payload cap is a permanent constraint.** When we run
  out of space, build the server-side token table rather than truncating
  or smuggling state out-of-band.
- **Resolved-button polish is a known gap.** Tapping a resolved
  proposal's button shows a toast ("Already confirmed") instead of the
  button disappearing. File as a follow-up; don't fix piecemeal.
- **Outbound publisher must thread `cards` through on bot bundle
  announcements.** Today `content_classifier.postBundleAnnouncement`
  doesn't write `message_cards`; this ADR requires it to.

### What we explicitly do NOT do

- **No Slack / Discord button rendering yet.** When those connectors
  start carrying actionable bot prose, they'll need their own renderer
  branches — but the kernel-side `BotCard.callback` shape works
  unchanged (the renderer is what's per-platform).
- **No multi-verb composability** (e.g., `confirm+notify`,
  `confirm:silent`). One verb per tap.
- **No persistent callback audit log.** Telegram's callback_query
  records the user + chat in the update payload; we log the dispatch
  through Winston like any other action. A dedicated audit table is
  unjustified before we have a feature that needs it.
