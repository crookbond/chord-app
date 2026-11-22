/**
 * Thin wrapper around the Telegram Bot API. Only the calls v1 actually
 * uses: `getMe` (resolve our own bot username at startup), `getUpdates`
 * (long-poll for inbound), `sendMessage` (outbound).
 *
 * Uses native `fetch` to avoid pulling in another HTTP dep.
 */
const TG_BASE = 'https://api.telegram.org';

interface TgOk<T> {
  ok: true;
  result: T;
}
interface TgErr {
  ok: false;
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}
type TgResp<T> = TgOk<T> | TgErr;

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfter: number | null,
  ) {
    super(`telegram ${method} failed: ${errorCode} ${description}`);
  }
}

async function call<T>(
  token: string,
  method: string,
  payload: object,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${TG_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal,
  });
  const json = (await res.json()) as TgResp<T>;
  if (!json.ok) {
    throw new TelegramApiError(
      method,
      json.error_code,
      json.description,
      json.parameters?.retry_after ?? null,
    );
  }
  return json.result;
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TgMessageEntity {
  type:
    | 'mention'
    | 'text_mention'
    | 'hashtag'
    | 'cashtag'
    | 'bot_command'
    | 'url'
    | 'email'
    | 'phone_number'
    | 'bold'
    | 'italic'
    | 'underline'
    | 'strikethrough'
    | 'code'
    | 'pre'
    | 'text_link'
    | 'custom_emoji'
    | (string & {});
  offset: number;
  length: number;
  user?: TgUser; // only for type === 'text_mention'
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  caption_entities?: TgMessageEntity[];
  entities?: TgMessageEntity[];
  /** Telegram sends an array of resized photo variants, smallest → largest. */
  photo?: TgPhotoSize[];
  document?: TgDocument;
  audio?: TgAudio;
  voice?: TgVoice;
  video?: TgVideo;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  /** Relative path within Telegram's CDN — append to /file/bot<token>/. */
  file_path?: string;
}

