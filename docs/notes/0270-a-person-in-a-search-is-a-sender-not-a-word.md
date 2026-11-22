# 0270 — A person in a search is a sender, not a word

**Status:** Accepted, 2026-10-19

## Context

"Find me emails from Bill" did not work. The bot's `search` tool had one
`query` field, and the words went straight to keyword matching:

- **The person was a word.** `from` is a stopword, so "emails from Bill" became
  the prefixes `emails | bill`, OR'd. "email" matches nearly every message, and
  the stem "bill" matches billing@, "5 bills to automate" and every invoice.
  The bot path ordered by date with a cap of 8, so the newest promos won.
- **`from:` was a substring of the latest sender.** A thread's `from_email`
  is its newest message's, so a thread Bill started and the user answered
  last was not "from Bill", and `from:bill` matched billing@.
- **No names were resolved.** Nothing turned "Bill" into an address, so
  William Smith and nicknames could not be found, and the `people` rows the
  user had confirmed (ADR 0076) were never read.
- **Mail the user sent could not be asked for**: `to_emails` was not searched.
- **Date bounds compared text.** `last_message_at >= after` as strings. Every
  provider writes mail times as UTC (`…Z`) today, so this was correct in
  practice, but it breaks the CLAUDE.md time-column rule the moment a writer
  keeps an offset.

An eval set over a sealed mailbox (`services/search/eval/`) scored person
queries at hit@3 0.17, with a billing robot or a newsletter in the top five
for half of them.

## Decision

**A person is resolved to addresses, then filtered on.**

- `resolveCorrespondent` (`email/person-resolve.ts`) turns a name, an address
  or a domain into the addresses that person uses, from the user's own mail
  (senders and To/Cc) and own `people` rows only (ADR 0065/0114).
  - A name matches by **whole token, with nicknames** (`kernel/src/nicknames.ts`):
    every word asked for must match a word of the sender's name, of the
    address's local part, or of the domain's name. "bill" is not "billing".
  - One person writing from several addresses is grouped by name; a `people`
    row counts as much as 25 messages; robot addresses (noreply@, billing@...)
    rank last.
  - Two people about equally likely (the top has less than 3x the runner-up's
    mail) is **`ambiguous`**: the search runs no mail query and the bot is told
    to ask which one, listing names and addresses. Exact-or-ask, as in ADR
    0077/0094/0137.
  - A robot address shared by several senders (one noreply@ for the district
    and the pharmacy) matches only together with the sender's name, through
    the sealed name's blind trigrams.
- `findEmailThreads` matches a sender on **any message** of the thread, by
  exact address or domain; a recipient by exact address in To or Cc. New
  filters `actions` and `kind` (receipt, delivery, flight, invite). Date bounds
  compare instants (`textInstant`).
- **One preparation for both surfaces** (`email/mail-query.ts`): operators,
  the bot's structured filters and plain language all become the same
  `findEmailThreads` input, so the bot and the search box cannot read one
  question two ways (ADR 0085's rule, one step earlier).
- **The bot passes a person in a field.** `search` gains `from`, `to`,
  `after`/`before` (local days, made instants in the user's zone),
  `hasAttachment`, `emailAction` and `emailKind`; `query` may be empty. The
  description says a person never goes in `query`.
- **Plain language is a fallback.** `parseMailIntent` (kernel) reads "emails
  from X (about Y)", "what did X send me", "emails I sent to X", "X about Y"
  and rolling windows, for when the model passes the user's words through (the
  mock and text-fence providers always do). Its person is a candidate: a name
  that matches nobody goes back into the text, so "mail from the aquarium"
  still searches for "aquarium".

**Changes ADR 0126's `from:`.** It now resolves like a person; only when it
matches nobody does it fall back to the old substring match on the sender.
`to:` is new. A `to` that matches nobody returns no mail rather than guessing.

## Consequences

- Eval: person hit@3 0.17 → 0.83, robots in the top five 50% → 0%, overall MRR
  0.55 → 0.82. The floors live in `email-search-eval.integration.test.ts`.
- A person search is one extra query (the candidate scan, bounded to 60 rows
  per source) before the mail query.
- Ordering is unchanged (relevance on the bot path is the next ADR), and
  meaning-based matching ("kids excursion paperwork" for a field trip form) is
  still missing.
- The nickname list is English given names only.
- Migration `113` indexes `email_messages (user_id, lower(from_email))`.

## Rejected

- **Teaching the model `from:` syntax only.** It already knew it from the
  coupon recipe and still put names in `query`; a structured field is harder to
  get wrong, and the resolver is needed either way to turn "Bill" into an
  address.
- **Substring on the sender's name.** That is what matched billing@.
- **Picking the most frequent Bill.** A confident wrong person is worse than
  one question.
- **Searching for a recipient by substring when nobody matches.** "Mail I sent
  to Zelda" with no Zelda is an honest empty answer.

## Addendum 2026-10-23: a company is a domain, and "from" means a sender

Prod: "show me emails from deloitte" asked which of five Deloitte people the
user meant. The user picked Jessica, then "Andrew allen", and got "no emails
from …" both times. The second was also renamed "Andrea Allen". The causes:

- **A company word matched people.** A domain was recognised only when typed
  as `deloitte.com`. A bare "deloitte" went through name matching, where the
  domain's own name counts as a word, so every Deloitte address matched. They
  tied, and the bot asked which person. Now **one word that is the domain name
  of every match is the domain**: the search is all mail from (or to)
  `deloitte.com`, and nothing is asked. "Deloitte Billing" does not stop this:
  the company name in a sender's display name is not what decides it.
- **Candidates ignored the direction.** People were gathered from senders AND
  To/Cc lines whatever was asked, so "from" offered people who had never sent
  the user mail, and choosing one found nothing. `resolveCorrespondent` now
  takes `direction`: for "from" a candidate must have sent the user mail, for
  "to" it must have received some. A People row with no mail either way stays
  a candidate (the user told us about them).
- **A nameless candidate got a made-up name.** A To/Cc address has no name,
  and the bot was told to "list each candidate's name", so it built one from
  the address (`andrewallen5@` became "Andrea Allen"), which then stayed in the
  chat. `askWhichPersonInstruction` (`mail-query.ts`) now writes the options
  out (`Name <address>` or `address (name not known)`) and forbids deriving a
  name from an address.

Tests: `person-resolve.integration.test.ts`, built from the prod addresses.
Rejected: a list of known company domains (goes stale, and the user's own mail
already says which domain the word is); deciding by whether the word appears
in display names (company senders put the company there too).
