# 0164 — Explicit memory writes, live web search, and named-group targeting from the personal 1:1

**Status**: accepted
**Date**: 2026-09-11

## Context

Three related bot gaps, bundled into one change:

1. "What do you know about me" already had a read (`list_memories`), but the
   bot had no way to WRITE a fact during a live conversation — every write
   path was fire-and-forget passive extraction after the turn
   (`bot/extraction.ts`), landing `status:'proposed'` and requiring the user
   to leave the chat and confirm in the Memory tab. Learning about the
   person "interactively, back and forth" needs a fact stated in
   conversation to stick without that side trip.
2. The bot could only answer place/restaurant questions from its own
   training knowledge — `suggest_external_action` (ADR 0039/0153) builds a
   tappable deep link but never fetches anything, and ADR 0050 explicitly
   considered and declined a search-backed lookup as "a new external
   dependency with real reliability risk", deferring it to backlog.
3. ADR 0096 widened READS from the personal 1:1 across every group the user
   belongs to, but explicitly left WRITES pinned to the turn's own group
   (its own Consequences section calls this out, deferring to "a scope
   decision of its own"). So "add milk to my list with Alice" from the
   1:1 silently created a new, separate personal list rather than adding to
   the shared list with Alice.

## Decision

**Explicit memory write** — new `remember_fact` tool, general availability
(not personal-only, mirrors `add_person`). Direct-writes to
`status:'confirmed', source:'explicit'` via the existing `upsertMemory` —
no proposal round-trip, same reasoning as `add_person`'s in-turn direct
write: the user stating it in this turn IS the confirmation. `list_memories`'s
description now coaches the interactive loop: when a "what do you know
about me" answer comes back thin, ask ONE open follow-up and call
`remember_fact` on the answer.

**Live web search** — new `search_web` tool, backed by a `SEARCH_PROVIDER`
seam (`''` \| `'mock'` \| `'google'`) mirroring `WEATHER_PROVIDER`'s pattern
(ADR 0091) exactly: `server/src/services/search/{types,mock,google,index}.ts`,
`getSearchProvider(): SearchProvider | null`. `'google'` calls the real
Google Custom Search JSON API. Never throws (weather's convention); an
unconfigured deployment gets `getSearchProvider() === null`, and the tool's
description forbids the model from claiming it searched when it hasn't
(ADR 0102 posture). Kept as an app-orchestrated tool (executed in
`executor.ts`, provider-agnostic) rather than a provider-native web-search
tool, so it works identically whichever `LLM_PROVIDER` is active —
including `mock`, which the codebase's documented demo/test flow depends on.

**Named-group targeting** — a new shared `resolveGroupByName` helper
(`executor.ts`, next to `isPersonalTurn`/`groupNamesFor`) extracted from
`set_email_route`'s inline exact-name-or-ask query (ADR 0077), upgraded to
also match the ADR 0101 counterpart display name (via `counterpartNames()`)
so an unnamed two-person chat resolves on the other person's name. New
optional `withGroupName` param on `create_task`, `add_list_item`,
`save_place`; honored ONLY when the turn is personal (`isPersonalTurn`) —
from inside a shared group it's ignored, keeping ADR 0004's strict
per-group scope for shared-group turns. Membership is enforced for free
(the resolver only ever returns a group the actor already belongs to).
`set_email_route` itself is refactored onto the shared helper.

## Alternatives considered

- **Provider-native web-search tool** (e.g. Anthropic's server-side
  `web_search`) — smaller diff, but only functions when
  `LLM_PROVIDER=anthropic`; this codebase's documented mock-demo flow and
  default (`openai`) would get nothing. Rejected in favor of an
  app-orchestrated tool that's provider-agnostic and mockable like every
  other external integration here (`WEATHER_PROVIDER`, `GMAIL_PROVIDER`, …).
- **No live search, training knowledge only** — cheapest, no new
  dependency, but doesn't satisfy "look this up externally" and can't build
  a genuinely fresh profile fact from real information.
- **Background-only memory writes (status quo)** — passive extraction still
  runs; it wasn't removed. But it can't be the ONLY path, since a proposed
  fact needing a separate confirmation elsewhere breaks the "the bot just
  learned this, in the moment" loop the user asked for.
- **Extending `withGroupName` targeting to shared-group turns too** —
  rejected; ADR 0004's strict per-group scope is a deliberate boundary for
  a turn already inside a group, and there's no legitimate "add to a
  DIFFERENT group" request from inside one group's own chat.
- **A new `group-resolve.ts` service file** for the resolver — the
  established pattern for a helper this size elsewhere in the same file
  (`isPersonalTurn`, `groupNamesFor`) is a local function in `executor.ts`,
  not a new service module; followed that instead of a new file for ~25 lines.

## Consequences

- No schema/migration changes — every write reuses existing tables
  (`memories`, `saves`, `tasks`, `lists`, `groups`).
- New env keys `SEARCH_PROVIDER`, `GOOGLE_SEARCH_API_KEY`, `GOOGLE_SEARCH_CX`
  (all default empty/off — a deployment that does nothing gets no new
  behavior).
- `set_email_route`'s behavior gains a side effect from the refactor: it now
  also resolves on an unnamed pair group's counterpart name, which it
  didn't before. Same underlying rule, applied consistently — not scope
  creep.
- `resolveGroupByName`'s `reason` field matches `set_email_route`'s original
  semantics exactly: `'not_found'` whenever there isn't exactly one EXACT
  match (even when several groups partially match — those still ride along
  in `candidates` as a hint); `'ambiguous'` is reserved for two exact
  case-insensitive ties. Worth flagging for future readers, since it reads
  as a bug on first glance.
- `search_web` costs real money once a real `SEARCH_PROVIDER=google` key is
  configured (Google Custom Search JSON API, ~$5/1000 queries) — no
  per-turn cap was added beyond the ADR 0005 native loop's own bound on
  tool-call iterations per turn; revisit with a `claimOncePerTurn`-style
  guard (ADR 0099's mechanism) if usage warrants it.

**Addendum 2026-09-11 — a paid search API isn't worth it for this
product's volume; the fallback is the real answer, not a placeholder.**
Checked whether a search-affiliate/ad-revenue-share arrangement (Google
AdSense for Search, the Bing/Yahoo Syndicated Search Partner Network)
could flip the economics — both pay a ~51% cut, but only on AD CLICKS,
which means displaying Google/Bing-branded ads inside the family's
private chat, plus Google's own minimum-traffic gate (20+ search-ad
impressions in 2 of the trailing 6 months, added Aug 2025) that a
handful-of-users family app won't clear. Both are built for a public
search-results page with visible ads, not a private assistant's backend
lookup — wrong shape for this product regardless of volume. Owner call:
skip the paid API path entirely rather than build toward either the cost
or the eligibility bar.

So the `SEARCH_PROVIDER` seam stays (dormant infrastructure, zero cost
unless someone configures a key later) but is no longer the primary
design — the no-provider case, expected to be the permanent steady
state, is upgraded from a dead-end apology to the actual answer:
`search_web`'s executor fallback now returns a plain
`https://www.google.com/search?q=<query>` link — no API, no key, nothing
fetched by us (same "we render the link, never fetch it" posture as
ADR 0135/0138) — riding as a tappable `BotCard`. Consequence:
`search_web`'s `data` shape gained a `searchUrl` field on the
unavailable path, carried on the returned `card.url` too.

The tool description's split is EVERGREEN vs. ABOUT-A-BUSINESS, not
"is the model confident" — a first draft got this wrong (grouped "a
famous restaurant's cuisine" with stable facts, so a confidently-named
place skipped the tool and got no staleness caveat at all). Recognizing
a real restaurant and knowing it's still open with the same hours and
quality are different things; only live data settles the second, and
the model's sense of its own confidence doesn't track that distinction.
So: an evergreen fact (where a landmark is, a city's character/history)
answers directly, no tool call, no caveat. Anything about a specific
business or venue calls `search_web` FIRST regardless of how
confidently the model recognizes it, and — on the `ok:false` fallback
that's now the norm — still gives its best knowledge-based answer but
says plainly it could be stale (closures, hours, quality drift) with
the link attached to check. Verified live: asked about a genuinely
famous, real restaurant (Chez Panisse) the model named and described
correctly without hesitation, and it still called the tool, caveated
the answer, and attached the search-link card — while an evergreen
geography question ("which country is Kyoto in?") skipped the tool
and answered directly with no card, confirming the split lands on the
right axis.

## Addendum 2026-10-05 — naming yourself is not naming a group

Prod: "Reminder to email milo tomorrow at 9a", sent in the personal chat, came
back as `create_task: group "John Doe" did not resolve` and nothing was
saved. The model had put the asker's own name in `withGroupName`. No shared
group is called that, so the exact-name-or-ask resolver refused, which is the
right answer for a group nobody can find and the wrong one for "me".

`resolveWriteGroup` (`bot/executor.ts`) now sits in front of the three
personal-1:1 writes (`create_task`, `add_list_item`, `save_place`). It
tries a real group FIRST, so a shared chat that carries the asker's name still
wins; only when that fails does it check whether the name is the asker (their
display, first, preferred or full name, their username, or "me" / "myself"),
and if so the write goes to the turn's own group. Any other unmatched name is
still refused with candidates. `set_email_route` keeps the strict resolver:
there a group really is required.

The three tool descriptions also tell the model never to put the asker's name
in the field. That is the hint; the resolver is what holds.

In the app, the line under the user's message showed a tick whenever the turn
finished. It now shows a warning mark when every tool call in the turn was
refused or failed, so a refusal no longer reads as done.

## Addendum 2026-10-25: named-group writes removed

The third part of this ADR (`withGroupName` on `create_task` /
`add_list_item` / `save_place`) is removed. The model was sending a real group
name nobody said ("Doe Family" for "add milk to the Costco list" from the
personal chat), and the owner's rule is now that an item is created in the
chat it was asked in. See ADR 0232's 2026-10-25 addendum. `resolveGroupByName`
stays for the paths that name a group on purpose (email routes, posting to a
group, a share offer's answer).
