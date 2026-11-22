# 0320 — The list stays while you reply, and a connect that added nothing says so

Status: accepted (2026-11-05)

## Context

Three complaints from the owner, two about the mail reader and one about
attaching a mailbox.

**The reader takes the whole window.** ADR 0222 made the composer a layout of
the thread screen and explicitly rejected "keeping the side-by-side split on
wide screens — owner call: one composer everywhere". On a phone that is right.
On a 1440-wide browser it means the mail list disappears the moment an email is
opened, and everything else disappears the moment a reply is started.

**A reply cannot change its audience.** The only way into reply-all is the
reader's reply menu (ADR 0222), and the composer replaces the reader. Realising
mid-sentence that the other parents should be on it means Cancel, re-open the
menu, Reply all — and the draft is reopened from autosave rather than carried.
The owner's follow-up on the first cut of that switch said where it belongs
and what it must not cost: "we can have it in cc — tap reply all and cc
becomes reply all", and "it should be allowed even after pressing reply, so
progress is not lost".

**"Adding a new Outlook / 365 account keeps adding the one already there."**
Two separate causes, and the first is the one that matters:

1. The Settings Outlook connect asked Microsoft for `prompt=consent`, which
   re-asks for CONSENT but never shows the account picker — Microsoft signs
   you straight back in as whichever account the browser already holds. The
   secondary-Gmail connect had hit exactly this and fixed it a year ago (ADR
   0080 addendum: "plus select_account so the picker offers OTHER accounts");
   the Outlook door was never given the same treatment, and neither was the
   `prompt` the Sign in with Microsoft route already uses (`select_account`,
   working in prod since ADR 0293 — so the value is proven against the real
   endpoint, not guessed).
2. Landing on a mailbox already attached is a SILENT success. `insertAccount`
   replaces the credentials and returns the row, the UI reports no error, and
   nothing new appears in the list. Right for the reconnect slide-on, which is
   what that gesture is for; wrong at the "+ Outlook / 365" button, where the
   user asked for another mailbox and got no answer at all — the ADR 0102/0107
   failure (a thing we did not do, presented as done) on the connect path.

## Decision

**The list keeps its half of a wide screen, reading and writing alike.**
`SplitFrame` (`mobile/src/email-split-pane.tsx`) draws two panes with a
draggable divider; below `SPLIT_MIN_WINDOW` (900) it draws one of them and
nothing else, so every phone and every narrow browser is exactly what it was.

It is used twice, because mail is reached two ways:

- **The reading pane IS the Email screen on a wide window** (owner's call,
  after seeing the first version). `/email` in Traditional mode puts its own
  list on the left and the selected email on the right: tapping a row is a
  SELECTION, not a navigation, so the thread expands beside the list it came
  from and the rest of the mail stays in view. Nothing is selected to begin
  with — the pane says so rather than opening the newest email, which would
  mark someone's mail read for them.
- **An email opened by link** (`/email/<id>`, a deep link, a card, a category
  walk out of the AI view) keeps its own route, with `EmailSplit` putting the
  list beside it (`ListPane`).

Which half survives a narrow window is the caller's to state (`narrow`), not a
default: the reader's route keeps the reader, the list screen keeps the list.
Defaulting it cost a phone its entire mail list behind an empty "Select an
email" pane, caught by checking phone widths before shipping.

The reader takes `embedded` for the pane: it draws its own header there
(`PaneHeader`) rather than a second `Stack.Screen` — two option sets in one
route fight over the one header — and "next email" / "done with this one"
become the parent's selection changing (`onSelect` / `onClose`) instead of a
navigation, so Back still means the Email tab rather than an email-by-email
history.

The rules are in `kernel/src/email-split.ts` (`splitFits`,
`defaultPaneWidth`, `clampPaneWidth`, `draggedPaneWidth`, `storedPaneWidth`)
rather than in the component: `mobile/` has no test harness (ADR 0120/0121),
and the pane, the divider and the stored width must agree about what a legal
width is — three copies of one clamp is how they stop agreeing. Default is
half; the divider drags; the width is per device in AsyncStorage
(`email.listPaneWidth`, kept across sign-out like the other layout prefs).
`READER_MIN` (420) is what gives way LAST: a stored width read into a window
that has since shrunk takes it off the pane, never the reader, so a resized
browser cannot leave HTML mail in a 100px column.

**The pane shows the list the user was looking at, and fetches nothing.** The
Traditional list already publishes its order and its own keyset `loadMore` to
the nav store for prev/next (ADR 0119); it now publishes the ROWS beside them,
so the pane renders that list — its filters, its mailbox, its order — with no
request and no second copy of the list's own paging. It draws from the store's
`ids`, which is where removals are already filtered as they start and as they
land (ADR 0218/0286), rather than keeping a second copy of that rule. Tapping a
row is `router.replace`, so Back returns to the list rather than walking back
through every email read in the pane.

