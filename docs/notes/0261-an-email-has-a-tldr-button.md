# 0261 — An email has a tldr button

**Status:** Accepted, 2026-10-16

## Context

An open email (the same reader whether it was opened from the AI view or
the Traditional list) showed the whole thread and nothing shorter. A long
school notice or a ten-message thread had to be read in full to learn what
it asked for. Chord already reads mail with a model in three places — the
background passes (ADR 0066/0110), the read-time check (ADR 0180) and the
reply composer (ADR 0197) — but none of them answer "what does this say".

## Decision

A **tldr** button under the subject of every open email. Tapping it asks
`POST /me/email/threads/:id/summarize`, which returns a few plain-text
lines: what the email is and who it is from, then what it asks of the
reader (a reply, a payment, a form, a deadline), with every date, amount
and code kept as written. A second tap hides it; a third shows it again
without asking again.

- **Asked for, never automatic.** Summarizing every opened email would bill
  the user for emails they read in full anyway. The read-time pass (ADR
  0180) already runs on open; this is the user's choice to spend more.
- **Same model, gate and meter as the reply composer.** `resolveTurnLlm`
  (their key if BYOK), `getEntitlement` → 402, ADR 0102's one fixed failure
  sentence, ADR 0044's fix-your-key message. Tokens are recorded under a
  new `token_usage` source `email_summary` (migration `111`), so the
  allowance (ADR 0196) counts them and the two surfaces stay separable.
  `requireEntitled` and `write` in `compose-reply.service.ts` are shared
  rather than copied.
- **The thread is data.** Fenced and labelled the way ADR 0197 does it;
  quotes folded (ADR 0121); newest 12 messages, 3,000 characters each.
- **Not stored.** A summary is mail content and stored mail is sealed (ADR
  0201). Instead an in-memory cache (500 entries, 6 hours) keyed on
  user + thread + **newest message id** stops a repeat tap or a reopen
  paying twice, and a new reply in the thread makes a new summary.
- **No new bot tool.** It changes nothing (the CLAUDE.md rule covers
  mutating capabilities only), and "summarize that email" is already
  sayable in chat through `read_email` (ADR 0214).

Alongside, the AI view's **Feed** and **Cards** headings get a colour and
an emoji: `emailHeadingStyle(title)` in kernel picks both from the
category's own words (school → 🎒 blue, travel → 🧳, deliveries → 📦,
bills → 💳, events → 🎉, the To-dos/Events/Lists kind headings → ✅ 🎉 📝),
and an unknown title gets ✉️ and a colour fixed by its name so it does not
change between visits. It is in kernel so it can be tested (`mobile/` has
no harness). Sections shares the kind headings with Feed and changes too.

## Consequences

- A summary takes a model round trip (a few seconds); the button shows
  "tldr…" meanwhile.
- The cache is per process and lost on restart — a re-summary after a
  deploy costs tokens once more.
- A summary can be wrong like any model output. The rule against inventing
  details or judging legitimacy is in the prompt; the email is right below
  it.

## Rejected

- Summarizing on open, or in the background for every thread (cost, and
  most email is short).
- Storing the summary on the thread (needs sealing and a column for a
  value that is cheap to recompute).
- Reusing the `email_reply` token source (would hide which surface spends).
- The classifier's ADR 0068 `icon` for headings (unset on most categories).

## Addendum 2026-10-17: tldr reads the whole email

As shipped, tldr read the first 3,000 characters of each message, the newest
12 messages, and dropped quoted text everywhere. So a fact further down a
long school letter never reached the model, and a forwarded email read as
its one-line "FYI, see below" (the forward IS the quoted part).

Now `summaryInput` gives the model every message in full. Quoted history is
folded only in a message after the first one, where it repeats mail
already above it; the first message keeps its quotes. The only limit left is
`SUMMARY_MAX_CHARS` (160,000 characters, about 40k tokens), for a thread too
long for the model at all: whole older messages are left out first (the
prompt says how many), and the newest is cut, with a note, only when it alone
is over. A long email costs more tokens per tldr, which is the point.

**Lowered 2026-10-20 to 20,000 characters (~5k tokens, about seven pages).**
160,000 let anyone who can mail the user make each tap of tldr cost ~40k
tokens. An ordinary email, even a long newsletter, is still read whole; past
the ceiling the same rule applies (older messages first, then a cut newest
one with a note).

Not changed: the reply composer (ADR 0197) still reads 3,000 characters of
the newest six messages, and `read_email` (ADR 0214) still caps a body at
4,000 for chat. Both are about answering, not summarizing; widening them is
a separate call.

## Addendum 2026-10-21: length follows what the email contains

Every tldr came out about the same length, because the prompt said "at most
5 short lines" for every email. A school newsletter with eight dates had to
drop some or cram them together. Now the length is one short line per
separate thing the reader needs to know or do (an action, a deadline, an
event, an amount, a decision), up to `SUMMARY_MAX_LINES` (12). A short or
simple email is still one or two lines, and a long email that says little
must not be padded. Past 12 items, the ones with a date or an action are
kept. Prompt-only: what is read (`SUMMARY_MAX_CHARS`) and the 800 output
tokens shared with the reply composer are unchanged, and 12 lines fit well
inside 800 tokens. The cost goes up only for the emails that need more lines.

Rejected: scaling with the email's character count (a long marketing email
would get a long summary of nothing), no upper limit (the button is "tldr").
