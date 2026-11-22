/**
 * Minimal SSE client: opens a fetch with `text/event-stream`, parses
 * `event:`/`data:` frames, dispatches typed events to listeners. One
 * stream per group; events fan out to every user-loop interested in
 * that group.
 */
type Listener = (event: string, data: unknown) => void;

export interface SseConnection {
  close(): void;
  onEvent(fn: Listener): void;
}

export async function openSse(
  url: string,
  token: string,
  onError: (err: unknown) => void,
): Promise<SseConnection> {
  const ctl = new AbortController();
  const listeners: Listener[] = [];

  const res = await fetch(url, {
    headers: { 'x-chord-token': token, accept: 'text/event-stream' },
    signal: ctl.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE failed: ${res.status} ${res.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';

  (async () => {
    try {
      const reader = res.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (line === '') {
            currentEvent = 'message';
            continue;
          }
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            let data: unknown = raw;
            try {
              data = JSON.parse(raw);
            } catch {
              // raw string event
            }
            for (const fn of listeners) {
              try {
                fn(currentEvent, data);
              } catch (err) {
                onError(err);
              }
            }
          }
        }
      }
    } catch (err) {
      if (!ctl.signal.aborted) onError(err);
    }
  })();

  return {
    close: () => ctl.abort(),
    onEvent: (fn) => listeners.push(fn),
  };
}
