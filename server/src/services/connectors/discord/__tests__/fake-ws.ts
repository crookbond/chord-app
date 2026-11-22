/**
 * Tiny fake WebSocket the gateway tests use to drive frames
 * deterministically. Implements just enough of `MinimalWebSocket`
 * for the gateway state machine.
 */
import type { MinimalWebSocket } from '../discord-gateway';

export class FakeWebSocket implements MinimalWebSocket {
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: MinimalWebSocket['onopen'] = null;
  onmessage: MinimalWebSocket['onmessage'] = null;
  onclose: MinimalWebSocket['onclose'] = null;
  onerror: MinimalWebSocket['onerror'] = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.fireClose(code ?? 1000, reason ?? '');
  }

  // ── test helpers ─────────────────────────────────────────────────
  fireOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.call(this, {});
  }
  fireFrame(frame: { op: number; d?: unknown; s?: number; t?: string }): void {
    this.onmessage?.call(this, { data: JSON.stringify(frame) });
  }
  fireClose(code: number, reason: string): void {
    this.readyState = 3; // CLOSED
    this.onclose?.call(this, { code, reason });
  }

  /** Convenience: parse the i-th frame the gateway sent. */
  sentFrame(i: number): { op: number; d?: unknown } {
    return JSON.parse(this.sent[i]);
  }
}
