# 0311 — Offline, the app shows what it saved and stops asking

**Status**: accepted
**Date**: 2026-10-30

## Context

Opening the app in airplane mode put a signed-in person on the **sign-in
page**. The launch asks the server `/health` and `/me` (ADR 0254); with no
network both fail, the launch state becomes `offline`, and `bootScreen` sends
anything that is not "the server confirmed who you are" to the landing page.
Nothing on the phone recorded who had been signed in, and the launch check ran
once, so turning the network back on did not help until the app was killed.

Already inside the app, losing the network made every screen keep asking:

- every live stream re-polled from 3 s, doubling to a minute, forever while the
  screen was up (ADR 0082's backoff bounds the rate, not the duration); on web
  the browser's EventSource reconnected every few seconds;
- every tab switch, return to the foreground (ADR 0082 addendum) and pull fired
  a fresh request, each failing and printing "Network request failed";
- there was no shared notion of "offline": the email device store (ADR 0304)
  counted its own failures, the thread reader had its own flag, and the rest
  had nothing.

Email (ADR 0302/0304) and Calendar (`calendar.cache.v1`) already keep a saved
copy to show. Chats and To Do's do not; that is phase 2, not this ADR.

## Decision

**One answer to "can we reach the server?", decided by what requests do.**
`mobile/src/network.ts` holds it. Every call to Chord's server goes through
`apiFetch` in `api.ts`:

- offline: it throws `OfflineError` at once and touches no network;
- a request that never reached the server (`isNetworkFailure` in kernel: a
  `TypeError` worded "Network request failed" / "Failed to fetch" / "Load
  failed" / "NetworkError…") asks for **one check** of `/health`. One failure
  is not proof (a lift, a Wi-Fi handover), so only a failed check goes
  offline. Any answer at all, error statuses included, means reachable;
- while offline and in front, one check runs after 5 s, doubling to a minute
  (`offlineProbeDelay`), plus one immediately on every return to the
  foreground (and on web, the browser's `online` event or the tab becoming
  visible). The browser's `offline` event goes offline at once.

Not an OS network library: none is in the shipped native builds (adding one is
a store build, this ships over the air), and "the phone has Wi-Fi" is not
"Chord's server answers" (captive portals, a server outage).

**What going offline does.**

- Live streams park exactly as they do in the background (ADR 0082), on every
  platform now, and reopen with their `onOpen` backfill when the server is
  back. A stream error asks for a check (at most every 15 s).
- `useForegroundRefresh` skips while offline and reloads the focused screen
  when the server comes back; a pull while offline runs the check instead.
- The email device pass (ADR 0304) does not start offline and wakes on
  reconnect.
- Screen loads that fail with `OfflineError` show no error (`loadErrorText`):
  Email, Calendar, To Do's, the chat list and a chat keep what they show.
  Actions that change something still fail, now with "You're offline. Chord
  will catch up when the network is back." instead of a raw network error,
  except sending, which waits in a queue (see "Chat queue" below).
- A strip above every screen says "Offline · showing saved data · tap to
  retry" (tapping checks now). A strip, not a floating pill: a pill covered
  the calendar's date and would cover a header or a composer somewhere. It
  takes the status-bar inset and gives the screens a zero top inset so headers
  are not padded twice, and the tree has the same shape with and without it,
  or the navigator would remount and lose its history each time the network
  came or went. Hidden on the landing page, which has its own "can't reach"
  line.

**A launch with no server opens the app as the saved user.** Whenever the
server confirms who is signed in, the user is saved (`chord.savedUser.v1`). It
is removed by sign-out with every other key (it is not on the ADR 0269 keep
list) and when the server says the session is over. `getMeOutcome` tells the
two failures apart: only a 401/403 is "rejected"; no network or a server error
is "unreachable" (`meOutcomeForStatus`). `enterWithSavedUser` (kernel, tested)
opens the app when the session token is still on the device, the server could
not be asked, and a saved user exists. When the server is next reachable, `/me`
is asked again: a fresh answer replaces the saved one, a rejected session goes
to the sign-in page. A launch that lands on the landing page offline (no saved
user) re-runs its check when the server comes back.

`bootScreen` is unchanged: offline with nobody saved still lands on the
landing page, which says it cannot reach the server.

## Consequences

- Phones get it over the air. Detection of airplane mode turning on is "the
  next request fails", not instant; turning it off is noticed within a minute
  (sooner on returning to the app or tapping the strip).
- A user who signs in on a build with this change is saved from then on; an
  existing session is saved at its next launch with a network. Until then an
  offline launch still lands on the landing page.
- Phase 2, not built: saved copies of the chat list, recent messages and the
  To Do's tabs, in the encrypted device store email uses (ADR 0302), since
  messages are as sensitive as mail. Until then those screens are empty after
  an offline launch, with the strip explaining why.
- Later, with a native build: `@react-native-community/netinfo` behind
  `importIfNative` (ADR 0258 addendum) for instant airplane-mode detection.
- No bot tool: a network-state behaviour, not a capability.

## Rejected

- **NetInfo now** — a native module, so a store build before anyone benefits,
  and it still cannot tell "connected" from "Chord's server answers".
- **Going offline on the first failed request** — one dropped request in a
  tunnel would flash the strip and park every stream.
- **Keeping requests going and only hiding the errors** — leaves the retry
  storm this was about, and drains the battery for nothing.
- **A floating pill** — covers some screen's header, date or composer.
- **Queueing every write while offline** — a tick, a rename or a delete made
  against data that may have changed meanwhile needs conflict rules; those say
  they cannot be done. Sending is queued (below), because a message or an
  email is new content, not a change to something that may have moved.
- **Saving the user only on the launch route** — any later sign-in path (Apple,
  Microsoft, a profile edit) would leave a stale copy; the store subscription
  saves on every confirmed change.

## Chat queue (addendum 2026-10-30)

Owner: a chat message sent offline should wait and go out in order ("queue
them on FIFO"); an email Send made offline goes to "a queue called outbox".
One queue serves both.

- **One send queue** (`mobile/src/send-queue.ts`, rules in kernel
  `send-queue.ts`). Each kind registers how it is sent (`registerSender`); the
  queue keeps the line and works through it oldest first whenever the server
  answers (`onNetworkChange`, sign-in, and every new send). It builds on what
  exists: chat uses `postMessage` unchanged; email (below) hands waiting mail to
  the server's own outbox (ADR 0113/0115).
- **In order.** While a send of a kind is waiting, a new one of that kind joins
  the back of the line even if the network is back, or it would overtake an
  earlier message and the bot would read the chat out of order. Kinds do not
  block each other.
- **Failures.** No network or a 5xx stops the pass and keeps the order (a 5xx
  while online retries after 30 s). A 4xx other than 408/429 will not change on
  retry: that send is marked failed with the server's reason and stays, with
  Retry and Delete; the rest go on. Nothing disappears silently.
- **Sealed only** (owner decision). The queue is a sealed file in the signed-in
  user's ADR 0302 device folder (`readDeviceJson`/`writeDeviceJson`, newly
  exposed from `email-device-store.ts`: same key, same folder, removed with
  sign-out). Never plain storage. A build without the key store keeps the queue
  in memory only: it works while the app is open and is lost if the app is
  closed before the server answers. On web it lasts as long as the page. The
  folder is in the cache directory, which iOS can empty under severe storage
  pressure; accepted with the ADR 0302 choice.
- **In the chat**, a waiting message shows where it was written, dimmed, with
  "Waiting to send" (`queued-message.tsx`); the text box clears as on a normal
  send. The typed text, a tapped answer chip and a contact address picked for
  an invite all go through the queue (`sendChatText`).
- **Not queued:** files (an upload needs the bytes on the wire, and a picked
  file's address on the phone is not guaranteed to outlive the app).
- **Known gap:** if the connection drops after the server stored a message but
  before the phone heard back, the message is sent again. Closing it needs a
  client id on `PostMessageRequest` that the server deduplicates on; not built.
- No bot tool: client-side delivery, not a capability.

Verified on web with the dev server stopped: two messages showed "Waiting to
send" in order; starting the server sent them in that order and the bot
answered each. Not run on a phone.

## Email outbox (addendum 2026-10-30)

Offline, every email composer (new message, reply incl. Suggested, forward)
failed on Send and kept nothing, and Cancel → Save draft closed as if it had
saved: autosave swallows a failed server save (ADR 0113), so the email was gone.
Owner: an email sent offline goes to "a queue called outbox"; a draft that
cannot reach the server is "bad, save locally"; once connected, "it goes".

- **On the shared queue, kind `email`.** Each composer catches `OfflineError`
  and queues the whole send (`EmailOutboxPayload` in `mobile/src/email-outbox.ts`:
  kind, thread, mailbox, send-as, to/cc/bcc, subject, body, attachment ids, the
  message replied to or forwarded, include-files, the server draft id). While an
  earlier email waits, a new Send joins the line even online
  (`useEmailWaiting`). The notice says it is in the Outbox.
- **Sent the way the composer sends when it does not queue**
  (`outboxSendPath`): `sendEmail`, `replyEmailThread`, `forwardEmailThread`,
  with the draft id so the server clears the draft. Not through the server's
  undo queue (ADR 0115): there is no composer left to undo from, mail that has
  already waited should not wait again, and that queue sends a reply to the
  thread's newest message, losing the one the user answered. A payload missing
  what it needs (`outboxItemProblem`) is refused like a 4xx: kept in the Outbox
  with its reason.
- **Drafts kept on the phone.** The existing autosave (`email-draft.tsx`), when
  a save stops for the queue's reasons (no network, server error), writes the
  draft to a sealed device file (`email-phone-drafts`, `writeDeviceJson`); the
  composer reopened for the same draft or thread restores it first; it is
  uploaded with `saveEmailDraft` by the open composer on reconnect, or for
  closed composers by `uploadPhoneDrafts` (open ones skipped, so nothing uploads
  twice). Save draft offline says "Saved on this phone". One key per composer
  (`localDraftKey`): reply/forward per thread, resumed draft by server id, new
  message by composer id. Sending drops the phone copy.
- **Outbox screen** (`/email/outbox`, folder sheet "Outbox (N)"): queued email
  with Send now / Retry and Delete, and the drafts kept on the phone (tap to
  reopen, Delete). Server items in their undo window are not listed.
- Rules with tests in kernel `email-outbox.ts` (send path, payload check); the
  sender, payload type and phone drafts in `mobile/src/email-outbox.ts`,
  registered from the root layout. Sealed only, memory-only without the key
  store, as the queue.
- Not covered: a file cannot be attached offline (it must already be on the
  server); a draft restored from the phone shows its files as "Attached file".
  No bot tool: client-side delivery.

Verified on web with the mock mailbox and the dev server stopped: an offline
Send was queued and went on reconnect carrying its draft id, and the server
draft was cleared; a draft written offline was uploaded once on reconnect. Not
run on a phone; reply/forward offline sends only typechecked.

## Saved copies for the AI view and Action Items (addendum 2026-10-31)

Owner, testing offline on the phone: the AI mailbox showed nothing, the
compose button was gone, and the box to write to the bot sat behind the
keyboard.

- **AI view and Action Items keep a copy.** `readWithSavedCopy` (kernel
  `saved-read.ts`, tested) wraps a read: an answer is saved when it changed,
  and only a request that never reached the server (`OfflineError`) is
  answered from the copy; a refusal from the server never is. Applied in
  `api.ts` to `getEmailStatus`, `listEmailTiles` (keyed by parent and depth,
  which also carries the category tree and recent mail the AI views draw
  from), `listEmailDecisions` and `listAllProposals` (Action Items). Stored
  sealed in the ADR 0302 device folder like the send queue (`read-<name>`
  through `readDeviceJson`/`writeDeviceJson`; the store registers itself with
  `setSavedCopyStore`, since it imports `api.ts`); nothing kept on a build
  without the key store, memory only on web; gone with sign-out.
- **The compose button was a missing status, not a hidden button.** It is
  drawn when `hasAnyMailbox(status)`; offline the status read failed and the
  screen behaved as if no mailbox were connected. The saved status brings it
  back, and an offline Send goes to the Outbox (above).
- **The chat box under the keyboard was this ADR's own strip.** On iPhone
  `KeyboardScreen` padded by the header's height, but the strip sits above
  the header and takes the status-bar inset, so offline the chat, the
  composer and the email reader were short by the strip (~70pt). The strip
  now reports its height (`useOfflineStripHeight`) and `keyboardOffset`
  (kernel) adds it. Android measures against the window and was not
  affected; `KeyboardScrollView` measures the same way.
- Not covered: the Cards view's expanded list of a category's mail
  (`listEmailThreads` by category) and the other To Do's tabs; both show
  what is in memory, nothing after a fresh launch offline.

## Addendum 2026-10-31: the rest of To Do's

The saved-copy addendum kept only Action Items' suggestions. Every other
To Do's tab (Tasks, Lists, Saves, Trips, Attachments) and the group list
were read straight from the server, so after a cold start offline those
tabs showed a spinner and the group chips had no names.

- Tasks, lists, saves, facts, trips and files are wrapped in `withSavedCopy`
  in the screen's `LOADERS` (`mobile/app/catchup/[tab].tsx`), not in the
  `api.ts` functions: the Reminders sync (`applesync/`) reads tasks and
  lists too and must act only on what the server says.
- `listGroups` (chips, chat list, People) and `getEmailReceipts` (Findings)
  are wrapped in `api.ts`; every caller only displays them.
- Same rules as before: used only on `OfflineError`, sealed, removed at
  sign-out, memory only on web.

Still not saved: the calendar's events, the People screen's people and an open chat's messages.

## Addendum 2026-10-31: editing to-dos and lists offline

Until now a to-do or list change made offline failed with "You're offline".
They are now queued like chat messages and replayed when the server answers.
Replaying blindly would overwrite whatever someone else changed meanwhile,
so each change says what it expected.

- **What is covered.** To-dos: add, tick, drop, delete, edit title, notes,
  due date or who it's for. List items: add, tick, edit, delete. Creating,
  renaming, deleting or moving a whole list stays online-only: those change
  many rows at once or depend on the answer.
- **One path, online too.** Every such change is a `TodoOp` (kernel
  `todo-sync.ts`) sent through the send queue (kind `todo`) to
  `POST /me/todo-sync`. The server (`todo-sync.service.ts`) locks the row and
  writes through the same task and list service functions the routes and the
  bot use.
- **The rule.** A change carries, for each field it touches, the value the
  phone last saw. A field is written only if the server still holds that
  value; one already holding the new value counts as done; one someone else
  changed comes back as a conflict and is not overwritten. Two people changing
  different fields of one to-do both win. Ticking an item can never conflict
  (a boolean either matches what was seen or already has the new value).
  Deleting something changed since asks first; changing something deleted
  since is reported. No version column was added: tasks and list items have
  no `updated_at`, and comparing values needs none.
- **Conflicts.** Shown at the top of Tasks and Lists under "Couldn't sync":
  *Due date: yours Mon, now Wed* with **Keep mine** (sends only the lost
  fields again, without the check) or **Keep theirs**. It does not say who
  made the other change: nothing records that.
- **On the screen.** Changes still waiting are laid over the saved copy
  (`applyPendingTodoOps`), so they survive closing the app. Something created
  offline has a `tmp_` id; when the server gives it a real one, later queued
  changes to it are sent under that.
- **Sent once.** Every queued send now carries an `Idempotency-Key`: the
  queue's id for it, made before the first attempt (the email composers make
  one per Send and reuse it if they fall back to the Outbox). The server keeps
  the first answer in `client_requests` (migration `136`, per user, pruned
  after 7 days) and returns it to a repeat, so a retry after a lost answer
  does not post, email or create twice. A repeat while the first is still
  running gets 503 (try later); a first attempt that failed with a 5xx is
  forgotten. Applied to to-do sync, chat posts and email send, reply and
  forward.

Rejected: last write wins (silently loses the other change), a version
number per row (a migration and every writer bumping it, to answer what the
expected values already answer), queueing whole-list operations.

### Tested with writers at the same moment

Two people, and one person on two devices, sent each kind of change at gaps of
0 to 250 ms; the rule held in every case. One real bug came out: two adds of
the same list item at once made two items, because `addItem` looked for a
match and then inserted with no lock. It now takes ADR 0165's advisory lock
on the list and the item's normalised text, so the app route, the bot and
offline replays are all covered. The same to-do added on two devices still
makes two (ADR 0095: app creates are not folded). The scenarios are kept in
`server/scripts/concurrency` and the overlap tests run in the server suite
on `openParallelHandle` (`docs/ops/concurrency-tests.md`).

### Every To Do's tab is kept, and a suggestion can be answered offline

Reported 2026-11-01: offline, To Do's showed nothing unless that tab had been
opened before the network went, and ✓ / ✕ on a suggestion did nothing.

- A saved copy was written only when its tab loaded, so a tab never opened
  had none. `mobile/src/todo-copies.ts` now refreshes every To Do's copy
  (tasks, lists, saves, facts, trips, files, suggestions, chat list) at
  sign-in, on reconnect and on return to the foreground, at most every 5
  minutes (`shouldWarmSavedCopies`). The loaders moved there from the screen.
- ✓ / ✕ on a suggestion called the server directly and an offline failure
  was only logged. It now goes through the send queue as kind `proposal`
  (`mobile/src/proposal-answers.ts`): sent at once when it can be, else kept
  and sent when the server answers, with the queue's `Idempotency-Key`
  (confirm and reject now take it, so a retry after a lost answer is not
  refused as "already answered"). Until sent, every read of suggestions and
  email decisions shows it answered (`applyPendingProposalAnswers`). A trip
  bundle's answer covers all its members. A refusal when it is finally sent
  (answered elsewhere, expired, a calendar still to pick) is listed under
  "Couldn't send" with Retry / Discard. Applied in To Do's, the email cards,
  the urgent strip, the batch card and the calendar's suggestions; an email
  card answered offline says it will be added when back online.
- An invitation's Yes / Maybe / No is NOT queued: the organizer is answered
  first (ADR 0104), and an unanswered invitation must keep looking like one.

## Addendum 2026-11-13: every launch opens from the saved user

A launch with a session and a saved user no longer waits for the server.
Before, it showed a spinner until `/health`, then `/me`, then the AI-consent
check had answered, which after a long time away (cold start, slow network)
was the first thing people saw. Now `openFromSavedUserAtLaunch` (kernel) opens
the app from the saved user at once, and the `/me` already in flight is the
background check (`enterAsSavedUser(saved, { pending })`): a fresh answer
replaces the saved copy, a rejected session goes back to the sign-in page.
The consent question is skipped on a launch when this device saw the same
user agree (`chord.aiConsentAgreed.v1`, removed on sign-out,
`aiConsentKnownAtLaunch`); the server's answer still runs and updates it, and
the server still gates AI (ADR 0283). The sign-in options from `/health` are
not read on that path (the landing page is not shown).

## Addendum 2026-11-15: every screen paints its saved copy first

The saved copies were read only offline, so online every screen opened to a
spinner or an empty list until the server answered, with the data already on
the phone. Now the saved copy is shown while the server is asked, and the
answer replaces it (kernel `showSavedThenFresh`; a copy read after the answer
is never shown, a failed request leaves the copy up). `readSavedCopy(name)`
in `api.ts` reads what `withSavedCopy(name, …)` saved. Where it applies:

- To Do's: every tab's first load of a key (`TODO_SAVED_NAMES`).
- Chat list and group chips: the app store is filled from the saved groups
  at sign-in while still empty.
- Each chat: the newest 50 messages are saved per chat (`messages-<id>`) and
  painted on open; the server page then replaces them as before.
- People: its list is now saved (`people`) and painted first.
- Email AI view: saved mail status, decisions and recent-mail tiles.

Calendar already did this from AsyncStorage; Settings has no full-screen
wait. Phones only, and only on a build with the key store (ADR 0302): the
web keeps saved copies in memory for the page alone, so a reload still waits.