An order published with NO rows — a category walk out of the AI view, which has
no list behind it — is the one case the pane loads a page itself (one inbox
page) and publishes it as the walk, because an empty column next to the reader
says nothing. That keeps prev/next coherent with what the pane shows (ADR
0264's scope rule).

**Reply all is reachable from inside the composer, and it lives on the Cc
line.** The switch sits where its effect lands: an empty `Cc:` line with
`Reply all` at its right, and one tap fills that line with everyone else who
was on the email (`Sender only` puts it back). So the Cc line is on screen
whenever reply-all is possible, instead of hiding behind the `Cc/Bcc` link that
used to govern it; Bcc stays behind that link, because nothing here offers to
fill it. Shown only when reply-all would actually widen the audience — a
one-to-one email has nobody to add, and a control that changes nothing is worse
than none. `replyAllAdds` (kernel) answers that by comparing the two audiences
`replyRecipients` already computes, rather than reading the message again, so
it cannot disagree with who Send addresses.

**It adds people; it does not re-derive the fields.** The reply menu's
`pickMode` resets To, Cc and Bcc, which is right when nothing has been written
yet. Inside the composer it is not: by then there may be a recipient the user
typed, or one they deleted, and a switch that quietly undid that would lose
work the composer is holding. `applyReplyAll` (kernel) therefore puts exactly
the people a plain reply misses into Cc, and takes exactly those people out
again on the way back; it adds nobody who is already in either field, whoever
put them there, and it leaves To alone — every address reply-all adds is a Cc
one, and the sender is already in To. The body was never at risk (no switch
touches it), but the recipients were.

**The Outlook picker, and an honest answer when nothing was added.**
`MS_ADD_ACCOUNT_PROMPT = 'select_account'` replaces `prompt=consent` on the
Settings connect. Microsoft takes ONE prompt value (unlike Google's
space-separated pair), so this is a choice, not an addition — and consent is
not lost, because a scope the chosen account has not granted still raises its
own prompt.

`insertAccount` reports whether it replaced an existing row, and the three
connect responses carry it as `EmailAccountSummary.reattached` — set only by a
connect, never present in a listing. The ADD door says so in one line
("… was already connected - its connection was refreshed, and no new mailbox
was added. Choose a different account to add one."); the reconnect door stays
silent, because reaching the same row is the whole point of that gesture.

Also in `insertAccount`, defence in depth: the address is lowercased on the way
in and matched case-insensitively. Every caller lowercases today, so this fixes
no reachable bug — but a mixed-case address reaching it would miss the existing
row and attach the SAME mailbox twice, with nothing to tell the two rows apart.

## Consequences

- An email read in the pane is not in the URL — `/email` is the address,
  whichever one is selected. A link to an email still opens its own route
  (split, with the list beside it), so nothing that names an email is lost.
- `/email/compose` and the forward screen are their own routes and get no
  pane. They are not answering an email in a list.
- The reader now has two homes, so a change to it has to be looked at in
  both: as a screen on a phone, and in the pane on a wide window.
- Reply all from the reader's menu and reply all from inside the composer now
  behave differently, deliberately: the menu derives the recipients afresh,
  the composer's switch only adds and removes. The difference is invisible
  unless a field had been edited, which is the only case it exists for.
- On a thread with other recipients the composer opens with an empty Cc line
  showing — one line more than before on every reply to a group, and the
  price of putting the control where its effect is.
- Verified in the browser against the dev server with the mock mailbox: the
  reading pane on `/email` at 1440 wide, a row opening into it with the list
  still there, a reply-all composer inside the pane, the divider dragged and
  its width kept across a reload, a pane row swapping the open email, the
  list screen and the reader both single-column at 375 and 760 wide with a row
  tap still opening the reader's own screen, and the "already connected" line
  on a second "+ Gmail" (the same code path the Outlook door uses). The Cc-line
  switch was then checked on a seeded group email, in the pane and at 390 wide:
  a plain reply opens with an empty Cc line and `Reply all` beside it; with a
  body written and an address typed into Cc, one tap keeps both and appends the
  other four recipients, and `Sender only` removes exactly those four and leaves
  the typed one and the body alone. The
  Microsoft account picker itself cannot be verified here — it needs two real
  Microsoft accounts — but `select_account` is the value the shipped Sign in
  with Microsoft flow already sends.

## Rejected

- **A reading pane only after opening an email** (this ADR's first cut, and
  the reason for the owner's follow-up). The list screen itself stayed one
  column, so the layout only appeared once you had navigated away from it.
- **Auto-selecting the newest email so the pane is never empty.** Opening an
  email marks it read; nobody asked for that by arriving at the screen.
- **Giving the AI view a reading pane too.** Its cards are a different
  surface with their own open paths; from there an email still opens its own
  route, which is split anyway.
- **Fetching the pane's own list always.** It would disagree with the filter,
  folder and mailbox the user had chosen, and pay for a page the app already
  had in memory.
- **A reanimated shared value for the drag.** The clamp is an ordinary kernel
  function, not a worklet, and a divider does not need the UI thread; the
  gesture is memoized instead, which is what keeps a state update per frame
  from rebuilding the recognizer mid-drag (the trap recorded on the Trips tab).
- **Keeping the switch in the composer header** (this ADR's first cut). An
  icon among the send controls says nothing about which field it changes, and
  the field it changes — Cc — was not even on screen at the time.
- **Showing Bcc alongside Cc whenever reply-all is possible**, as the single
  `ccVisible` flag used to. Two empty lines to offer one control.
- **Re-deriving To and Cc on the in-composer switch**, which is what the first
  cut did by reusing `pickMode`. It is what "so progress is not lost" rules
  out, and the loss is silent: a typed address simply disappears from a field
  nobody is looking at while they write.
- **`prompt=consent select_account` for Microsoft**, as Google takes. Microsoft
  documents a single value; `select_account` alone is also what this codebase
  already sends at sign-in.
- **Refusing a connect that lands on an attached mailbox.** It is the reconnect
  path, and the credentials it replaces are usually the point.
- **A server-synced pane width.** Per device, like the AI-view style and the
  light/dark choice (ADR 0282).
- **A bot tool.** The split, the width and the reply-all toggle rearrange
  surfaces; `reply_to_email` already says who a reply goes to, and the
  per-device width is not something the server knows (ADR 0215's reasoning for
  a gesture-only setting).
