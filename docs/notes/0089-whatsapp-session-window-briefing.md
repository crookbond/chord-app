# ADR 0089 — The briefing survives WhatsApp's 24-hour window

- **Status:** Accepted
- **Date:** 2026-08-20
- **Supersedes / extends:** ADR 0053 (WhatsApp connector), ADR 0034 (nudge time)

## Context

WhatsApp only lets a business send free-form text inside a **24-hour session
window**, which opens when the *user* messages the business and closes 24 hours
after their last message. Outside it, the only thing Meta will deliver is a
pre-approved **template**.

Chord's daily briefing fires at the user's `nudge_hour` (ADR 0034, default
07:00) and is delivered by writing a `messages` row that
`outbound-publisher.ts` mirrors to every bound channel. For a WhatsApp binding
that is free-form text — so for any user who has not written to the bot in the
previous 24 hours, **the briefing is undeliverable by construction**. A morning
briefing is precisely the message most likely to fall outside the window: it is
scheduled, unprompted, and the user's last reply was probably yesterday.

This is not hypothetical. Production has been failing every outbound WhatsApp
send since 2026-07-21 (Twilio 63007, unregistered sender), and even once the
sender is registered the briefing would still fail for anyone outside the
window. Worse, it would fail *silently*: Twilio returns a valid `SM…` SID, so
Chord logs a success and the user simply gets nothing.

There is no existing signal to decide any of this. Nothing records when a user
last messaged us on a channel, so the window cannot be computed at all.

## Decision

**When a proactive message would go to a WhatsApp binding whose session window
is closed, send an approved quick-reply template asking whether the user wants
their briefing, and hold the briefing until they answer.**

Concretely:

1. **Track the window.** `group_external_channels` gains `last_inbound_at`,
   stamped on every inbound message from that channel. The window is open when
   it is within 24h. This is a column rather than a derived
   `MAX(messages.created_at)` because the publisher consults it on *every*
   broadcast, and because a button tap is not a `messages` row (see §4) yet
   must still open the window.

2. **Gate proactive sends only.** A reply is always in-window by definition —
   the user just wrote. Only messages with `is_proactive = 1` are gated, so the
   ordinary conversational path is untouched and pays one extra column read.

3. **Ask, once.** Window closed and not yet asked → send the approved template
   with two quick-reply buttons, stamp `nudge_prompt_sent_at`, and park the
   briefing's message id in `pending_briefing_message_id`.

4. **Answer.** The buttons carry the ADR 0029 `verb:id` payload, so they route
   through the existing callback dispatcher rather than the LLM:
   - `n+` → the tap *is* an inbound event, so the window is now open. Deliver
     the parked briefing and clear it.
   - `n-` → set `briefing_opted_out = 1` and drop the parked briefing.

5. **Opt-out is channel-scoped.** `n-` stops WhatsApp delivery only;
   `users.nudge_enabled` is untouched, so the briefing still arrives in-app and
   by push. Meta requires honouring an opt-out on the channel it was given on;
   it does not require us to read "no thanks, not on WhatsApp" as "delete my
   morning briefing everywhere". A single mis-tap should not silently kill a
   feature the user still sees in the app, and Settings remains the one place
   that turns the briefing off wholesale.

6. **Silence means stop.** If the template goes unanswered, we never ask again
   — until the user writes to the bot of their own accord, which both reopens
   the window and clears `nudge_prompt_sent_at`. Every template send is a
   billed business-initiated conversation, and a daily unanswered prompt reads
   as spam. Re-engagement is the user's move to make.

## Consequences

**A briefing can now be a day late.** If the window is closed at 07:00 and the
user taps Yes at 18:00, they get the morning's briefing in the evening. Sending
a *fresh* one instead would mean re-running the whole scan on a button tap; the
parked message is already rendered and is what they were promised. It is
stamped with its own time, so a stale one reads as stale.

**Opt-out is invisible in the app.** `briefing_opted_out` lives on the channel
binding, not on `users`, so Settings' briefing toggle will show "on" for a user
who has muted WhatsApp. Surfacing it belongs with the connector settings work
and is deliberately not in this slice.

**The template is a hard external dependency.** Nothing here can be exercised
end-to-end until Meta approves both the business and the template, which is why
the send path degrades to a logged skip when `TWILIO_NUDGE_TEMPLATE_SID` is
unset rather than erroring. Tests drive the mock connector.

**Only WhatsApp has this constraint.** Telegram, Slack and Discord have no
session window, so the gate is keyed to `platform === 'whatsapp'` rather than
generalised. If another platform ever adopts one, the state columns are already
per-binding and the gate is one function.

## Alternatives considered

**Send the briefing as a template every day.** Templates cost per conversation
and must be pre-approved with fixed variable slots — a briefing is free-form
prose of unbounded length and shape, so it cannot be a template without being
gutted into a stub. Rejected.

**Derive the window from `messages`.** `MAX(created_at) WHERE source =
'whatsapp'` avoids a column, but costs an indexed scan on every broadcast
app-wide, and misses button taps, which are not messages. Rejected.

**Ask every morning until answered.** Simple, but each send is billed and an
unanswered daily prompt is exactly the pattern Meta's quality rating punishes.
Rejected in favour of asking once.

**Treat `n-` as a global unsubscribe.** Honest to the words on the button, but
it lets one tap on a phone disable a feature the user is actively using in the
app, and there is no in-app affordance that would explain why the briefing
stopped. Rejected; see §5.

