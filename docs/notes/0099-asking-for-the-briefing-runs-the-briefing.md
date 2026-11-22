# 0099 — Asking for the briefing runs the briefing, and a rejected template says so

**Status**: accepted
**Date**: 2026-08-23
**Relation**: repairs two holes exposed by the same incident —
[0089](./0089-whatsapp-session-window-briefing.md)/[0091](./0091-briefing-as-a-whatsapp-template.md)'s
out-of-window template path failing silently, and the briefing having no
on-demand entry point at all. Delivery posture follows
[0036](./0036-bot-sends-files-not-links.md); scope follows
[0004](./0004-group-scoped-agent.md)/[0096](./0096-personal-chat-reads-across-groups.md);
the per-turn cap reuses [0093](./0093-ordinal-references-to-enumerated-tasks.md)'s mechanism.

## Context

A user's 07:00 WhatsApp briefing did not arrive. Production, 2026-08-23:

```
11:00:54Z  briefing generated and posted to her personal group
11:00:56Z  whatsapp cloud send failed: 404 (#132001)
           Template name does not exist in the translation
```

Her window had been shut for ~37h, so [0089](./0089-whatsapp-session-window-briefing.md)
correctly switched to the approved template — and Meta refused it. The template
`daily_briefing` is approved in `en`; the deploy was configured
`META_NUDGE_TEMPLATE_LANG=en_US`. That is a one-word config error, and it is
not what this ADR is about. Two things around it are.

**The failure was invisible.** `sendBriefingTemplate` throws into the
publisher's generic per-binding `catch`, which logs `connector send failed` at
**warn**. Nothing distinguished a mis-configured template from any other
transport hiccup, so it ran for two days across two numbers before a user
reported it. Because the throw lands before `markPrompted`, nothing was parked
and no prompt arrived: from her side the briefing simply did not exist.

**Then she asked, three times, and it still did not work.**

| she wrote | she got |
|---|---|
| "Just briefing" | "No open tasks for now. Your briefing is clear!" |
| "Now send me a briefing" | "You have dinner at Elea tonight at 9 PM." |
| "My daily brifing" | "…no events scheduled. Your only open task is USPS package LH27" |

None of those is the briefing. The tool registry has `set_nudge_time`, which
*schedules* a briefing, and nothing that runs one; `runDailyScanForUserNow`
exists but is wired only to a demo route. So the model had no tool to call and
assembled something briefing-shaped out of context instead.

That last part is the worst of it. A briefing *sounds* like something a model
can improvise, so the improvisation is indistinguishable from the real thing to
the person reading it. A missing tool that produced an obvious error would have
been reported on day one.

## Decision

### 1. `send_briefing` — asking for it runs it

A new tool that runs the user's real briefing now.

**It posts, it does not return prose.** The tool calls
`runDailyScanForUserNow`, which renders and posts the briefing through exactly
the path the 07:00 scheduler uses, and returns only a short confirmation for
the model. The model is told not to restate or summarise it. Same posture as
[0036](./0036-bot-sends-files-not-links.md): the bot delivers the artifact
rather than a description of it. One renderer also means an on-demand briefing
cannot drift from the scheduled one — a second implementation would.

**Personal 1:1 only.** A briefing is a cross-group personal digest; rendering
one into a shared group would publish another member's private items into a
room they never chose. `isPersonalTurn` already draws this line for the
[0096](./0096-personal-chat-reads-across-groups.md) read tools.

**At most once per turn.** The [0005](./0005-iterative-tool-use.md) native loop
runs up to `MAX_ITERATIONS` (20), and each briefing costs an LLM scan plus a
mailbox sync — an unguarded tool could fire twenty of them from one sentence.
The allowance is keyed on `turnId`, the mechanism
[0093](./0093-ordinal-references-to-enumerated-tasks.md) already established.

### 2. A rejected template fails loudly and does not spend the ask

`sendBriefingTemplate` catches its own send failure, logs at **error** naming
the template, the language, the provider and the channel, and returns.

**Error, not warn, and its own message.** The whole cost of this incident was
diagnosis time: the signal existed but was shaped like routine noise. The log
line now says what to change.

**It does not `markPrompted`.** `nudge_prompt_sent_at` means "we asked and they
did not answer", which [0089](./0089-whatsapp-session-window-briefing.md) §6
reads as permission to stop asking forever. We did not ask. Recording that we
had would turn a config error into a permanent silent opt-out — the worst
possible reading of a failed send.

**It does not park the briefing either.** Parking is only useful when a prompt
carrying the `Full briefing` button actually arrived; with no prompt there is
nothing to tap, so a parked message would sit unreachable.

**It returns rather than rethrows**, so the generic `catch` does not also log
the same failure at warn under a vaguer name.

## Consequences

- A mis-configured template still costs that day's WhatsApp briefing. It stops
  being invisible, and stops being permanent — the unspent ask means the next
  morning retries, so fixing the config is the whole remedy.
- The in-app briefing was never affected and still is not. This path is only
  WhatsApp delivery.
- `send_briefing` is billable work (LLM scan + mailbox sync) triggered by a
  sentence. The per-turn cap bounds one turn; nothing bounds a user asking ten
  times across ten turns, which is the same exposure every other LLM turn
  already carries.
- It is also the workaround while a template is broken: the user asks, the
  window is open by definition because they just wrote, and the briefing goes
  out as ordinary text.

## Rejected alternatives

**Validate the template at startup.** The natural fix — refuse to boot, or warn
loudly, if `name`+`language` do not match an approved template. The deploy's
Meta token is phone-number-scoped: `GET /{waba}/message_templates` and
`GET /{phone_number_id}?fields=whatsapp_business_account` both return
`(#100) nonexisting field`. We cannot enumerate templates with the credential we
have, so this would need a second, broader-scoped token whose only job is a
health check. Worth revisiting if that token ever exists for another reason.

**Deliver the parked briefing on the user's next inbound.** Tempting, since it
would have reached this user at 12:16 when she wrote again. Rejected because it
misreads the common case: when the template *works*, a user who replies with
something unrelated has implicitly not asked for the briefing, and pushing the
full text at them overrides that. Distinguishing "we never asked" from "they
did not answer" is possible — `recordInbound` nulls `nudge_prompt_sent_at` on
every inbound, so it would have to return the prior state — but the unspent ask
already covers the config-error case on the next morning's retry.

**Prompt-tuning instead of a tool.** Nothing to tune. The capability did not
exist, and no instruction makes a model able to run a scan it has no tool for.
The failure mode was the model doing its best without one.

**Have `send_briefing` return the briefing text for the model to relay.** Would
put a deterministic artifact through a paraphrasing step, and spend the context
twice. The scheduled briefing is posted, not narrated; the on-demand one should
be the same message.
