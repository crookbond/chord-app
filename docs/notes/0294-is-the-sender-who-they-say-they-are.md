# ADR 0294 — Is the sender who they say they are?

**Status:** Accepted, 2026-10-23
**Amends:** ADR 0180 (the read-time pass now sees the sender), ADR 0201 (two
new plaintext columns)

## Context

A phishing email ("Robinhood") reached a prod inbox past the provider's spam
filter. Opening it in Chord showed the display name and nothing else. You
could not tap the name to see the address, or tap the To line to see who it
went to. Chord did nothing more than the provider had already done.

Reading the code found a sharper gap. The read-time pass (ADR 0180) is told
to raise an advisory for "a sender impersonating someone trusted, a
mismatched or lookalike domain". Its prompt never contained a From line:
`promptFor` sent the category, subject, preview and body. So it judged
impersonation from the body alone, the one part of a phishing email the
attacker writes.

The owner asked for the reader fix and for a design that can grow, because
LLM help can do more here than the provider's filters.

## Decision

**A new subtree, two halves.**

- **`kernel/src/sender-check/`** holds pure checks, testable from the server
  suite (ADR 0120's reason for kernel). `domains.ts` has the registrable
  domain, freemail list, punycode, look-alike folding and edit distance.
  `brands.ts` is a curated table of the companies phishing borrows, with the
  domains they really send from. `auth-results.ts` parses RFC 8601.
  `check.ts` is `checkSender(input) → SenderCheck`.
- **`server/src/services/email/sender-check/`** loads facts and calls the
  checks. `annotate.ts` attaches a `SenderCheck` to every message on thread
  open, using one query for sender history and one for People names.
  `prompt.ts` builds the Sender block for the read-time pass. `columns.ts`
  writes the two header columns the same way from every provider.

A new check is a signal code plus a sentence, added in `check.ts`. If it
needs a new fact, that fact is one more field on `SenderCheckInput`. The
reader and chat show any signal without changes.

**Signals** (`info` < `caution` < `danger`; the message's level is the
highest one):

| Code | Level | When |
|---|---|---|
| `brand_mismatch` | danger | The display name, or the address with no display name, claims a listed brand, and the domain is not one of that brand's. A freemail address never counts as the brand. |
| `lookalike_domain` | danger / caution | A look-alike spelling (`paypa1`, `rnicrosoft`), or one letter off a name of 7 or more letters, is danger. A brand name inside a longer domain (`robinhood-secure`) is caution, because a real company sometimes registers those. |
| `name_shows_other_address` | danger | The display name contains an address that is not the sender's. |
| `impersonates_contact` | danger | The display name is the full name of someone saved in People, and the address is not one the user has for them. This is the family version of CEO fraud. |
| `auth_failed` | danger | The topmost `Authentication-Results` says `dmarc=fail`. |
| `auth_weak` | caution | No DMARC verdict, and neither SPF nor DKIM passed. |
| `reply_to_elsewhere` | caution | Reply-To is on a different domain, and that domain is a freemail one or the sender claims a brand. |
| `suspicious_link` | caution | A link goes to a raw IP address or a punycode host. |
| `mixed_script_name` | caution | Latin and Cyrillic or Greek letters in one name. |
| `risky_attachment` | danger | An attachment that runs code or is an HTML page (`.exe`, `.js`, `.iso`, `.html`, `.svg` and similar). |
| `first_contact` | info | No earlier mail from the address, never written to, not in People. |
| `not_addressed_to_you` | info | The user's address is on neither the To nor the Cc line, and it is not mass mail. |

**Non-distinctive brand names are claims only when they stand alone.** Chase,
Apple, Target and Discover are also ordinary words and people's names. One of
these counts as a claim only when the rest of the display name is service
words ("Chase Alerts", "Apple Support"). "Chase Miller" is not a bank. This
is ADR 0138's rule for airline names. A brand not in the table is never
claimed, so a company we did not list cannot produce a false "this isn't
really them".

**Only the topmost `Authentication-Results` is read.** Every relay prepends
its own, so the top one comes from the user's provider. A lower one may have
been written by the sender. `firstHeader` exists for this: `headerMap` keeps
the last occurrence, which is right for single headers and wrong here. A
test pins this with a forged lower header. DMARC passing proves only the
sender's own domain (`verifiedDomain`). It is never shown as "this is
genuine": `rh-account-review.com` can pass DMARC for itself.

**Nothing ever says an email is safe.** With no findings, the reader says
"Chord found nothing unusual about this sender". The chat tool is told the
same: never "safe" or "genuine".

**Storage.** Migration `121_email_sender_auth` adds
`email_messages.reply_to text` and `auth_results jsonb`, holding the parsed
`SenderAuth` rather than the raw header. Both are plaintext like
`from_email` (ADR 0201: addresses and routing metadata are not sealed). The
upsert follows the list-unsubscribe rule: `undefined` means this fetch did
not carry the headers and leaves the stored value alone (Gmail metadata
format, Graph's delta). How each provider supplies them:

- **Gmail:** sync already fetches `format=full`, so this is free.
- **IMAP:** `parseFetchedMessage` already has every header line.
- **Outlook:** headers come only on the thread-open `getMessage`, which was
  fetching them and dropping them. That fetch now writes both columns.

There is no backfill. An older message reads as "No mail-server check is
available".

**The LLM half.** `senderContextBlock` gives the read-time pass a Sender
block: From, sender domain, Reply-To, the provider's verdict, history, up to
8 link domains, the claimed brand, and every caution or danger finding. The
prompt says the block comes from headers and code, to trust it over the
body, and that a finding plus a request for a click, login, payment or
personal details is strong grounds for an advisory naming the mismatch. The
model still judges content (urgency, gift cards, credential pages), which no
rule can. The deterministic warning does not wait for the model: it shows on
open, and the advisory adds to it.

**Reader** (`mobile/src/email-sender-sheet.tsx`):

- Tapping the sender's name opens the sender box: name, address with Copy,
  "Sent from <domain>", Reply-To when it differs, the findings or "found
  nothing unusual", the mail-server line, and history.
- Tapping the To/Cc line opens the recipients box: each address with Copy,
  "(you)" marked, a Bcc note when you are on neither line, and Copy all.
- A caution or danger finding puts one line above the body, and a ⚠ beside
  the name, also on a folded message.

**Chat parity.** `read_email` messages carry `senderWarnings` and
`senderDomainVerified`. The tool description says to use them for "is this
real / a scam", to repeat warnings in plain words, and never to call an
email safe. The checks change nothing, so they need no tool of their own.

### Addendum: foreign letters, your own correspondents, and plain text

The owner asked about domains built from letters that only look right
(Cyrillic а for a, l for I, 0 for o), and whether such mail should lose its
HTML.

- **Compare what the reader sees.** `confusables.ts` decodes punycode
  (RFC 3492, in plain TS because kernel also runs in the app), applies NFKC
  (full-width ｐａｙｐａｌ), drops accents, and maps Cyrillic, Greek and
  Latin-extension look-alikes to the Latin letter they imitate. The result
  is a skeleton, folded once more by `foldLookalikes` (0→o, 1/I/i→l,
  rn→m, vv→w). Two domains with the same skeleton look the same.
  `xn--pple-43d.com` (shown as аpple.com) is now danger: "written with
  letters from another alphabet to look like apple.com". Punycode that
  imitates nothing (münchen.de) stays a caution, showing its decoded form.
- **Not only brands.** Look-alikes are also compared with
  `knownDomains`: the registrable domains the user has sent mail to, or
  has in People. A copy of the kids' school domain is caught though no
  brand table lists it. Mail RECEIVED is deliberately not a source,
  because a phishing domain that has mailed you twice would then become a
  "known" domain to compare against. A sender on a domain the user already
  writes to is never called a look-alike, so two real domains (abcschool
  and abc-school) do not flag each other. For known domains: same skeleton,
  or one edit apart on names of 8 or more letters.
- **Suspect mail is shown as plain text.** A message whose check is
  `danger` renders as text: no formatting, no images, no tappable links.
  A note above it says why and lists where its links would have gone, with
  their hosts decoded. "Show original" brings the HTML back; images stay
  off even then, because loading one tells the sender the address is live.
  Other mail is unchanged, as before.
- **No image preload for suspect mail.** ADR 0225 fetches a new message's
  images at sync. That tells the sender the address is live at the moment
  of delivery, before anyone opens the mail. The preload pass now runs the
  same check (without history) and skips a `danger` message, as it already
  skipped spam.

## Alternatives considered

- **LLM only.** Put the From line in the prompt and let the model decide.
  This is the cheapest change, but it was the gap: a model told "Robinhood"
  by a convincing body is persuadable. A string comparison is not. It would
  also give no warning on the many opens where the read-time pass has
  already run (once per thread) or is still running past the open wait
  (ADR 0205).
- **A public-suffix list for registrable domains.** ADR 0150 declined that
  dependency. The small second-level list (`co.uk`, `com.au`) only affects
  how alike two addresses look, and every check says "does not match",
  never "is safe".
- **Fetching headers for old mail on open.** One provider round trip per
  open for a one-time gain. Old mail says "not available" instead.
- **Link text vs link target ("robinhood.com" pointing at a tracker).**
  Legitimate marketing does exactly this through ESP click-tracking, so as
  a rule it would warn on half of all newsletters. Only IP and punycode
  hosts are flagged. The model sees the link domains.
- **A Settings allow/deny list for senders.** It is not needed to flag
  anything, and ADR 0149 freezes mail-client surface.

## Next, not built

- Newly registered domains: needs an RDAP lookup per new domain, so a
  network call and a cache.
- A brand named in the subject or body but not the sender. Too noisy as a
  rule; the model has it.
- QR codes in images (the "scan to verify" campaign).
- Reply-chain hijack: a reply in a known thread from a new address.
- "Report phishing" back to the provider (ADR 0107: managing is theirs).

## Consequences

- `brands.ts` needs upkeep. A brand that adds a sending domain we have not
  listed produces a false danger on its real mail. The fix is one line in
  the table. Brand domains must never include a freemail domain, and a test
  depends on that.
- Migration 121 skips 120, which PR #137 takes. Migrations are applied by
  name, so the order of merging does not matter.
- Thread open makes three small queries more (history, sender-to, People
  names), all keyed on indexed columns.
- Not checked against the real prod Robinhood email: prod reads were not
  available from this session. The test uses the campaign's usual shape.
## Addendum 2026-10-27: on a likely fake, the Reply-To is the danger

A fake "Robinhood" email passed the provider's spam filter with
`Reply-To: friend.test@outlook.com`. The reader showed the same gentle
line it shows a newsletter ("Replies would go to ..., not to the
sender."), and it was not the headline: `brand_mismatch` was. On that
message a reply hands the answer, perhaps with account details, to the
person who sent it.

- **The rule** (`escalateReplyTo` in `check.ts`): when `reply_to_elsewhere`
  fires AND the message has any other `danger` signal, or any of
  `brand_mismatch`, `lookalike_domain`, `auth_failed`, `auth_weak`,
  `name_shows_other_address`, the Reply-To signal becomes `danger` and says
  so: "Replying sends your answer to X, which is not <brand, else the
  sending domain>. Don't reply, and don't share account details or codes."
  Otherwise it stays `caution`
  with the old words. The decision is in kernel so it is tested; the
  surfaces only read the signal.
- **`replyToWarning(check)`** returns the address, level, message and
  `confirmBeforeReply` (true on danger). `SenderCheck.replyTo` carries the
  address.
- **Reader** (iPhone, Android and web, one component): on a fake the
  Reply-To line shows on its own, red-bordered, below the headline finding,
  even when another signal is the headline. Reply, Reply all and Suggested
  on the reply menu ask first ("Reply to a likely fake?", Cancel / Reply
  anyway, Cancel is the default); Continue draft does not ask again. The alert waits 350 ms for the reply menu's
  Modal to close, since iOS drops an alert presented during that dismissal.
- **Chat**: `read_email`'s `senderWarnings` carry the danger wording (they
  are the signal messages). `reply_to_email`, at propose time, runs the
  same check on the message being answered; on danger the card's meta
  leads with the warning and the result carries `senderWarning` plus an
  instruction to say it first. `senderWarning` is stripped from the model's
  schema. The tool description tells the bot to warn before drafting.
- **Chord's reply now goes to the Reply-To** (owner decision). Before
  this, `replyRecipients` ignored it, so a reply to a mailing list, an
  assistant or a help desk went to the From address instead. Now
  `replyAddressOf` (kernel) answers to the Reply-To when there is one and it
  is not the user's own address, else the From. The composer, the
  `reply_to_email` card and every provider's send (when no audience is
  given) use it, so the warning above is true inside Chord too. A message
  the user sent still answers to its To line. Reply all keeps the Reply-To
  in To and copies the rest; the From is not added. The vacation responder
  names the sender explicitly, because RFC 3834 sends an auto-reply to the
  sender, never to a Reply-To. On a fake this is exactly why the confirm
  step exists.
- **Found with it**: an Outlook reply that named recipients replaced
  `payload.message`, dropping its attachments. The app always names
  recipients, so every Outlook reply with a file went out without it. Now
  merged, with a test (`outlook-api.test.ts`).
- **Consequence**: a message whose only other finding is `auth_weak` (no
  pass from SPF, DKIM or DMARC) plus a Reply-To at a personal address is
  now `danger`, so it renders as plain text too. Ordinary personal mail does
  not reach it: a Reply-To on the sender's own domain (gmail to gmail) is
  no finding at all, and Gmail, Outlook.com and Yahoo sign their mail, so a
  person on Gmail with replies to Yahoo passes DKIM and keeps the gentle
  line. Both are pinned by tests.
- Rejected: asking before every reply with a Reply-To elsewhere (the common
  case is legitimate and the prompt would be clicked through), warning only
  in the sender sheet (one tap away from where the user decides to reply).
- **Images can still be loaded** (owner, 2026-10-27): the plain-text notice
  on a suspect message offers **Show original with images** (the HTML with
  that message's images) beside **Show original without images** (once the
  original is showing it reads **Load images**); it says loading them tells the
  sender the address is read, and lasts until Back to plain text or the
  thread is left. It is never remembered for the sender (no "Always"), and
  the warnings stay. A suspect message no longer feeds the thread's
  "N images not loaded" banner, whose Show could not load its images.
  Prompted by a real American Express gift-card email from
  `email.amexgiftcard.com`; the brand table was deliberately not changed.

## Addendum 2026-10-28: nothing is suggested from a dangerous sender

A phishing email ("Robinhood Email Alerts" <gv@usdigitize.com>, the name
written with a Cyrillic о, asking the reader to call a support number) was
shown with a warning AND a "Call support at 1 866 465-0148" to-do card. Two
causes:

- `claimedBrandOf` matched the display name letter for letter, so one
  look-alike letter hid the Robinhood claim and only the mixed-alphabet
  caution fired. The name is now read through `latinSkeleton` first, the
  same mapping the domain check uses, so the claim is seen and
  `brand_mismatch` makes it a danger.
- No pass that makes suggestions looked at the check. The model was shown
  the findings and still turned the sender's call to action into a task.
  Now code decides, before any model call: when the check's level is
  `danger` (`isDangerousSender`), the suggestion sweep, the read-time pass
  and person extraction stage nothing from the email, and pending cards
  from it are withdrawn (`retractByProvenance`). A caution alone still
  allows suggestions.

Still acting on such mail, deferred: attachment import into the knowledge
base (ADR 0071) and the vacation responder (ADR 0124, which tells the
sender the address is live).

## Addendum 2026-10-29: hidden characters in a name; mail that goes to spam

A second phish got through, into a Hotmail inbox: "Coinbase Email Support"
<kz@bjhengye.net>, asking the reader to call +1 888 814 6053 about a phone
number change. Its sender domain passed SPF, DKIM and DMARC (it is the
phisher's own domain). The display name had U+E0139, an invisible
variation selector, between every letter, so `words()` read "c", "o",
"i"... and claimed no brand. Nothing reached `danger`, and opening the email
staged a to-do card. Microsoft's filter moved it to Junk about 15 minutes
later.

- **Any invisible character in a display name is `danger`**
  (`hidden_characters`, owner rule): a name has no reason to hide text. The
  one exception is the selector and joiner that are part of writing an
  emoji ("❤️"). This also covers names in scripts that use a zero-width
  joiner between letters, on purpose.
- `latinSkeleton` drops every combining mark and default-ignorable
  character before a name is matched, so the brand claim is also seen.
- A distinctive brand written in pieces or glued to a service word counts
  as a claim ("Coin base", "C o i n b a s e", "Coinbase.com",
  "CoinbaseSupport", "C0inbase"): the pieces must join to exactly the name,
  and a glued tail must be a service word, so "Venmore Realty" is not Venmo.
- The model-text invisible strip (ADR 0268, `utils/email-text.ts`) now also
  removes variation selectors, except an emoji's own.

**Mail the provider moves to spam retires what it produced** (amends ADR
0073/0143/0239). A thread whose every message is in Spam/Junk (or Trash)
withdraws its pending suggestions and archives its open to-dos with the new
reason `email_spam` ("its email went to spam"), including to-dos dated
ahead, which a delete keeps (ADR 0239): a phish's to-do was never owed.
Gmail: the history label change. Outlook: the removal probe now reports
`junk`; and since Graph gives a moved message a new id, a stored id that
answers 404 is looked up by its Message-ID before it is called a delete
(the Junk move in prod read as a delete, by luck; an archive read the same
way and lost its suggestions, against ADR 0073). Not covered: a Gmail spam
move seen only by a full backfill (the thread drops out of the listing and
reads as a delete, so a to-do dated ahead stays); IMAP Junk moves.

**Addendum 2026-11-09**: a later path skipped the "nothing is suggested from
a `danger` sender" rule. The ADR 0307 unsubscribe
offer asked no sender check, so a phish the user never opened could be the list
it offered to leave - a Chord card in the phisher's name, and a one-click POST
that tells them the address is read; `offerUnsubscribes` now skips it (not
marked offered) and offers the next list. (The read-time pass on a Spam or Trash
thread is left running: opening one is the user's choice, owner 2026-11-10.)