## Addendum (2026-08-21) — the rejected alternative, revisited

**ADR 0091 reverses this ADR's rejection of "send the briefing as a template".**

The reasoning above is still correct on every factual point: templates are
billed per conversation, must be pre-approved with fixed slots, and a briefing
is unbounded prose that cannot survive being poured into them. What was wrong
was treating "gutted into a stub" as disqualifying. A stub of five *true* lines
plus links is a better message than a bare "want your briefing?", and it costs
the same single conversation.

What changed and what did not:

- **Changed:** the content of the one out-of-window send. It now carries
  deterministic facts (weather / this week / heads-up / tasks / email) built by
  `services/briefing/facts.ts` — a sibling of the briefing, not a parse of it,
  since the sections here come from a prompt rather than from code.
- **Unchanged:** §3's ask-once rule, §5's channel-scoped opt-out, §6's "silence
  means stop", the parked-briefing machinery, and `gateProactiveSend` itself.
  The `n+` button is now labelled "Full briefing" and still delivers the parked
  text for free.
- **Fixed:** §"Opt-out is invisible in the app" — Settings now lists bound
  channels with a mute switch, which is also the first way back from `n-`.
- **Fixed:** the `n+` delivery passed no `moreUrl`, so a briefing over
  WhatsApp's 1600-char cap was clipped to a bare `…` with nowhere to go.

## Addendum (2026-08-25) — the ask expires

**§6's "silence means stop" was right about the cadence and wrong about the
duration.** Production, 2026-08-25: of five bound WhatsApp channels, exactly
one was out of window at its nudge time, and it was skipped —
`whatsapp: proactive send skipped reason=already_asked`. The template had gone
out on 24 Aug, carried the day's facts (ADR 0091), and was never tapped. Under
§6 that one unanswered ask silences the channel until the user writes to the
bot of their own accord. The parked briefing from 24 Aug was still sitting in
`pending_briefing_message_id` a day later, and the user's own reading of it was
that the briefing had stopped working.

What §6 was actually protecting is Meta's quality rating and the per-conversation
bill, both of which are about *frequency*. "Never again" is not the only way to
be infrequent, and it fails in the one case that matters most: a user who is
reachable, opted in, and simply does not tap buttons gets nothing, forever,
with no signal on either side that anything is wrong. Silence from the user is
weak evidence — it is equally consistent with "not interested", "did not see
it", and "meant to and forgot".

**Decision: an unanswered ask silences the channel for `WHATSAPP_NUDGE_REASK_DAYS`
(default 7), not for good.** `gateProactiveSend` treats a `nudge_prompt_sent_at`
older than that as if it were null, so the next closed-window morning asks
again. Weekly is one billed conversation per channel per week in the worst
case — the same order as a single active day of conversation, and far from the
daily prompt §6 rejected.

What changed and what did not:

- **Changed:** §6 only. `already_asked` is now bounded by the ask's age
  (`askExpired` in `whatsapp/session-window.ts`).
- **Unchanged:** everything §6 shares a code path with. A user who writes back
  still clears the stamp immediately (`recordInbound`), `n-` is still sticky and
  channel-scoped, and an *answered* ask is not re-asked — only silence expires.
- **Fixed in passing:** the stale park. A re-ask calls `markPrompted` with the
  new briefing, replacing a `pending_briefing_message_id` that would otherwise
  hand back a week-old morning on a late tap.

An unparseable `nudge_prompt_sent_at` counts as expired. The alternative reads
a corrupt write as a recent ask and mutes the binding permanently on a value
nothing can interpret or rewrite; expiring it means the next prompt overwrites
it with something readable.

`WHATSAPP_NUDGE_REASK_DAYS <= 0` restores the original ask-once-forever
behaviour, mirroring `WHATSAPP_TASTER_TURNS <= 0`.

**Alternatives considered.** *Deliver the parked briefing on the next inbound* —
the user wrote at 13:11 the next day, which reopened the window, so the parked
text could simply have gone out. ADR 0099 rejected this and still does: a user
who writes about something else has not asked for their briefing, and by then
it is yesterday's. *Escalate the interval* (7 days, then 14, then never) —
defensible, but it encodes a confidence in the silence signal that the evidence
above says we do not have, and it needs state this ADR does not otherwise
require. *Re-ask daily* — still rejected, for §6's original reasons, which the
weekly bound preserves.

## Addendum 2026-11-14 — "Full briefing" means today's

The prompt goes out at most weekly, so the briefing parked behind its
`Full briefing` button can be days old when it is tapped, and the tap
delivered it as-is: a user who answered after a few days of silence got the
day the prompt was sent. `claimPendingBriefing` now compares the parked
briefing's day with today in the user's zone (`last_tz`, else
`BRIEFING_DEFAULT_TZ`, ADR 0098). Same day: delivered as before. Older:
today's posted `daily_morning_scan` in that chat is delivered instead, and
when none was posted today the tap runs one (`runDailyScanForUserNow`, the
same function as `send_briefing`, ADR 0099) in the background; it posts to
the personal chat and the outbound publisher forwards it, since the tap
reopened the window. A binding on a chat other than the owner's personal
chat cannot receive a fresh briefing and keeps the parked one. A tap with
nothing parked still answers "all caught up".
