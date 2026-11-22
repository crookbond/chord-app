# 0309 — A filing rule is Chord's; the folder it files into is the mailbox's

**Status**: accepted
**Date**: 2026-10-29

## Context

The owner asked for filters from chat: "send emails from a person, or from a
company's domain, to folder Z", creating Z if it does not exist and keeping it
on the user's own mail server. ADR 0107 left filing to the provider and ADR
0123 declined a filter editor (a second writer racing the provider's own
filters), and ADR 0149 froze new mail-client features. This is an owner
exception, in the family of ADR 0215 (swipe to Trash) and ADR 0308 (send a
sender's future mail to Trash).

There were two ways to build it. A real provider filter (a Gmail filter, an
Outlook inbox rule) needs `gmail.settings.basic` / `MailboxSettings.ReadWrite`,
so a re-consent for every user and a wider security review, and IMAP has no
common filter store (Sieve is separate and rarely offered). The other way works
on every mailbox with the permissions Chord already holds.

## Decision

**A rule lives in Chord; the folder lives on the mailbox.** `users.defaults`
key `email_filing_rules` holds up to 100 rules `{ id, kind: sender | domain,
value, folder, since }`. After each sync (with the mailbox passes, above the AI
consent and billing gates, no AI call), `email/filing.service.ts` takes inbox
mail whose sender matches a rule and that arrived after the rule's `since`
(up to 25 threads a pass) and files it:

- **Gmail** (primary and attached): the label named Z, created if missing
  (`findOrCreateGmailLabel`, case-insensitive like Gmail), is added and INBOX is
  removed, through the existing label write. Z may be nested (`Kids/School`).
- **Outlook**: a top-level mail folder named Z, found by name (case-insensitive)
  or created, and each inbox message moved into it.
- **IMAP**: a mailbox named Z, found or created, and the thread's inbox
  messages moved into it.

In every case the thread leaves the Chord inbox the way an archive does (INBOX
removed in the mirror). A failure on one thread is logged and the rest go on;
nothing is ever deleted.

**Matching.** A sender rule matches the address exactly (case-insensitive); a
domain rule matches that domain and its subdomains (`school.org` takes
`news.school.org`). An exact sender rule beats a domain rule; then the oldest
rule wins. A sender with a "send to Trash" rule (ADR 0308) goes to Trash, not a
folder.

**Only new mail, unless asked.** `since` is when the rule was made, so mail
already in the inbox stays put; `alsoExisting: true` sets `since` to the epoch
and files what is already there too, 25 threads a pass.

**Folder names.** 1-100 characters; `/` is allowed on Gmail (nesting) and
refused for an Outlook or IMAP mailbox at filing time (logged, thread left),
since nested folders differ per server. `INBOX`, `Trash`, `Spam`, `Sent`,
`Drafts` and `Archive` are refused as targets.

**Chat and app.** Proposable `add_mail_filter { from, folder, alsoExisting? }`
(one card; `from` is an address, a domain, or a person's name resolved through
the user's own mail per ADR 0270: several people = ask, none = say so),
read-only `list_mail_filters`, immediate `remove_mail_filter { from?, folder? }`.
`GET/POST /me/email/filters`, `DELETE /me/email/filters/:id`, and a Filters
screen (email folder sheet → Filters) to see, add and remove rules.

## Alternatives considered

- **A real Gmail filter / Outlook rule**: runs when Chord does not, but needs a
  broader scope and a re-consent for everyone, and has no IMAP equivalent.
- **A Chord-only label (ADR 0141)**: the user asked for the folder on their
  mail server, and ADR 0142's push only names categories/keywords, never moves.
- **Leaving the mail in the inbox and only labelling it**: not what "send to
  folder Z" means in any mail app.

## Consequences

- Filing happens on sync: mail that arrives while Chord is not syncing waits in
  the inbox until the next sync, and other mail apps may see it there briefly.
- Two writers (ADR 0107's concern): a provider filter the user also has may
  move the same mail first; Chord's pass then finds it out of the inbox and
  leaves it.
- A sender that changes address or domain is not caught; the rule is literal.
