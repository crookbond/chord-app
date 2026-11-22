# ADR 0324 — Every model call made for a user is counted

**Status:** Accepted, 2026-11-05
**Amends:** ADR 0193 (token counter), ADR 0196 (usage is the ledger), ADR 0257 (one key chooser)

## Context

Billing is on in prod, and a user's remaining allowance is computed, not
stored: `MONTHLY_TOKEN_ALLOWANCE` minus `SUM(token_usage)` since their period
began (ADR 0196). Writing a `token_usage` row IS the charge. A model call that
writes no row is free to the user, paid by Chord, and makes both numbers on
the AI Plan card wrong.

Only two paths wrote rows: the chat turn (`bot.service.ts`) and the email
passes (`trackPassCost` in `email/pass-cost.ts`), plus the reply composer,
tldr, Findings chat and memory clean-up, which each record by hand. The owner's
account used 27.6M tokens in October; everything else went unrecorded:

| What | Where |
|---|---|
| Morning briefing scan (a tool loop like a chat turn, the biggest) and its single-shot fallback | `proactive.service.ts` |
| Trip-conflict nudge | `proactive.service.ts` |
| Memory extraction after every chat turn | `bot/extraction.ts` |
| Attachment text, vision, summary | `attachments.extract.ts` |
| Upload content classifier, trip classifier (uploads AND emailed itineraries) | `bot/content_classifier.ts`, `bot/trip_classifier.ts` |
| `look_at_attachment` and form filling | `bot/executor.ts`, `forms.service.ts` |
| Meeting context | `events/meeting-context.ts` |
| WhatsApp import extraction | `ingest/whatsapp/extract.ts` |

Recording at each call site would be twelve copies of the same try/catch, and
the next call site would forget, as these did.

Found while doing it: `trackPassCost().report()` wrote its row whenever it had
a db and a user id, without asking whose key ran the call, so a BYOK user's
email passes were charged against an allowance they do not draw on (against
ADR 0193: their key, their cost).

## Decision

**The model Chord hands out records itself.** `getLlmForUser(db, userId,
source)` now takes a required `source` (a `token_usage.source` value). On
Chord's key it returns the model wrapped in `withUsageRecording`
(`services/llm/usage-recording.ts`), which hooks `onUsage` on every
`complete()` and `stream()` call (still passing the report to the caller's own
`onUsage`) and writes one row per call when the call ends, success or failure,
under that source. On the user's own key it returns their model unwrapped and
nothing is recorded. No user or no db: Chord's model unwrapped (nobody to
charge). The source being a required parameter means TypeScript refuses a
`getLlmForUser` call that does not say what it is for.

- **One row per call**, the provider's last report for that call (every
  provider reports once per call). A provider that reports nothing (the mock)
  records nothing, as ADR 0194 decided: unmeasured is not free, and a guessed
  number must not drain an allowance.
- **Recording is awaited and best-effort**: a failed insert logs a warning and
  never fails the call it was attached to.
- **New sources** (migration `140`, CHECK constraint widened, the ADR 0281
  migration 117 pattern): `briefing`, `nudge`, `memory_extract`,
  `attachment_read` (text, vision, summary, `look_at_attachment`),
  `content_classify`, `trip_classify` (upload and email trip staging),
  `form_fill`, `meeting_context`, `whatsapp_import`.
- **The email passes move onto the wrapper** (`email_classify`,
  `email_magics`, `email_persons`), and `trackPassCost` only logs now. That is
  the BYOK fix: the wrapper is only ever on Chord's key.
- Paths that pick their model by tier (`resolveTurnLlm`: chat turn, reply
  composer, tldr, Findings chat, memory clean-up) keep recording themselves.
  `resolveTurnLlm` builds its model from `buildByokLlm` / `getLlm` directly,
  not through `getLlmForUser`, so it is never wrapped and a turn is never
  counted twice; a test runs one `runBotTurn` through the real factory and
  asserts exactly one `bot_turn` row, another runs an email pass on Chord's
  key and asserts exactly one row. `bot.service.ts`'s chat-turn recording is
  untouched (moving it onto the wrapper would also need the tier rules it
  applies, and PR #245 is changing it).
- `query-understanding.ts` is reached only by the retrieval-eval script with
  its own model: no user, nothing to record.

**A test keeps it that way.** `services/llm/__tests__/every-call-records.test.ts`
lists every file that calls `.complete(` or `.stream(`, how its calls are
recorded, and the exact number of calls in it. A new model call, in a new file
or an old one, fails the build until it is added to the list with how it is
counted; and any file using `resolveTurnLlm` must also call `recordTokenUsage`.

## Consequences

- A user's usage and remaining allowance now include the briefing, nudges,
  memory extraction, attachment reading and the rest. For an active user the
  briefing alone is a noticeable share, so allowances run down faster than
  before - that is the real cost becoming visible, not new cost.
- Before this, a BYOK user who also had a subscription could see email-pass
  usage on the card; that stops.
- Not backfilled: October's uncounted tokens stay uncounted.
- Usage rows for these sources are written by the worker role as well as the
  web role; both already write `token_usage`.

## Rejected

- **Recording at each call site.** Twelve copies of the same code, and the
  thirteenth call site forgets - which is how these twelve happened.
- **Wrapping every model `getLlmForUser` returns with no source.** The usage
  card and any later cost analysis need to know what the tokens were for; a
  default source would make the first forgotten site look correct.
- **Keeping `trackPassCost`'s write and skipping BYOK there.** Two places that
  each decide "is this Chord's key" can disagree; the wrapper is only applied
  where that is already decided.
- **A guessed token count when the provider reports none.** ADR 0194 already
  rejected it.
