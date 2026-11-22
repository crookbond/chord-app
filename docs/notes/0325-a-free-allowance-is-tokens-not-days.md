# ADR 0325 — A free allowance is tokens, not days

**Status:** Accepted, 2026-11-05
**Supersedes in part:** ADR 0079 (the 30-day trial; the gate itself stays)
**Amends:** ADR 0195/0196 (where the free tier ranks), ADR 0241 (card copy)

## Context

Since ADR 0079 every new account was fully entitled for `TRIAL_DAYS` (30 in
code, a two-digit value in prod) from `users.created_at`, with no token cap:
trial usage was written to `token_usage` (ADR 0193) and never subtracted. After
the window, anyone without a plan, family coverage, grandfathering or their own
key got `none` and met the gate.

Billing has been on in prod since about 29 October 2026. Two things are wrong
with a time limit there:

- It measures the wrong thing. Chord's cost is tokens (ADR 0196: recording
  usage IS the debit). A light user hits the paywall on day 31 having cost
  almost nothing; a heavy one can spend tens of millions of tokens inside the
  30 days, uncapped.
- It does not fit how people find out whether Chord is useful. Someone who
  connects their mail, tries it for a week and comes back a month later finds
  it locked.

## Decision

Owner, 2026-11-05: **every account gets a one-time free allowance of
`FREE_TOKEN_ALLOWANCE` tokens (default 10,000,000), counted from sign-up, with
no time limit.** Once it is used up, a plan or the user's own key is needed.

- **Same rule for everyone, existing accounts included.** "Used" is
  `SUM(token_usage)` since `created_at` — everything that account has spent on
  Chord's key, trial-era and paid-plan usage included (BYOK records nothing,
  ADR 0193). An account whose 30-day trial ended without a plan and that used
  under 10M gets AI back the moment this deploys, until it reaches 10M. One
  that used more stays gated.
- **Rank: where the trial was.** A paid individual allowance with room, a family
  pool with room, and the grandfathered monthly allowance are each checked
  first and are what is reported. The free allowance is the fallback after them,
  before `none` — including when a paid allowance is used up (the card still
  shows the plan, from `spent`, as the trial did). Usage is shared: tokens spent
  on a paid plan also count toward the 10M, because the rule is "everything since
  sign-up", not "everything while not paying".
- **New reason `free`** replaces `trial`. `Entitlement` and `BillingStatus` lose
  `trialEndsAt` and gain one optional `free` / `freeTokens: { allowance, used }`,
  present on `free` and on `none` once it is spent, never on the BYOK path.
  `balance`/`allowance` are set like the other token tiers. `usageIsFreeAllowance`
  (kernel) decides when the Settings usage line counts the free total ("2.5M /
  10M free tokens used") instead of a month, and the server builds the line with
  the same function.
- **Not on the BYOK path.** A key user records no usage, so the allowance would
  never run out; with the BYOK base fee configured (dormant in prod, ADR 0251) it
  would waive the fee forever. So BYOK is unchanged: `byok` while the base fee is
  off, `byok_unpaid` without a base plan when it is on — now also in the first
  30 days, which the trial used to cover. A BYOK user in their first month shows
  "Using your own key" rather than "Free trial", which is more accurate.
- **`TRIAL_DAYS` is removed** from `env.ts`; an old `TRIAL_DAYS=` line in a
  `.env` is ignored. `FREE_TOKEN_ALLOWANCE=0` turns the free allowance off.
  `reset:billing --created-at ended` is removed (a date cannot end a token
  allowance); `fresh` stays and gives the allowance back.
- **Every gate reads the same `getEntitlement`**: the bot turn, the email
  after-sync AI passes, the proactive kinds and the gated briefing teaser, the
  model tier in `resolveTurnLlm`. Nothing reads `reason === 'trial'` any more;
  `resolveTurnLlm`'s premium branch is simply `balance > 0`. ADR 0324 (every
  model call made for a user records a row) means the 10M counts briefings,
  attachment reading, memory extraction and the rest, not just chat.
- **Copy**: the AI Plan card says "Free · 7.2M of 10M tokens left" (no days),
  "Free tokens used up" once spent, "No active plan" when there is no free
  allowance on the deploy. The gated chat turn says "You've used your 10M free
  AI tokens." (or "this month's tokens are used up" for a spent plan) instead of
  "Your 30-day free trial has ended". `get_billing_status` describes `free` and
  `freeTokens`.

## Consequences

- Users past their trial with under 10M used regain AI on deploy, with no action
  and no message. Their next chat turn simply works; the email passes and full
  briefing resume on the next sync / scan.
- Cost is bounded per account (10M once) instead of per month of signup.
- One extra `SUM` over the user's `token_usage` rows per `getEntitlement` call
  for anyone who reaches the free tier (indexed by user, same shape as the
  grandfather and period sums).
- Old app builds know no `free` value and fall through to their "Trial ended"
  copy until the OTA update lands; the OTA ships with the deploy.
