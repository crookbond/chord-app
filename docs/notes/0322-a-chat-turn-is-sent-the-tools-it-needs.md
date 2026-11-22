# ADR 0322 — A chat turn is sent the tools it needs

**Status:** Accepted, 2026-11-05
**Amends:** ADR 0005 (iterative native tool use)

## Context

With billing on, a chat turn's tokens come out of a user's allowance. In
October the owner's account spent 10.3M tokens on 126 chat turns, about 81k
prompt tokens per turn against about 120 of output.

Measured in prod (bot turns since 15 Oct, `openai/gpt-4.1-mini`):

| | p05 | p50 | p95 |
|---|---|---|---|
| Personal chat turn | 43k | 91k | 109k |
| Findings side chat (6 tools, ADR 0277) | 7.5k | 8.3k | 24k |

A turn that answers in one round trip is the p05, about 43k. The median makes
two round trips, about 91k. The Findings chat builds the same kind of prompt
with only six tools and costs about 8k, so roughly 35k of every round trip
was the tool catalogue. `runNativeLoop` sent all 121 tools on every round
trip: 115k characters of descriptions and 36k of parameter schemas in a
personal chat, 77k in a shared one. The largest single tools are
`create_event` (8.7k), `update_event` (5.9k), `suggest_external_action`
(5.8k) and `search` (4.0k).

## Decision

**Send a core set every turn and topic groups only when they are needed**
(`server/src/services/bot/tool-groups.ts`).

- **Core** (28 tools, always sent): the calendar basics (create, update,
  delete and find events), tasks, lists, saves, `search`, `search_web`,
  `suggest_external_action`, facts (remember, list, correct, forget), files,
  and the skill tools. This is what most turns use.
- **Groups**: `calendar` (availability, conflicts, guests, feeds, default
  calendar and colours, sharing), `trips`, `email`, `email_settings`,
  `people`, `chats`, `account` (billing, own key, weather, briefing, name,
  phone, blocking, consent), `forms`. A test fails the build if a tool is in
  neither, in two, or names a tool that doesn't exist.
- **How a group is chosen**: by its words in the last four user or bot
  messages of the context window, so a follow-up such as "yes, do it" keeps
  what the turn before needed. The system prompt isn't read, since it
  mentions every topic. A running skill (ADR 0299) adds every group its
  steps save through, and a pending share offer (ADR 0232/0233) adds the
  group with `share_event` or `share_trip`.
- **`more_tools { groups }`**: an extra tool, sent every turn, whose
  description names each group, what it covers, and its tool names. When the
  model calls it, those groups are sent from the next round trip on. Loading
  tools doesn't count as attempting a tool, so a turn that loads tools and
  then only talks still gets the imperative strict retry.
- **Not a guard**: a tool the model calls by name without having been sent
  it still runs, subject to the same persona, personal-only and auto-file
  checks as before, and its group is sent from then on. Sending is a cost
  choice, so a wrong guess costs a round trip, never a refusal.
- **Order, for prompt caching**: core first, then `more_tools`, then groups
  in a fixed order, so turns share the longest possible prefix.
- The Findings side chat (`onlyTools`) and the text-fence path (mock and
  text-only models) are unchanged.
- `BOT_TOOL_SUBSET` (default true) turns it off. Each turn logs
  `bot turn tools` with the groups it started with, the groups loaded later,
  the tools sent, the round trips and the prompt tokens, which is how the
  choice of words and core gets checked against real use.

An "add milk to the Costco list" turn in a personal chat is sent 29 tools and
57k of the catalogue's 153k characters (37%), with `more_tools` (3.3k)
included.

## Consequences

- A request whose words name no group, and which needs a tool outside the
  core, depends on the model calling `more_tools` or calling the tool by
  name. Both work, and both cost one extra round trip. The `bot turn tools`
  log shows how often it happens (`loadedLater`).
- The word lists are English, like the rest of the turn heuristics
  (ADR 0229/0279).
- A turn's list of tools changes with its topic, so the cached prefix is the
  core set and `more_tools`, not the whole list.
- The tool rules in `NATIVE_TOOL_PROMPT` (about 20k characters) still name
  tools that may not be sent. Calling one works, as above. Trimming that
  prompt is the next saving.
- Fixed with it: the imperative / where-is / pending-invite strict retry is
  a second full run of the loop, and its tokens were never written to
  `token_usage`. Each run is now recorded (`recordRun`), so a retried turn
  is counted in full. Other model calls that record nothing (the daily
  briefing scan, memory extraction after a turn, attachment summaries and
  classifiers, query understanding, forms, meeting context, WhatsApp import)
  are listed in the PR and left for their own change.

## Rejected

