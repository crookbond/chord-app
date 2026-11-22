# ADR 0101 — A two-person chat is a person, until someone names it

**Status:** Accepted (2026-08-24)

## Context

Every shared chat rendered as its stored `name` (`groupTitle`, `mobile/src/names.ts`).
For a two-person chat that reads wrong. A conversation with one other person is
not a group you are in; it is that person. Owner report: the chat list showed
"either the group name, or the name of both recipients", when "for purpose of
chat, it is easier to show only recipient name".

Two-person chats reach that state several ways, and none of them produced a
name worth showing:

- `ensurePairGroup` (ADR 0067) mints them literally called **`'Direct message'`**.
- WhatsApp imports take the platform's chat title (`'Imported chat'` when absent).
- Connector chats take `chatTitle`, else `` `${platform} chat` ``.

Nothing distinguished "nobody named this" from "somebody chose this", so the
rule the owner asked for — *renamed wins, otherwise show the person* — had no
signal to read.

## Decision

**A shared chat with exactly two members, whose name nobody chose, displays the
other member's full name. Naming it wins from then on.**

Three parts:

1. **`groups.name_is_custom`** (migration `045`) records that a person chose
   the name. Set by `renameGroup`, and by the create-group **route** — a name
   typed into that form is somebody saying what the chat is. Service-internal
   creations (pair groups, WhatsApp, connectors) leave it 0, because the name
   they mint is ours or the platform's, not the user's.

2. **The server resolves the rule**, not the client. `counterpartNames()`
   returns a name only for groups that should actually display one — shared,
   exactly two members, `name_is_custom = 0` — and the DTO carries it as
   `Group.counterpartName`. The client is then one line:
   `group.counterpartName || group.name`. The rule needs membership, which is
   where membership lives.

3. **Backfilled to 0 for every existing row** (owner decision). A name only
   sticks once someone renames the chat from here on.

4. **A group shrinking to two claims its name** (`keepNameOnShrink`, called
   from `leaveGroup` when three members become two). Backfilling everything to
   0 means a long-standing name like "UWS Mazaa" is protected only by its
   member count — so the moment that count drops it would hand the label to
   whoever remains. A group that has been called something for a while was
   called that on purpose, even if nobody has re-typed it since. Losing a name
   silently is worse than keeping a dull one: the dull name is visible and one
   rename away, the lost one is noticed by accident.
   Pair groups are excluded, since `ensurePairGroup` minted their name and
   there is nothing to claim. This is the one question `pair_key` genuinely
   answers — *did we mint this name* — as opposed to the one it was rejected
   for below.

`fullName()` joins `greetingName()` in kernel: the latter answers "what do I
call you" (preferred name, first name), this one answers "who is this" (full
name, else first + last, else username). A roster wants the second.

## Consequences

- The chat list, the chat header and the catchup group chips all change
  together — they already shared `groupTitle` / `groupChipName`.
- Per viewer by construction: each of the two sees the other.
- A group that shrinks to two keeps the name it had; only a chat that was
  never named reads as the person. The cost is that a shrunken group carrying
  a dull auto-name ("Imported chat") keeps it rather than improving — visible,
  and one rename away.
- Renaming is the escape hatch, and it is already built.

## Alternatives rejected

**Compare the name against the known defaults** (`'Direct message'`,
`'Imported chat'`) instead of storing intent. No migration, but it guesses:
a chat someone genuinely named "Direct message" would be overridden, and every
new auto-naming path would have to remember to extend the sentinel list. Intent
is worth a column.

**Key off `pair_key`** to decide whether to show a person, rather than counting
members. `pair_key` marks only what `ensurePairGroup` created, which is narrower
than the question: a WhatsApp 1:1 import, or a two-person chat created any other
way and never named, is just as much a conversation with one person and would
keep showing its platform title. Counting members asks the question directly.
(`pair_key` does answer a different, narrower question — *did we mint this name*
— and decision 4 uses it for exactly that.)

**Resolve it on the client** from a members fetch. The chat list endpoint
returns `g.*` and no members, so this meant an extra round trip per open on the
hottest read in the app, and the rule would then live in the client while the
data behind it lived on the server.

**Keep names typed at creation for existing chats** (rather than backfilling
everything to 0). Considered and put to the owner, who chose otherwise: if the
"both names" chats being complained about were named by hand, preserving them
would mean the change appeared to do nothing.
