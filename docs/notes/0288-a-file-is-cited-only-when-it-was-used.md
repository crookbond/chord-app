# 0288 — A file is in the prompt only when relevant, and cited only when used

**Status:** accepted · 2026-10-22

## Context

Prod, the owner's personal chat, 2026-10-22. Asked for a restaurant for a
Friday date with Alice, the bot answered from saved places ("1. Khasiyat @
Edison (Indian) 2. Social Hub @ Parsippany (Indian) — Would you like a
reservation link or more options?") and the "based on:" row under the reply
named four files: an insurance proposal, a redlined side letter, an
alteration agreement and a personal PDF. None of them was used.

Two decisions made on substring matching compose:

1. **What goes into the prompt.** `selectExcerptsForTurn`
   (`services/bot/retrieval.ts`) took every visible file with a chunk hitting
   ANY one query word (`searchAttachmentChunks`, an OR tsquery), up to 12, with
   no floor. "Friday" and "date" hit every contract.
2. **What gets cited.** The filter in `bot.service.ts` named a file when a
   query word was a SUBSTRING of its filename or summary AND any word of the
   filename or summary was a SUBSTRING of the reply. A summary saying
   "options" or "link" passed against that reply. Being in the prompt plus
   two letter-level coincidences was enough.

ADR 0276 already gives files vectors, but only the `search` tool used them.

## Decision

**A file goes into the prompt only when it is relevant.**

- When the user has an embedder and the file has a vector of that model, the
  vector decides: the conversation text (the same recent human messages
  retrieval already reads) is compared with the file, and the file comes in at
  `RETRIEVAL_SEMANTIC_MIN_SIM` (default 0.35) or above — stricter than search's
  0.3, since nobody asked for this file. A file that close in meaning but
  sharing no word with the question comes in on its summary, with no excerpts.
  Below the floor it stays out, whatever words it shares.
- A file without such a vector (embeddings off, not embedded yet) is judged on
  words, as whole words with a plain plural folded (`utils/whole-words.ts`),
  never as letters inside words. Each message of the window is judged on its
  own (`wordsQualifyFile`): the file comes in when a real word of the message
  (4+ letters) is a word of its filename, or when at least two of the
  message's words, and at least half of them, are words of its matching
  chunks. One generic word decides nothing, and pooling a long conversation's
  words cannot make every file look relevant.
- Pinned files keep their treatment (appended without excerpts). More chunk
  hits are fetched (60) before the check so a real match is not crowded out by
  one-word hits elsewhere; excerpts are still capped at 10.

**A file is cited only when the turn used it** (`citedFiles`,
`services/bot/file-citations.ts`): a file tool reached it this turn
(`look_at_attachment`, `reference_file`, `send_file` — their success results
carry `attachmentId`; a refusal does not), or the reply repeats a real phrase
from the text the prompt carried for it — five consecutive words, three of
them real words, from one excerpt fragment or the inlined full text. Sharing a
word with the filename or summary no longer counts. The group-visibility rule
(ADR 0004) and the cap of 4 are unchanged.

## Alternatives considered

- **Raise the bar on the old checks** (two substring hits instead of one).
  Still letters, not words: "date" in "update", "link" in "unlinked".
- **Ask the model which files it used.** A second call per turn, and the
  model's own account of its sources is the thing that cannot be trusted here.
- **Cite every injected file.** Correct only once injection is perfect; the
  footer would still claim files that were merely available.
- **Meaning for citations too** (reply vector against file vector). A reply
  about restaurants and a file about leases might be far apart, but a short
  reply's vector is noisy and the question is factual: was the file used.
- **One similarity floor for search and injection.** Search shows a list the
  user chose to see; injection is silent and steers the answer.

## Consequences

- A paraphrased answer from a file that called no file tool is no longer
  cited. The `reference_file` description already tells the model to fire it
  whenever it answers from a file, which is also what makes the card tappable.
- A one-word question about a file's body ("anything on Friday?") no longer
  pulls the file in on words alone; naming the file, a second word, or a vector
  does.
- Dead code with the same substring rule was removed rather than fixed:
  `scoreRow`, `selectAttachmentsForTurn` and `searchUserOtherGroups` had no
  callers.
- Not changed (listed in the PR): `searchAttachmentChunks`' filename boost and
  coordination count still use substrings, but only to ORDER hits; the
  `get_list` fallback to saves (`executor.ts`, ADR 0096) and pending to-dos in
  user search (`search.service.ts`, ADR 0084) match any one token as a
  substring — both answer a query the user typed, and the first is being
  reworked by ADR 0290.

## Addendum 2026-10-25: a repeated phrase is not a citation

A `/plan` reply built from the calendar and `list_tasks` listed the to-do
"paying the New York Athletic Club balance by Saturday" and was footed "based
on: SQ008517.pdf · SQ008238.pdf", two club statements. The statements were
retrieved for the turn (they really are about the club), their text held the
same words as the to-do, and the phrase rule read the reply as a quote of
them. No file tool ran. The rule cannot tell "the reply quotes the file" from
"the reply quotes something else that says the same thing" (a to-do, an event,
an email, the user's own message), and families' files routinely restate what
is on their calendar and lists.

**The phrase rule is removed.** `citedFiles` names a file only when a file tool
(`look_at_attachment`, `reference_file`, `send_file`) reached it this turn; the
reply text is no longer an input, and `repeatsPhrase` is deleted. The group
rule and the cap of 4 stay.

- The row is sent only by `bot.service.ts` (`SSE.botSources`, not stored) and
  drawn only by the chat bubble; WhatsApp/Telegram renderers never print it.
- A file answered from without a file tool is no longer named. That is a
  missing row, never a wrong one; the `reference_file` description already
  asks the model to fire it whenever it answers from a file.
- A file a tool used but that retrieval did not inject is still not named
  (`citedFiles` looks names up in the injected set). Also a missing row.
- Retrieval is unchanged: the statements were reasonable context for a
  question about the club. Being in the prompt was never what put them in the
  row.