- **A small model picks the tools first**: an extra call and extra latency on
  every turn, to save what a word match and `more_tools` already save.
- **Refusing a tool that wasn't sent**: turns a cost saving into a
  capability loss whenever the guess is wrong.
- **Embedding-based tool retrieval**: needs an embedder on every turn
  (ADR 0276 can be absent) for a choice among eight groups.
- **Shortening the descriptions instead**: worth doing too, but the rules in
  them were each added for an incident; dropping whole groups is the larger
  and safer cut.

## Addendum 2026-11-10 — the user's words, not the bot's

**Measured** (prod, read-only, the 10 days after this shipped): 48
`bot_turn` rows, 43 of them the owner's; about 88k prompt tokens a turn on
average, up to 168k. The `bot turn tools` line showed most turns STARTING
with 4–8 of the 8 groups (70–122 of 121 tools), and most turns take two
round trips, each resending the tools. Sizes: all 121 tools ≈ 40.3k
tokens, core ≈ 14.1k, groups calendar 2.5k, trips 3.8k, email 4.9k,
email_settings 5.5k, people 2.5k, chats 2.3k, account 4.4k, forms 0.4k.
The rest of a round trip is ≈ 15–18k.

**Cause.** Two things, both in the word match:

1. `turnToolGroups` read the last four user AND bot messages. A bot reply is
   long and names every topic ("your flight to Denver, the dentist
   appointment, the email from the school… want me to message the family
   chat?"), so the "yes" or "add gym at 6" after it started with five or six
   groups.
2. The words were ordinary conversation: calendar `plan`, `week`, `colour`,
   `meeting`, `appointment`; people `number`, `address`, `member`, `famil`,
   `kids`, `mom`; chats `message`, `delete`, `clear`, `tell`; account
   `setting`, `morning`, `phone`, `cancel`, `cost`, `block`, `report`; email
   `order`, `respond`; trips `stay`, `book`, `arriv`, `check in`. In a family
   chat "add bananas, the kids want them" switched on people, and "cancel
   dinner Friday" switched on billing.

**New rule.**

- The starting groups come from the triggering message plus the SAME user's
  previous message in that chat when it is at most 10 minutes older
  (`turnToolWords` in `bot.service.ts`), so "yes" / "that one" keeps the
  context the user gave. Bot replies, other members' messages and the system
  prompt are never read. A turn with no stored message reads the latest user
  message after its "name: " prefix (a display name like "Dad" must not
  count). The other inputs are unchanged: a running skill's `saveWith`
  tools, a pending share offer, a tool called by name, and `more_tools`.
- Each group's `words` now names the group (`email`, `inbox`, `reply to`,
  `receipts`; `flight`, `trip`, `hotel`; `calendar`, `am I free`, `invite`,
  `rsvp`; `birthday`, `phone number`, `contacts`, `family plan`; `the chat`,
  `tell her`, `delete … messages`; `tokens`, `subscription`, `whatsapp`,
  `briefing`, `weather`, `block him`; `unsubscribe`, `folder`, `signature`).
  Everything the core tools already do (create/move/delete events, to-dos,
  lists, saves, search) needs no group, so "add dinner Friday", "what's on
  this week", "move the dentist appointment to 3pm" start with none.
  `tool-group-words.test.ts` holds ~60 messages with the groups each must
  and must not start.

**Before / after** (`groupsForText` over 25 sample turns modelled on the
owner's: groceries, "add dinner Friday", "what's on this week", "reply to
that email" then "yes", trips, birthdays, billing, each with the previous
user message and, for "before", the bot reply between): groups started per
turn 1.44 → 0.40; tool tokens per round trip ≈ 19.1k → 15.7k (core alone is
14.1k). The sample has one short bot reply per turn where the old rule read
two long ones, so it understates the prod "before" (4–8 groups); on prod's
numbers a typical two-round-trip turn should lose most of its ~20–55k of
group tools. Three real asks the old words missed now start their group:
"how much did I spend at Amazon" (`spent?` never matched "spend"), "am I
free Thursday afternoon?", and plain "any new mail from…".

**Cost trade.** A group the words miss now costs one `more_tools` round
trip (≈ 15–18k of non-tool prompt, cached prefix, plus core), where the old
rule paid for unneeded groups on nearly every round trip. Most likely miss:
a follow-up more than 10 minutes after the ask, or a "yes" to something only
the BOT raised ("want me to email the guests?" → "yes"). Both still work —
the model loads the group — they are just one round trip slower.

Rejected here: reading only the latest bot message (still names every
topic), a wider window for the previous user message (a stale topic is what
inflated the old count), and shrinking the core set or changing how cached
tokens are billed (owner chose not to, for now).
