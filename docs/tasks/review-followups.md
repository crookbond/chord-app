# Review Follow-ups

Issues found during the first full review that should stay visible after the
demo-focused fixes land.

## Parked work

### Live calendar refresh via cross-group SSE

**Today**: the `/calendar` tab refreshes via `useFocusEffect` — every time
the tab regains focus it re-runs `listAllEvents` + `listTripStatuses` +
`listImportantDays`. This covers the common case (delete in chat → tap
calendar tab → see new state). It does NOT cover *live* updates while
the calendar tab is the active surface: e.g., the bot deletes an event
in another group while the user is staring at the day view; the row
stays on-screen until the user navigates away and back.

**Why parked**: the focus-refresh fix is enough for the current demo, and
the live path requires cross-group plumbing that doesn't exist yet.

**How to do it when we pick this up**:

1. **Server side already broadcasts the right events.** `SSE.eventCreated`,
   `SSE.eventUpdated`, `SSE.eventDeleted`, and the RSVP variants are
   declared in `kernel/src/sse.ts` and emitted from
   `server/src/routes/events.ts` on every mutation (see
   `sseHub.broadcast(ev.groupId, SSE.eventDeleted, …)`). They're scoped
   per-group — the SSE hub keys subscriptions by `groupId`.

2. **The calendar shows events across ALL groups the user is in.** So
   the client needs to subscribe to *every* group the user is a member
   of, not just one — unlike the chat screen which subscribes to a
   single `groupId`. Two options:

   - **Multi-stream**: open one `EventSource` per group on calendar
     mount, teardown on unmount. Cheap to implement (reuse the same URL
     the chat screen uses), but `n` connections per user — fine for
     ≤ 20 groups, ugly past that.
   - **User-scoped stream**: add a new endpoint `GET /api/v1/me/stream`
     that subscribes the caller to every group they belong to and emits
     the same per-group SSE events with an added `groupId` field. The
     hub would need a `subscribeUser(userId, …)` method that fans out
     to all groups; on group join/leave we'd update existing
     subscriptions. Cleaner, but server-side surgery.

   Recommend multi-stream first as a sufficient demo path; promote to
   user-scoped stream when group count makes that necessary.

3. **Wire-up in `mobile/app/calendar.tsx`**: after `refresh()` populates
   `events`, fetch the user's group list (already available via
   `listGroups()`); for each group open an `EventSource` to
   `/api/v1/groups/:id/stream` and dispatch on event name:
   - `event.created` / `event.updated` → patch `events` state (upsert by id).
   - `event.deleted` → filter `events` by `id !== payload.id`.
   - `rsvp.*` → ignore for calendar surface (RSVP affects event detail,
     not the calendar grid).
   - `trip.*` → re-fetch `listTripStatuses` (or patch similarly).

   Teardown all EventSources in the cleanup callback returned from
   `useFocusEffect` / `useEffect` so they don't pile up on unmount.

4. **Reconnect / catch-up**: SSE drops on backgrounded mobile sessions.
   On reconnect, do a full `refresh()` so any events missed during the
   gap aren't silently absent. iOS/Android already kill EventSource
   when the app suspends; the `useFocusEffect` re-runs on resume which
   re-establishes the streams, so a single `refresh()` at the top of
   the focus callback is the catch-up step (already in place).

5. **Optimistic UI**: when the user deletes from inside the calendar
   itself (long-press → delete, once that menu exists), patch local
   state immediately rather than waiting for the SSE round-trip — the
   server broadcast becomes a confirmation, not the source of truth.

This is roughly the same shape as the chat screen's existing SSE
handling (`mobile/app/groups/[id]/index.tsx`), but multiplexed across
groups. See ADR 0002 for the SSE-over-WebSockets choice that already
covers the broadcast side.

## Known UX issues — not yet addressed

- **Telegram leading-`@` autocomplete (2026-05-12).** Typing a message
  in a Telegram group/DM that *starts* with `@` opens Telegram's
  username-autocomplete dropdown and on iOS/Android the dropdown
  intercepts the send button. Result: users can't post messages like
  `@chord do X` directly — they have to prepend any character first
  (`1 @chord do X`). The server already accepts `@chord` as a text
  mention (alias matching, see `telegram.connector.ts`
  `containsBotMention`), so the bot reacts once the message lands. But
  the client UX is broken. Options to explore: register `chord` as a
  Telegram bot command via `setMyCommands` so it shows in the picker;
  document the workaround prominently; encourage DMs (private chats
  with the bot don't need a mention). No code change yet.

## Deferred for post-demo validation

These are real issues, but they are being intentionally deferred until the demo
proves useful enough to justify tighter authorization and account controls.

- Route-level membership checks for id-keyed mutations and reads:
  - `PATCH` / `DELETE` task by id
  - list item add / toggle / delete by id
  - save delete by id
  - event RSVP read / write by id
  - media-item patch by id
- Persona-memory privacy on `GET /groups/:id/memories`.
- Attachment list visibility mismatch for guests in adults-only groups.
- Username-only session takeover risk and missing logout / revocation flow.
- Message-side validation that `attachmentId` / `replyToId` belong to the same
  group and are readable by the caller.

## Still worth fixing soon

- Reconcile `README.md`, `CLAUDE.md`, and `docs/tasks/README.md` on what Phase 4
  means today.
- Reconcile `kernel/package.json` with ADR 0001 and `docs/ops/kernel-path.md`.
- Expand the docs for current SSE events, trip APIs, attachment sharing, and the
  full tool registry.
- Add at least one automated quality gate: CI running `npm run lint` and
  `npm run typecheck`.
- Add focused regression tests for high-risk pure logic, especially RSVP update
  behavior, trip-status logic, and any future route authorization helpers.

## Fixed in the demo-focused pass

- RSVP update response shape / boolean update correctness.
- Bot tool execution constrained to the active group for event / trip ids.
- Mobile Resources screen now handles missing group state more safely.
- Mobile realtime wiring improved for resource refresh flows.
