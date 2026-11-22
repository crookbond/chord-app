# Email search answered with a list, not cards (2026-10-23)

**Reported:** in the personal 1:1 chat, asking for emails got a plain text
list in the bot's reply instead of the usual tappable cards (one per email).

**Finding:** not a card regression. Searches that find emails still show
cards. These searches found no emails, so there was nothing to make a card
from. The list was the ADR 0270 "which person did you mean" question.

## The card path is intact

- `buildSearchCards` (`server/src/services/bot/executor.ts`) builds one
  `kind: 'email'` card per email hit, linking to `/email/<threadId>`.
  `search-email-cards.integration.test.ts` passes.
- `executeAndBroadcast` collects a tool's cards, `persistAndBroadcast`
  stores them in `message_cards`, and `SSE.botCard` sends them to the app
  (`server/src/services/bot/bot.service.ts`).
- The chat bubble renders a card with an `href` as a tappable
  `router.push` (`mobile/app/groups/[id]/index.tsx`).
- The owner confirmed that emails a search does find show as cards.

## What happened

Prod combined log, 2026-10-23, the owner's personal chat:

| Time (UTC) | Search | Hits |
|---|---|---|
| 15:06:34 | `from deloitte` | 0 |
| 15:07:17 | `from jodaly@deloitte.com` | 0 |
| 15:09:40 | `from andrewallen5@deloitte.com` | 0 |

Each time the ADR 0279 guard dropped `to`, `hasAttachment`, `emailAction`,
`emailKind`, `after` and `before`, so only `from` was applied.

- **"deloitte"** went through the ADR 0270 person resolver
  (`server/src/services/email/person-resolve.ts`). Several people matched,
  so the search was held back (`blocked`). The tool told the model to list
  every candidate's name and address and ask which one was meant. That
  list is the text the owner saw.
- **The two addresses** were most likely guessed by the model from that
  list. They matched no mail, so they returned 0 hits and no cards.

This began with a95de485 (ADR 0270, 2026-10-19). Before it, `from:` was a
substring match on a thread's latest sender, so "deloitte" matched mail and
returned cards.

**Fix:** in the person resolver, not the card path. A company name searches
the whole domain, "from" offers only people who actually sent mail, and a
candidate with no name is shown as an address so the model does not invent
one.

## For anyone reading the logs

The `args` on a `bot tool exec: search` line are what the model asked for,
**before** the ADR 0279 guard. The `search: dropped unasked filters` line
just before it says which filters were removed. The search actually ran
with what was left.
