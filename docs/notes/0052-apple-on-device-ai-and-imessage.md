# 0052 — Apple on-device AI + iMessage/RCS feasibility

**Status**: accepted
**Date**: 2026-06-12
**Related**: [ADR 0010 — IM connectors](./0010-im-connectors.md),
[ADR 0044 — BYOK + LLM provider abstraction](./0044-byok-failure-and-future-billing.md),
[ADR 0049 — OS share target](./0049-os-share-target.md),
[ADR 0041 — Native iOS OAuth client](./0041-native-ios-oauth-client.md)

> **Feasibility + decision record.** Answers two recurring asks: "use the
> Apple on-device AI model" and "make Chord an iMessage app you can invoke in an
> iMessage / RCS conversation." One of those is impossible with public APIs; the
> other is real but architecturally narrow. This ADR closes the door on the
> impossible one and scopes the possible one so neither gets re-litigated.

## Context

Two product asks keep coming up:

1. **Use Apple's on-device AI model** — is there an API, which iPhones support it?
2. **Be invokable inside an iMessage / RCS conversation**, the way `@Chord`
   works in a Chord group or in Telegram (ADR 0010) — i.e. a bot that
   participates in a normal user-to-user thread.

Chord today is an Expo / React Native app (SDK 54, `newArchEnabled: true`,
config-plugin-only — no `mobile/ios/` dir) with a **server-side-only** LLM:
`LlmService` (`server/src/services/llm/types.ts`) resolved per user by
`getLlmForUser()` and `factory.ts`. The bot turn (`reactToMessage` in
`server/src/services/bot/bot.service.ts`) builds context from ~30 messages plus
attachment summaries plus tool specs, runs the iterative native-tool loop
(ADR 0005), and broadcasts over SSE. Cross-platform reach is the connector
layer (`server/src/services/connectors/`, ADR 0010).

## Decision

**iMessage / RCS bot participation is not buildable** — record it as infeasible
and stop pursuing it. **Apple's Foundation Models** is viable only as a narrow,
**on-device, client-side helper** (not as Chord's bot engine); pursue that as an
additive mobile feature, and keep cross-platform "@Chord" on the connector path.

### Why iMessage/RCS bot is impossible

- **iMessage:** third-party "iMessage apps" are `MSMessagesAppViewController`
  UI extensions, **user-initiated only**. They cannot read a thread, monitor
  incoming messages, auto-respond, or act as a participant. There is **no public
  bot API**. (Apple Messages for Business is a separate, opt-in, business→consumer
  channel requiring an MSP — not a general bot API.)
- **RCS:** RCS Business Messaging is **business-initiated agent→person** only,
  with no person-to-person injection; Apple exposes **no RCS API** to apps at all.
- The only buildable iMessage surface is a *user-initiated extension* (open
  Chord from the Messages drawer to insert content) — the inverse of the share
  target (ADR 0049), and explicitly **deferred** here. It is not a bot.
- The achievable form of "invoke @Chord in a chat" is the **connector pattern**
  (ADR 0010) on platforms that actually expose bot APIs — Telegram (shipped),
  Slack, Discord. That, not iMessage, is where this ask routes.

### Apple Foundation Models — what it is and its limits

- **API:** `LanguageModelSession` in the `FoundationModels` framework
  (WWDC 2025, iOS 26). **Swift-only** officially — no Apple-provided JS/Expo
  binding. Reaching it from RN needs a **preview-stage** community bridge
  (`@react-native-ai/apple` by Callstack, or `react-native-apple-llm`), RN New
  Architecture, iOS 26, Xcode 26.
- **Device matrix:** iPhone 15 Pro / Pro Max (A17 Pro) and the iPhone 16 family
  (A18); 8 GB RAM, ~7 GB on-device model storage. **iPhone 15 / 15 Plus and
  older are not supported.** iOS 26+ for Foundation Models specifically.
- **Capabilities:** snapshot-based streaming, `@Generable` structured output,
  tool-calling. **Hard ~4,096-token context window.**

### Why it can't be Chord's bot engine

- It runs **on the device**; Chord's LLM path is **server-side**. It is **not** a
  drop-in `factory.ts` provider — the inference location is wrong for the
  server-orchestrated turn (context build → tools → SSE → persistence).
- The ~4k context cannot hold a normal turn (30 messages + attachment summaries +
  tool specs). It fits **small, scoped, on-device tasks** only.

### What Foundation Models *is* good for here

A privacy-preserving, **client-side** helper that never touches the server bot
loop — small input, instant, offline. Primary candidate: **smart-reply / draft
suggestions in the chat composer** (1–3 short drafts from the last few visible
messages). Alternative: **on-device "summarize recent messages."** Scoped as an
additive mobile feature behind an availability gate, with the server LLM as the
fallback (or the affordance simply hidden) on unsupported devices.

## Alternatives considered

1. **Add Apple as a server-side LLM provider (`factory.ts`).** Architecturally
   impossible — the model runs on the phone, not the server; and 4k context
   can't carry a Chord turn. Rejected.
2. **Run the whole bot turn on-device.** Would require porting context-building,
   tools, retrieval, and persistence to the client and round-tripping or
   re-implementing every tool. Massive rearchitecture for one platform tier of
   device; loses the cross-client (web/Android) story. Rejected.
3. **iMessage extension as a "bot."** No API exists for autonomous participation
   (see Decision). A user-initiated insert-from-Chord extension is possible but
   low-value and tight on memory; deferred.
4. **RCS Business Messaging.** A2P / business-verified only; cannot join a P2P
   thread; wrong shape for a personal assistant. Rejected.
5. **Wait for official Expo/Apple RN support.** The community bridges are
   preview-stage; if the on-device helper is built, pin the dependency and treat
   it as a bet, falling back to the server LLM everywhere else.

## Consequences

- The "@Chord in iMessage/RCS" ask is **closed** — future requests get pointed
  at the connector layer (ADR 0010) for bot-API platforms, or this ADR.
- Any on-device-AI work is a **mobile, additive** feature, EAS-dev-build only:
  Foundation Models is **unavailable** in Expo Go, on web, in simulators without
  the model, and on iPhone 14 / non-Pro-15 and older. It must be gated by an
  `isFoundationModelsEnabled()` check with a clean fallback (server LLM or hide).
- Implementation, when scoped, lives entirely client-side
  (`mobile/src/on-device-ai.ts` wrapper + a composer/​catchup UI hook) with **no
  server / kernel / contract changes** on the on-device-only path. Verification
  requires a real iPhone 15 Pro+/iOS 26 dev build.
- Adds a preview-stage native dependency + config plugin to the mobile build if
  built; that is the maintenance cost of betting on community bridges pre-GA.
