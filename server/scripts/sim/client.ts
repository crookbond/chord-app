/**
 * Thin HTTP client used by every simulated user. Wraps the public API —
 * the simulator never reaches into the database, so this exercises the
 * same endpoints the mobile client uses.
 */
import { API } from '@chord/kernel';

export interface SessionInfo {
  userId: string;
  username: string;
  displayName: string;
  token: string;
}

/**
 * Pull the invite code out of a `/join/<CODE>` link (or pass a bare code
 * through unchanged) — mirrors the mobile client's extractInviteCode so the
 * sim exercises the real link-based join path, not a back-channel.
 */
export function extractInviteCode(input: string): string {
  const m = input.trim().match(/\/join\/([^/?#\s]+)/i);
  return (m ? m[1] : input).trim();
}

export class ChordClient {
  constructor(public readonly baseUrl: string, public readonly token: string) {}

  static async login(
    baseUrl: string,
    username: string,
    displayName: string,
  ): Promise<SessionInfo> {
    const res = await fetch(`${baseUrl}${API.session}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, displayName }),
    });
    if (!res.ok) {
      throw new Error(`login ${username}: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      user: { id: string; username: string; displayName?: string };
      token: string;
    };
    return {
      userId: json.user.id,
      username: json.user.username,
      displayName: json.user.displayName ?? username,
      token: json.token,
    };
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-chord-token': this.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  createGroup(name: string, kind: 'group' | 'personal' = 'group') {
    return this.req<{ id: string; name: string; inviteCode: string }>(
      'POST',
      API.groups,
      { name, kind },
    );
  }

  joinGroup(inviteCode: string) {
    return this.req<{ id: string; name: string }>('POST', API.groupJoin, {
      inviteCode,
    });
  }

  /** Join by following a shareable invite link (ADR 0047). */
  joinViaLink(inviteUrl: string) {
    return this.joinGroup(extractInviteCode(inviteUrl));
  }

  // ── deterministic entity creators (used to seed IDOR probe targets) ──
  createTask(groupId: string, title: string) {
    return this.req<{ id: string }>('POST', API.groupTasks(groupId), { title });
  }
  createList(groupId: string, name: string) {
    return this.req<{ id: string }>('POST', API.groupLists(groupId), { name });
  }
  addListItem(listId: string, text: string) {
    return this.req<{ id: string }>('POST', API.listItems(listId), { text });
  }
  createSave(groupId: string, title: string, url: string) {
    return this.req<{ id: string }>('POST', API.groupSaves(groupId), {
      kind: 'link',
      title,
      url,
    });
  }
  createEvent(groupId: string, title: string, startsAt: string) {
    return this.req<{ id: string }>('POST', API.groupEvents(groupId), { title, startsAt });
  }

  /**
   * Non-throwing request used by the adversarial cross-group probes — returns
   * just the HTTP status so the caller can assert the access was refused
   * (404/403) rather than catching a thrown error per attempt.
   */
  async tryReq(method: string, path: string, body?: unknown): Promise<number> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-chord-token': this.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await res.text().catch(() => undefined); // drain so the socket can be reused
    return res.status;
  }

  listMyGroups() {
    return this.req<Array<{ id: string; name: string; kind: 'group' | 'personal' }>>(
      'GET',
      API.groups,
    );
  }

  postMessage(groupId: string, body: string, tz?: string) {
    return this.req<{ id: string; body: string; senderId: string | null }>(
      'POST',
      API.groupMessages(groupId),
      { body, tz: tz ?? 'America/Los_Angeles' },
    );
  }

  /**
   * Upload a buffer as a group attachment. Used by form-fill and screenshot
   * scenarios. Returns the new attachment row.
   */
  async uploadFile(
    groupId: string,
    filename: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ id: string; mimeType: string; filename: string }> {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType });
    form.append('file', blob, filename);
    const res = await fetch(`${this.baseUrl}/api/v1/groups/${groupId}/files`, {
      method: 'POST',
      headers: { 'x-chord-token': this.token },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`upload ${filename}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as { id: string; mimeType: string; filename: string };
  }

  /**
   * Set the user's listening mode. The simulator pins every persona to
   * 'invocation' so the bot only reacts to explicit @Chord mentions —
   * keeps the verifier honest (we know exactly which message should
   * have triggered a turn) and prevents passive memory ingestion from
   * the chatter pool from racing the @Chord turns.
   */
  setListeningMode(mode: 'invocation' | 'passive' | 'active'): Promise<{ ok: boolean }> {
    return this.req<{ ok: boolean }>('PUT', '/api/v1/me/listening-mode', { mode });
  }

  /** Wipes groups/messages/trips/etc. and reseeds the demo corpus.
   * Requires DEMO_MODE=1 on the server; throws otherwise. */
  static async resetDemo(baseUrl: string): Promise<void> {
    const res = await fetch(`${baseUrl}${API.demoReset}`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(
        `demo reset failed: ${res.status} ${await res.text()} ` +
          `(set DEMO_MODE=1 in the server's .env and restart)`,
      );
    }
  }

  listProposals() {
    // The API returns `toolName` (kernel Proposal); map it to the `kind` the
    // sim's verifier/report read. Previously the client typed `kind` but never
    // populated it → "proposals by kind: undefined". (2026-06-19 perf audit.)
    return this.req<
      Array<{
        id: string;
        toolName: string;
        groupId?: string;
        title?: string;
        status?: string;
        createdAt?: string;
      }>
    >('GET', API.meProposals).then((rows) =>
      rows.map((r) => ({
        id: r.id,
        kind: r.toolName,
        groupId: r.groupId,
        title: r.title,
        status: r.status,
        createdAt: r.createdAt,
      })),
    );
  }
}
