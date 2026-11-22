# ADR 0339 — An email is written Plain or Rich, and shows as it will go

**Status:** Accepted, 2026-11-13. Amends ADR 0131 (formatting is a small
vocabulary), ADR 0260 (signature in the box) and ADR 0338 decision 3 (which it
replaces).

## Context

The composer was one plain text box. A rich signature sat in it as text (the
logo as its address, each link as "text (address)") and only became rich at
send, by an exact text match (`outgoingBodies`). ADR 0338 first drew the rich
signature under the box. The owner's answer: "we should be able to compose in
plain or rich, and it should show as such." Two owner decisions followed:

- **Rich means formatting the text**: bold, italic, underline, lists, links,
  with the rich signature at the bottom of the page.
- **A composer opens the way the email it answers was written**: a reply or
  forward to an HTML email opens Rich, to a plain-text one Plain; a new
  message opens Rich; a saved draft opens the way it was saved.

ADR 0131 and 0260 had both rejected a WYSIWYG editor because it meant a native
module and a new build. The Settings signature editor (ADR 0260 addendum,
2026-11-13) since showed another way: an editable page in a sandboxed iframe
(web) or a WebView (phones, already in every build).

## Decision

1. **A Plain / Rich switch in every composer** (reply, new message, forward),
   `FormatSwitch` + `useComposeBody` + `ComposeBodyEditor` in
   `mobile/src/compose-body.tsx`.
   - **Plain**: the text box as before, the signature as plain text, and the
     message **goes as text only** (no HTML half) where the provider allows;
     Graph always takes HTML, so Outlook gets the text escaped.
   - **Rich**: an editable page (`composeEditorDocument` /
     `COMPOSE_EDITOR_SCRIPT`, `kernel/src/email-compose-editor.ts`), a
     toolbar (B, I, U, bulleted, numbered, Link, Clear) that sends the page a
     command, and the rich signature at the bottom as its own block, drawn as
     it will be sent. The page reports its HTML and text; the server cleans
     the HTML on send (`sanitizeQuotedHtml`, the same allow-list as a quoted
     original), so the page is trusted with nothing. Web: sandboxed iframe,
     `allow-scripts` only, a per-page nonce, commands accepted from the
     parent window only. Phone: a WebView, commands by `injectJavaScript`.
2. **The text body stays the source of truth for everything that already
   reads it**: autosave, "only the signature means empty", the AI ask, the
   offline outbox. In Rich the text is kept in step with the page
   (`richToPlain`: what is written, then the plain signature while its block
   is there). A text change the page did not make (an AI draft, a restored
   draft, a signature that arrives late) rebuilds the page from the text
   (`plainToRich`); typing does not, so the caret stays put. Switching Plain
   to Rich turns an unchanged saved signature into the rich one; Rich to
   Plain puts the plain signature back.
3. **The wire carries how it was written**: `format` ('plain' | 'rich') and,
   for rich, `bodyHtml` on reply, send, forward, draft save and the offline
   outbox. Absent = an app from before this change, which keeps the
   `outgoingBodies` rule. One server step, `composedBodies`
   (`services/email/signature.ts`), used by every send path and the
   Drafts-folder copy; a rich forward puts its note above the forwarded
   email, which stays text (ADR 0112).
4. **Drafts keep it**: `email_drafts.body_format` + `body_html` (migration
   `149`, `body_html` sealed like `body`, and in the encryption backfill). An
   older app's autosave, which sends no format, leaves both alone.

## Consequences

- A rich reply's quote (ADR 0338) keeps the original's formatting; a plain
  reply quotes it as `> ` text only.
- The forward preview says whether the original was HTML
  (`EmailForwardPreview.originalIsHtml`) so the note opens the matching way.
- Formatting made in Rich is lost if the text is changed from outside (an AI
  rewrite, another mailbox's signature): the page is rebuilt from text.
- No new native module, so this ships over the air. Not run on an iPhone or
  Android device; the WebView path is the one the signature editor already
  uses.

## Rejected

- **A rich text library** (a native module and a new build, ADR 0131/0260).
- **Rich only for the signature** (the owner wants to format the text).
- **Markdown in the plain box as the rich mode** (ADR 0131 stays as it is for
  Plain; it is not what "rich" means to the person writing).
- **Storing only HTML** (every check that reads the text body would need a
  second reader).
