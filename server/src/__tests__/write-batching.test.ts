import { describe, expect, it } from 'vitest';

import { createBatchedWrite, runExclusive, serialRerun, singleFlight, type TimerApi } from '@chord/kernel';

describe('runExclusive', () => {
  // compose.tsx / the reply and forward composers / the chat box guarded
  // Send with React state only, so two taps in one frame both sent - with
  // two different send ids, so the server could not tell them apart.
  it('sends once for two taps in the same frame', async () => {
    const gate = { current: false };
    const sent: string[] = [];
    let release!: () => void;
    const send = () =>
      runExclusive(gate, async () => {
        sent.push(`send-${sent.length + 1}`);
        await new Promise<void>((r) => (release = r));
      });
    const first = send();
    const second = send();
    await Promise.resolve();
    expect(sent).toEqual(['send-1']);
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual(['send-1']);
    // Free again once it finished (or failed).
    await expect(runExclusive(gate, async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(runExclusive(gate, async () => 'again')).resolves.toBe('again');
  });
});

function fakeTimers() {
  const due: { fn: () => void; ms: number; id: number }[] = [];
  let next = 0;
  const api: TimerApi = {
    set: (fn, ms) => {
      const id = ++next;
      due.push({ fn, ms, id });
      return id;
    },
    clear: (h) => {
      const i = due.findIndex((d) => d.id === h);
      if (i >= 0) due.splice(i, 1);
    },
  };
  return { api, due, fire: () => due.splice(0).forEach((d) => d.fn()) };
}

describe('singleFlight', () => {
  // email-device-store's deviceKey(true): two callers at first use both
  // read "no key", both made one, and the second overwrote the first in the
  // key store - files sealed under the first then never opened again.
  it('makes one key however many callers race the first use', async () => {
    let stored: string | null = null;
    let created = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const loadOrCreate = singleFlight(async () => {
      const existing = stored;
      await gate; // the key store's round trip
      if (existing) return existing;
      created += 1;
      stored = `key-${created}`;
      return stored;
    });
    const all = Promise.all([loadOrCreate(), loadOrCreate(), loadOrCreate()]);
    release();
    const keys = await all;
    expect(created).toBe(1);
    expect(new Set(keys).size).toBe(1);
    expect(stored).toBe(keys[0]);
  });

  it('runs again once the first call settled, also after a failure', async () => {
    let calls = 0;
    const f = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error('x');
      return calls;
    });
    await expect(f()).rejects.toThrow('x');
    await expect(f()).resolves.toBe(2);
  });
});

describe('createBatchedWrite', () => {
  // The device mail index was sealed and rewritten after every stored thread.
  it('writes a burst of changes once', async () => {
    const t = fakeTimers();
    let writes = 0;
    const w = createBatchedWrite(async () => {
      writes += 1;
    }, 2000, t.api);
    for (let i = 0; i < 40; i++) w.mark();
    expect(writes).toBe(0);
    expect(t.due).toHaveLength(1);
    t.fire();
    await Promise.resolve();
    expect(writes).toBe(1);
    expect(w.dirty()).toBe(false);
  });

  it('flush writes at once only when something changed', async () => {
    const t = fakeTimers();
    let writes = 0;
    const w = createBatchedWrite(async () => {
      writes += 1;
    }, 2000, t.api);
    await w.flush();
    expect(writes).toBe(0);
    w.mark();
    await w.flush();
    expect(writes).toBe(1);
    expect(t.due).toHaveLength(0);
  });

  it('cancel forgets a pending write', async () => {
    const t = fakeTimers();
    let writes = 0;
    const w = createBatchedWrite(async () => {
      writes += 1;
    }, 2000, t.api);
    w.mark();
    w.cancel();
    await w.flush();
    expect(writes).toBe(0);
  });
});

async function untilGate(gates: unknown[]): Promise<void> {
  for (let i = 0; i < 50 && gates.length === 0; i++) await Promise.resolve();
}

describe('serialRerun', () => {
  // useDraftAutosave: the debounce and saveNow (or unmount, or a network
  // change) both saved a NEW message before either had an id, so the server
  // created two drafts; or an older body's request landed last.
  it('never has two saves in flight, and the rerun uses the id the first got', async () => {
    let id: string | null = null;
    let created = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let body = 'Hel';
    const stored: string[] = [];
    const gates: (() => void)[] = [];
    const save = serialRerun(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const sent = { id, body };
      await new Promise<void>((r) => gates.push(r));
      if (!sent.id) {
        created += 1;
        id = `d${created}`;
      }
      stored.push(sent.body);
      inFlight -= 1;
      return id;
    });
    const a = save();
    body = 'Hello';
    const b = save();
    body = 'Hello there';
    const c = save();
    await untilGate(gates);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // Three saves asked for; one request in the air.
    expect(inFlight).toBe(1);
    gates.shift()!();
    await a;
    await untilGate(gates);
    gates.shift()!();
    const [rb, rc] = await Promise.all([b, c]);
    expect(created).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(stored).toEqual(['Hel', 'Hello there']);
    expect(rb).toBe('d1');
    expect(rc).toBe('d1');
  });

  it('reruns after a failed save', async () => {
    let n = 0;
    let release!: () => void;
    const save = serialRerun(async () => {
      n += 1;
      if (n === 1) {
        await new Promise<void>((r) => (release = r));
        throw new Error('offline');
      }
      return n;
    });
    const first = save();
    const second = save();
    release();
    await expect(first).rejects.toThrow('offline');
    await expect(second).resolves.toBe(2);
  });
});