- Deploy: delete the `TRIAL_DAYS=` line from `scripts/deploy/.env.prod`
  (harmless if left, it is no longer read). `FREE_TOKEN_ALLOWANCE` needs no line
  unless a different figure is wanted.

## Rejected

- **Keep the 30 days as well** (free while under 10M AND inside 30 days). Keeps
  the problem this fixes: a light user is still locked out on day 31.
- **10M every month.** Twice the paid individual plan's 5M monthly
  allowance (ADR 0195): nobody would pay.
- **New sign-ups only.** Leaves the accounts that tried Chord during billing's
  first week locked out under a rule we no longer apply to anyone else, and needs
  a cut-off date in the code forever.
- **Counting only usage while not on a paid plan.** Needs a per-row "was this
  paid" mark or a reconstruction from subscription history; "since sign-up" is
  one sum and is what the owner asked for.
- **Applying it to BYOK users.** See above: it can never run out, so it would be
  a permanent base-fee waiver, not an allowance.

## Addendum 2026-11-09 — passive listening stops at the allowance too

`extractMemoriesFromTurn` checked AI consent but not the allowance. A gated bot
turn never reaches it, but passive listening (`passivelyExtractFromMessage`)
runs with no turn, so with the sayer's tokens spent every message in a
listening group was still a model call on Chord's key. It now stops when
`BILLING_ENABLED` and `getEntitlement` says not entitled, as the bot turn and
the memory clean-up already do.

## Addendum 2026-11-10: the wrapper refuses a spent allowance too

Every model call goes through `getLlmForUser` / `resolveTurnLlm` (ADR 0257),
which refused a user who had not agreed to AI (ADR 0283). The allowance was
not checked there: each entry point checked `getEntitlement` itself, so a door
that forgot ran on Chord's key with nothing left. A trace of every call site
found these doors with no allowance check: the read-time email pass (ADR
0180/0219), the upload filers and the copy made when a file is shared to
another group (`classifyAndAutoFileAttachment`, the content classifier), the
attachment summary, meeting context after a confirmed email card (ADR 0163),
WhatsApp import, passive memory extraction, and the meaning-search query
vector on the user's search screen.

The wrapper now refuses those calls before anything is sent, with
`AllowanceExhaustedError` (`services/llm/refusal.ts`), when billing is on and
`getEntitlement` says not entitled. It asks at the first call, not when the
model is built, and reuses an entitlement the caller already read. BYOK is
entitled unless the dormant base fee is set (ADR 0251), so an own key keeps
working. `getEmbedderForUser` returns null on Chord's key in the same case
(keyword search only). Entry points keep their own checks, because a stopped
pass often does something else (the briefing's no-model teaser, the chat's
"out of tokens" message); the doors above now ask `canUseAi` (consent and
allowance) first.

A refused call read nothing, so a pass must not record the email as handled.
`isAiRefusal` covers both refusals: the email suggestion sweep and person
extraction stop the pass there and leave the rest unmarked (the allowance can
run out partway through, since the pass's own gate is checked once at its
start), the read-time pass returns without its `read` mark, and the email trip
classifier passes the refusal up instead of reading it as "not travel". The
LLM classifier already left a failed batch unstamped. Still lost on a refusal:
an attachment's summary (its text and keyword index are still saved, as ADR
0283 already accepted for consent).

### Held-back work runs later, never before (owner rule)

Owner, 2026-11-10: no AI runs without consent AND tokens; work refused for
either must not be marked done, and runs once both are met. The email passes
already behave this way (a skipped email stays unmarked and the next pass reads
it). The other doors run once, when something happens, so refused work was
lost. It now goes in `ai_backlog` (migration `142`, one row per piece of work,
`(user_id, kind, ref)` unique, cascades with the user):

- `attachment`: an upload, or the copy made when a file is shared to another
  group. Text and keyword index are saved at once; summary, picture reading
  and filing wait, and the whole extraction is re-run.
- `whatsapp_import`: the model pass over an imported chat, re-built from the
  messages the import stored (the zip is gone); a refusal partway through
  resumes from that window.
- `meeting_context`: the attendee addresses ride the row.
- `memory_message`: the memory pass over a message posted while its sender
  could not use AI (passive listening, or a turn refused for consent or
  allowance; not the AGREE/NO answer itself).

`maybeDrainAiBacklog` (proactive tick, at most once a minute) takes up to 20
users round-robin, skips one who still cannot use AI (`canUseAi`), and runs up
to 5 of their items newest first. An item is deleted before it runs, so two
passes never run it twice; a refusal on the way puts it back. Kept at most 30
days and 200 items per user, oldest dropped first, so buying tokens does not
spend them all on a month-old backlog at once.

Not covered: a chat turn itself is not re-run (a reply hours later to a
question nobody is waiting on); and a read email older than ADR 0143's 7-day
window, skipped for consent or allowance, is mined only if the user opens it
(ADR 0180's pass).
