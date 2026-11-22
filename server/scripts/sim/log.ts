/**
 * Append-only JSONL logger for the simulator. One record per simulated
 * action so the post-run analyzer can grep, group, and tally.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export type SimEventKind =
  | 'sim.start'
  | 'sim.reset'
  | 'sim.user-created'
  | 'sim.group-plan'
  | 'sim.group-created'
  | 'sim.group-joined'
  | 'sim.message-posted'
  | 'sim.chord-prompt'
  | 'sim.chord-result'
  | 'sim.setup-prompt'
  | 'sim.setup-result'
  | 'sim.setup-no-prompt'
  | 'sim.setup-postcheck'
  | 'sim.proposal-seen'
  | 'sim.idor-leak'
  | 'sim.idor-control-fail'
  | 'sim.sse-error'
  | 'sim.error'
  | 'sim.summary';

export interface SimEvent {
  kind: SimEventKind;
  ts: string;
  /** Free-form payload — varies by kind. */
  [key: string]: unknown;
}

export class SimLog {
  private stream: WriteStream;
  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: 'a' });
  }

  write(kind: SimEventKind, payload: Record<string, unknown> = {}): void {
    const record: SimEvent = { kind, ts: new Date().toISOString(), ...payload };
    this.stream.write(JSON.stringify(record) + '\n');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}
