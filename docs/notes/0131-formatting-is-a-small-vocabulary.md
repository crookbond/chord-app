# 0131 — Formatting is a small vocabulary, deliberately

**Status**: accepted
**Date**: 2026-08-25
**Relation**: closes §1.2's rich-text row in
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md), which
[ADR 0069](./0069-reply-composer-recipients-html-signature.md) had explicitly
deferred.

## Context

ADR 0069 sends `multipart/alternative` where the html part is *derived* from
the plain text — escaped, with newlines turned into `<br>`. The user cannot
bold a word, make a list, or attach a link to a phrase. For a family app that
is mostly fine, and it is visibly not fine the moment someone writes out a
packing list or wants one line to stand out.

The obvious build is a WYSIWYG editor. React Native has no built-in one, so
that means a new dependency and a new native build, to serve a composer people
mostly use for three sentences.

## Decision

**A small markdown subset, rendered on send.**

`**bold**`, `[text](url)`, `- bullets`, `1. numbered`, and bare URLs
autolinked. The plain-text part keeps the markers exactly as typed, which is
the whole point of markdown: it reads fine unrendered, so the half of the
world that sees the text part loses nothing.

### Small is the decision, not a first step

Every marker added is a character that also occurs in ordinary prose, and
mangling what someone typed is worse than not formatting it.

**Italics are deliberately absent.** A single `*` turns up in maths, in
footnotes, in `2 * 3`, and in people typing `*sigh*`. `**` does not occur by
accident. Underscores are worse: `snake_case_names` are everywhere. So bold
gets in and italic does not, and that asymmetry is the point rather than an
oversight to fix later.

### Nothing changes for a message that uses no formatting

`textToHtml` renders markdown only when `hasMarkdown` says there is some;
otherwise it produces the same escaped-with-`<br>` html it always did, byte for
byte. That is the ADR 0111 posture — a send with no attachments produces an
identical MIME body — applied to formatting.

It also means the change cannot regress a message nobody meant to format.

### Escaping happens first

Then, and only then, our own markers become tags. Markup someone typed stays
text, which matters because the body is going into an html document we author.

`[text](url)` accepts **http, https and mailto only**. An unsafe scheme keeps
its literal text rather than becoming a link: relaying a `javascript:` href
that arrived in someone's mail is one thing, and *writing* one into outgoing
mail is another.

### Preview rather than a toolbar

A toolbar implies a selection model the composer does not have. Instead the
Preview toggle renders through the same `EmailBody` the reader uses, so what
you check is what the recipient's client will be handed — and it appears only
when the body actually contains formatting, since a toggle above every plain
message is furniture.

## Consequences

- Lists and emphasis work in compose, reply and forward, on all four provider
  paths, because they all route through `textToHtml`.
- A body typed with markdown reaches text-only clients as legible markers
  rather than as stripped-out formatting.
- Someone who genuinely wants a literal `**` in a sentence will get bold. That
  is the cost of any markdown, it is rare, and the preview shows it before
  sending.
- The vacation responder's body (ADR 0124) is user-authored and goes through
  the same path, so it formats too. That is the right answer, and it was worth
  checking rather than assuming.

## Alternatives rejected

**A WYSIWYG editor** (`react-native-pell-rich-editor` or a WebView editor). A
new dependency, a new native build, and a much larger surface — for a composer
whose typical message is three sentences.

**Full CommonMark.** Headings, tables, code fences and blockquotes in an email
composer serve almost nobody, and every extra marker is another way to
accidentally format prose.

**Italics via `*` or `_`.** The single most requested marker and the one with
the worst false-positive rate in ordinary text.

**Render markdown for every body unconditionally.** Simpler code, and it
changes the bytes of messages that contain an incidental `-` at the start of a
line. Gating on `hasMarkdown` keeps the existing behaviour exactly.
