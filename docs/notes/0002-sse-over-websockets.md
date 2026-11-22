# 0002 — SSE over WebSockets

**Status**: accepted
**Date**: 2026-04-17

## Context

The chat needs server-pushed events (new messages, bot token streaming, resource updates). Classic choices: WebSockets, Server-Sent Events, or long-polling.

## Decision

Use **Server-Sent Events** on `GET /api/v1/groups/:id/stream`. Clients send writes via plain HTTP POSTs.

Web clients use native `EventSource`; React Native clients use the `react-native-sse` polyfill.

## Alternatives considered

- **WebSockets.** Bidirectional is nice but unnecessary — in a chat app, clients' writes can go through plain POST with no latency penalty. WS complicates auth (no cookie on upgrade), reconnection state, and heartbeat logic. Many proxies (and CDN edges) require special configuration for WS.
- **Long-polling.** Works behind any proxy but burns 2× the request count and doubles perceived latency on message arrival.

## Consequences

- **Uni-directional.** Clients cannot send events over the stream; they must POST. Fine for our topology.
- **Auth simple.** Same `x-chord-token` or cookie story as the rest of the HTTP surface. The web `EventSource` ships cookies with `withCredentials: true`; native sends the header.
- **Keep-alive required.** SSE over naive reverse proxies dies on idle. We emit `event: ping` every 25s.
- **No gap-fill on reconnect.** `Last-Event-ID` isn't wired — reconnected clients lose any events that happened during the disconnect. Good enough for demo; production would either sequence events or have the client refetch the last page on reconnect.
- **In-process hub only.** Works for a single Node process. Scaling to multiple nodes requires an adapter (Redis pub/sub, Postgres LISTEN/NOTIFY, or NATS). The `SseHub` class is isolated enough that swapping it is contained.
