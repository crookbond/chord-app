# ADR 0215 — A swipe can move mail to Trash

**Status:** Accepted
**Date:** 2026-09-28
**Amends:** ADR 0107, 0128, 0149

## Context

ADR 0128 gave Traditional email rows two swipes. One archives the thread and
the other toggles read state. Trash was left out on purpose: ADR 0107 put
filing (trash, star, move) on the provider's side, and ADR 0149 froze new
mailbox-management work.

The owner asked for a setting that makes the swipe move mail to Trash instead
of archiving it. That reverses part of those ADRs, so it is recorded here. It
does not meet ADR 0149's gate, because no shared family artifact comes out of
trashing mail. It is an owner decision to make an exception to that line, and
the rest of the line still stands.

The scope question was settled first:

- **Move to Trash** is covered by `gmail.modify`, which we already hold
  (`POST /threads/{id}/trash`). It needs no new scope, no re-consent and no
  change to the restricted-scope security assessment.
- **Permanent delete** (`messages.delete`, `batchDelete`) needs Gmail's
  full-access scope, `https://mail.google.com/`. The yearly assessment is the
  same, but it adds re-consent for every user, a harder scope justification
  ("why is Trash not enough?"), and a consent screen that says "permanently
  delete all your email".

## Decision

1. **Trash only, never permanent delete.** Every mailbox type moves the thread
   to its own Trash, where the user can restore it until the provider empties
   it:
   - primary and secondary Gmail use `threads.trash`;
   - Outlook moves each message to the well-known `deleteditems` folder;
   - IMAP moves the inbox copies to the `\Trash` special-use folder, falling
     back to a folder named Trash/Deleted.
2. **A per-user setting**, `users.email_swipe_action`, set to `'archive'`
   (the default, so nothing changes for anyone who doesn't choose) or
   `'trash'`. It is chosen with a pair of chips in Settings and applies to the
   leading swipe only. The other swipe still toggles read state.
3. **`trash: true` on the modify requests**, both single-thread and bulk.
   There is no `trash: false`: taking mail back out of Trash happens in the
   provider, as ADR 0107 still says.
4. **The mirror looks the same whichever side did the trashing.** After the
   provider accepts, every message gets `TRASH` and loses `INBOX`. The thread
   leaves the inbox straight away, and `recomputeThread` retracts the thread's
   pending suggestions and retires its to-dos (ADR 0073/0143), exactly as it
   does when the user trashes the mail in Gmail. The inbox folder predicate
   also excludes `TRASH`, in case a provider leaves `INBOX` on a trashed
   message.
5. **A refused write fails honestly (ADR 0107).** An IMAP mailbox with no
   Trash folder, or an IMAP thread that is no longer in the inbox, is refused
   with a sentence the user can act on, and the mirror is left untouched. A
   stored IMAP UID belongs to the folder the message was in when it synced, so
   once the message is archived that UID means nothing in INBOX. A move would
   then "succeed" on mail it never touched.
6. **Chat parity: `trash_email`**, personal 1:1 only. It is a proposal like
   `forward_email` (ADR 0214), because the model picks the thread by id from a
   search and a wrong pick would trash the wrong mail. The card shows the
   thread's real subject, resolved on the server. On confirm it calls the same
   service functions as the swipe. The swipe *setting* has no chat tool: it
   only changes what a finger gesture does, and there is nothing to say about
   it in chat.

## Alternatives considered

- **Permanent delete** — needs the full-mail scope. See Context: re-consent
  for everyone and a harder verification, for a result Trash already gives.
- **A third "Trash" swipe or row button instead of a setting** — the owner
  asked for a choice of what the one swipe does. The trailing swipe is taken
  by read/unread, and a swipe that does something different depending on how
  far you pull it is easy to trigger by accident.
- **Mirroring trash by deleting the local rows** (what IMAP/Outlook sync does
  when it finds mail in Trash) — the labels approach is identical on every
  provider, and the next sync converges either way.
- **A per-device setting (AsyncStorage)** — ADR 0147 kept its view choice
  per device. This one is stored on the server like the other email prefs,
  so it follows the user to a new phone. A gesture that trashes mail should
  not quietly change meaning between devices.
- **Directly trashing from chat without a card** — every other chat tool that
  acts on the user's mailbox is confirmed with a tap (ADR 0214), and Trash is
  not undoable from Chord.

## Consequences

- There is no undo in Chord. Restoring means opening Trash in the mail app.
  The Settings copy says so.
- The Trash *folder* stays a stub in the folder sheet (ADR 0108). Gmail's
  backfill still reverse-deletes trashed rows, so a Trash view would be right
  one day and empty the next.
- The bulk selection bar has no Trash button yet. The route supports it, so
  it is a one-line client change if wanted.
- IMAP can trash only mail that is still in its inbox, and says so otherwise.
- Swiping with Trash chosen is immediate, like archive. The row disappears
  optimistically and the refetch brings it back if the provider refused.

## Addendum 2026-09-28 — Trash without a swipe

A swipe is a touch gesture, and on the web app there was no other way to
trash mail. Three additions, all client-only (the server already accepted
`trash: true`, single and bulk):

- **A Trash button in the selection bar**, next to Archive. One email goes
  straight to Trash; several ask first ("Move N emails to Trash?") through
  `confirmDestructive`, because `Alert.alert` renders no buttons on web.
- **A Trash button in the open email**, next to Archive. It goes back to the
  list like Archive does. No confirm: it is one deliberate click on
  something the mail app can restore.
- **A checkbox on hover, web only.** Long-press is how the phone starts a
  selection, and nobody long-presses with a mouse. On web the checkbox is
  **always mounted** and only its look changes on hover. Pressing the mouse
  hands the pointer to the row's swipe gesture, which fires a hover-out, so
  a checkbox that unmounted on hover-out was gone before the click landed:
  the first build had exactly that bug, and it only showed up in a real
  browser.

The row's whole-body click still opens the email; the checkbox is the only
target that selects.
