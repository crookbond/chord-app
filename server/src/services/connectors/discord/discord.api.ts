/**
 * Thin wrapper around the Discord REST API. v1 only uses the two
 * calls required for gateway-only mode: `GET /users/@me` (resolve our
 * bot user id at startup, for mention detection), and
 * `POST /channels/{id}/messages` (outbound).
 *
 * Native `fetch`; auth is the standard `Authorization: Bot <token>`
 * scheme.
 */
const DISCORD_API = 'https://discord.com/api/v10';

/** Discord enforces 2000 chars per message body. We slice silently. */
const MESSAGE_LIMIT = 2000;

interface DiscordRestError {
  code?: number;
  message?: string;
}

export class DiscordApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly code: number | null,
    msg: string,
  ) {
    super(`discord ${endpoint} HTTP ${status}: ${msg}`);
  }
}

async function call<T>(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed: unknown = text.length > 0 ? safeParse(text) : null;
  if (!res.ok) {
    const err = (parsed as DiscordRestError | null) ?? {};
    throw new DiscordApiError(
      `${method} ${path}`,
      res.status,
      err.code ?? null,
      err.message ?? (text || res.statusText),
    );
  }
  return parsed as T;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export interface DiscordSelfUser {
  id: string;
  username: string;
  discriminator: string;
  bot: boolean;
}

export async function getMe(token: string): Promise<DiscordSelfUser> {
  return call<DiscordSelfUser>(token, 'GET', '/users/@me');
}

export interface PostChannelMessageInput {
  channelId: string;
  content: string;
}

export interface PostChannelMessageResult {
  id: string;
  channel_id: string;
  content: string;
}

export async function postChannelMessage(
  token: string,
  input: PostChannelMessageInput,
): Promise<PostChannelMessageResult> {
  return call<PostChannelMessageResult>(
    token,
    'POST',
    `/channels/${encodeURIComponent(input.channelId)}/messages`,
    { content: input.content.slice(0, MESSAGE_LIMIT) },
  );
}