export async function getFile(
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<TgFile> {
  return call<TgFile>(token, 'getFile', { file_id: fileId }, signal);
}

/**
 * Download the binary body of a Telegram file. Combines `getFile`
 * (returns `file_path`) with a GET against the CDN. Returns the bytes
 * + the resolved file path (caller may want the filename suffix).
 */
export async function downloadFile(
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; filePath: string }> {
  const meta = await getFile(token, fileId, signal);
  if (!meta.file_path) {
    throw new Error(`telegram getFile returned no file_path for ${fileId}`);
  }
  const res = await fetch(`${TG_BASE}/file/bot${token}/${meta.file_path}`, { signal });
  if (!res.ok) {
    throw new Error(`telegram file CDN ${res.status} for ${meta.file_path}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { bytes: buf, filePath: meta.file_path };
}

/**
 * Bot's own membership status in a chat. We get one of these when the
 * bot is added to or removed from a group/supergroup/channel. Drives
 * the auto-pair flow in `group-add.service`.
 */
export interface TgChatMember {
  user: TgUser;
  status:
    | 'creator'
    | 'administrator'
    | 'member'
    | 'restricted'
    | 'left'
    | 'kicked'
    | (string & {});
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  date: number;
  old_chat_member: TgChatMember;
  new_chat_member: TgChatMember;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  /** When the original message is still accessible (not too old), TG
   *  includes it so we can edit its reply_markup. */
  message?: TgMessage;
  /** Inline-mode callbacks set this instead of `message` — Chord
   *  doesn't ship an inline mode, so we ignore. */
  inline_message_id?: string;
  /** The `callback_data` string from the button the user tapped. */
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  my_chat_member?: TgChatMemberUpdated;
  callback_query?: TgCallbackQuery;
}

export async function getMe(
  token: string,
  signal?: AbortSignal,
): Promise<TgUser> {
  return call<TgUser>(token, 'getMe', {}, signal);
}

export interface GetUpdatesInput {
  offset?: number;
  /** Long-poll timeout (seconds). Telegram caps at 50. */
  timeout?: number;
  /** Restrict update kinds; v1 only consumes 'message'. */
  allowed_updates?: string[];
}

export async function getUpdates(
  token: string,
  input: GetUpdatesInput,
  signal?: AbortSignal,
): Promise<TgUpdate[]> {
  return call<TgUpdate[]>(token, 'getUpdates', input, signal);
}

/**
 * One inline-keyboard button. We support two kinds:
 *   - `url`: open the URL in the user's browser (no round-trip).
 *   - `callback_data`: Telegram POSTs a `callback_query` update back to
 *     our long-poll loop carrying this string (ADR 0029). Max 64 bytes.
 * A button sets one or the other, never both.
 */
export interface TgInlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface TgInlineKeyboardMarkup {
  /** Array of button rows. Each row is an array of buttons. */
  inline_keyboard: TgInlineKeyboardButton[][];
}

export interface SendMessageInput {
  chat_id: number | string;
  text: string;
  /** When set, Telegram parses the text as HTML or MarkdownV2. */
  parse_mode?: 'HTML' | 'MarkdownV2' | 'Markdown';
  /** Suppress the auto-fetched link preview that follows a bare URL. */
  disable_web_page_preview?: boolean;
  /** Inline-keyboard markup rendered under the message. */
  reply_markup?: TgInlineKeyboardMarkup;
}

export interface SendMessageResult extends TgMessage {}

export async function sendMessage(
  token: string,
  input: SendMessageInput,
  signal?: AbortSignal,
): Promise<SendMessageResult> {
  return call<SendMessageResult>(token, 'sendMessage', input, signal);
}

/**
 * Register the bot's slash-command menu via Telegram's setMyCommands.
 * Called once at startup; idempotent on Telegram's side — repeated
 * calls just overwrite the previous list.
 */
export interface TgBotCommand {
  command: string;
  description: string;
}

export async function setMyCommands(
  token: string,
  commands: TgBotCommand[],
  signal?: AbortSignal,
): Promise<true> {
  return call<true>(token, 'setMyCommands', { commands }, signal);
}

export interface AnswerCallbackQueryInput {
  callback_query_id: string;
  /** Short toast text (≤ 200 chars). When omitted, TG just clears the
   *  client-side loading spinner with no UI feedback. */
  text?: string;
  /** When true, TG shows the text as a modal alert instead of a toast. */
  show_alert?: boolean;
  /** TTL for caching the response on the user's client (seconds). */
  cache_time?: number;
}

/**
 * Telegram requires every callback_query to be acknowledged within ~15s
 * — otherwise the user's UI shows a perpetual spinner on the button.
 * Always call this from the callback handler, even on rejection.
 */
export async function answerCallbackQuery(
  token: string,
  input: AnswerCallbackQueryInput,
  signal?: AbortSignal,
): Promise<true> {
  return call<true>(token, 'answerCallbackQuery', input, signal);
}

export interface EditMessageReplyMarkupInput {
  chat_id: number | string;
  message_id: number | string;
  /** Omit (or pass undefined) to *remove* the keyboard entirely. */
  reply_markup?: TgInlineKeyboardMarkup;
}

/**
 * Update only the inline_keyboard of an already-sent message. ADR 0029
 * uses this to remove resolved-proposal buttons after the user (or
 * another surface) confirms / rejects.
 */
export async function editMessageReplyMarkup(
  token: string,
  input: EditMessageReplyMarkupInput,
  signal?: AbortSignal,
): Promise<TgMessage | true> {
  return call<TgMessage | true>(token, 'editMessageReplyMarkup', input, signal);
}

/**
 * Multipart file upload helper for sendDocument / sendPhoto / etc.
 * Uses Node 20 native FormData + Blob so we don't pull in another
 * dependency. The caller picks the field name (`document`, `photo`,
 * `video`, `audio`, `voice`) — Telegram's bot API uses different
 * field names per kind.
 */
export interface SendFileInput {
  chatId: number | string;
  field: 'document' | 'photo' | 'video' | 'audio' | 'voice';
  bytes: Buffer;
  filename: string;
  mimeType: string;
  caption?: string;
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown';
}

export async function sendFile(
  token: string,
  input: SendFileInput,
  signal?: AbortSignal,
): Promise<SendMessageResult> {
  const method =
    input.field === 'document'
      ? 'sendDocument'
      : input.field === 'photo'
        ? 'sendPhoto'
        : input.field === 'video'
          ? 'sendVideo'
          : input.field === 'audio'
            ? 'sendAudio'
            : 'sendVoice';
  const form = new FormData();
  form.append('chat_id', String(input.chatId));
  if (input.caption) form.append('caption', input.caption);
  if (input.parseMode) form.append('parse_mode', input.parseMode);
  // Node's `Blob` accepts an ArrayBuffer; pass the Buffer's underlying
  // arraybuffer slice to avoid a copy.
  const blob = new Blob([input.bytes], { type: input.mimeType });
  form.append(input.field, blob, input.filename);

  const res = await fetch(`${TG_BASE}/bot${token}/${method}`, {
    method: 'POST',
    body: form,
    signal,
  });
  const json = (await res.json()) as TgResp<SendMessageResult>;
  if (!json.ok) {
    throw new TelegramApiError(
      method,
      json.error_code,
      json.description,
      json.parameters?.retry_after ?? null,
    );
  }
  return json.result;
}
