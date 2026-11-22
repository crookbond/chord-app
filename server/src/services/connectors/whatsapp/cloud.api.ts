/**
 * Meta WhatsApp Cloud API transport (ADR 0090).
 *
 * The Graph endpoints Chord actually uses, plus webhook signature checking.
 * Deliberately hand-rolled over `fetch` rather than pulling in Meta's SDK —
 * the surface is three POST shapes and one HMAC, and the same reasoning as
 * ADR 0075's Stripe integration applies.
 */
import crypto from 'node:crypto';

export interface CloudCreds {
  /** System User access token with whatsapp_business_messaging. */
  token: string;
  /** The sending number's Phone Number ID (NOT the phone number). */
  phoneNumberId: string;
  /** Graph API version, e.g. 'v21.0'. */
  graphVersion: string;
}

export interface CloudSendResult {
  /** `wamid.…` — Meta's message id. */
  id: string | null;
}

/** One quick-reply button. Meta caps titles at 20 chars and buttons at 3. */
export interface CloudButton {
  id: string;
  title: string;
}

function graphUrl(creds: CloudCreds): string {
  return `https://graph.facebook.com/${creds.graphVersion}/${creds.phoneNumberId}/messages`;
}

/** `/<PHONE_NUMBER_ID>/media` — upload. Retrieval addresses the media id
 *  directly, with no phone number id in the path, hence two builders. */
function mediaUploadUrl(creds: CloudCreds): string {
  return `https://graph.facebook.com/${creds.graphVersion}/${creds.phoneNumberId}/media`;
}

function mediaNodeUrl(creds: CloudCreds, mediaId: string): string {
  return `https://graph.facebook.com/${creds.graphVersion}/${encodeURIComponent(mediaId)}`;
}

async function post(creds: CloudCreds, payload: unknown): Promise<CloudSendResult> {
  const res = await fetch(graphUrl(creds), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    // Meta nests the useful part; surface it rather than a bare status. The
    // token is never part of the response, so this is safe to log upstream.
    let detail = text.slice(0, 400);
    try {
      const err = JSON.parse(text) as { error?: { message?: string; code?: number } };
      if (err.error?.message) detail = `${err.error.message} (code ${err.error.code ?? '?'})`;
    } catch {
      /* keep the raw slice */
    }
    throw new Error(`whatsapp cloud send failed: ${res.status} ${detail}`);
  }
  try {
    const json = JSON.parse(text) as { messages?: Array<{ id?: string }> };
    return { id: json.messages?.[0]?.id ?? null };
  } catch {
    return { id: null };
  }
}

/** A plain text message. Only deliverable inside the 24h window (ADR 0089). */
export async function sendText(
  creds: CloudCreds,
  opts: { to: string; body: string },
): Promise<CloudSendResult> {
  return post(creds, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.to,
    type: 'text',
    // Chord attaches its own action buttons; Meta's link preview competes
    // with them and often duplicates a card we already rendered.
    text: { preview_url: false, body: opts.body },
  });
}

/**
 * An interactive reply-button message. Unlike Twilio, this needs NO
 * pre-approved template — but it is still only deliverable inside the 24h
 * window, same as plain text.
 */
export async function sendButtons(
  creds: CloudCreds,
  opts: { to: string; body: string; buttons: CloudButton[] },
): Promise<CloudSendResult> {
  return post(creds, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: opts.body },
      action: {
        buttons: opts.buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

/**
 * A single call-to-action URL button (ADR 0139).
 *
 * Like `sendButtons` this is an ordinary in-session service message — no
 * template, but no delivery outside the 24h window either. Meta permits
 * exactly one button here and caps `display_text` at 20 characters; the
 * renderer clips, and this stays a straight pass-through so an over-long
 * label fails loudly at the API rather than being silently trimmed twice.
 */
export async function sendCtaUrl(
  creds: CloudCreds,
  opts: { to: string; body: string; displayText: string; url: string },
): Promise<CloudSendResult> {
  return post(creds, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: opts.body },
      action: {
        name: 'cta_url',
        parameters: { display_text: opts.displayText, url: opts.url },
      },
    },
  });
}

/**
 * Which media message a mime type should ride (ADR 0140).
 *
 * Meta's caps differ per kind, and so do the fields each accepts: only
 * `document` takes a `filename`, and `audio` takes no `caption` at all. So the
 * kind is not cosmetic — it decides both the size limit and whether the
 * message can carry the bot's prose.
 */
export type CloudMediaKind = 'image' | 'video' | 'audio' | 'document';

/** Meta's per-kind size caps, in bytes. */
export const CLOUD_MEDIA_LIMITS: Record<CloudMediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

/** Meta's cap on a media message's caption. */
export const CLOUD_CAPTION_MAX = 1024;

export function pickCloudMediaKind(mime: string): CloudMediaKind {
  const m = mime.toLowerCase();
  // Animated GIFs are not a WhatsApp image type; they ride as documents
  // rather than failing the image validator.
  if (m.startsWith('image/') && m !== 'image/gif') return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Upload bytes and get a media id back.
 *
 * Meta takes the file itself, unlike Twilio, which pulls from a public URL —
 * that difference is the whole reason outbound files are possible here: a
 * family document never has to be exposed unauthenticated to be sent.
 *
 * Native FormData + Blob, following the Telegram connector's upload helper,
 * so this adds no dependency.
 */
export async function uploadMedia(
  creds: CloudCreds,
  opts: { bytes: Buffer; filename: string; mimeType: string },
): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', opts.mimeType);
  form.append('file', new Blob([opts.bytes], { type: opts.mimeType }), opts.filename);

  const res = await fetch(mediaUploadUrl(creds), {
    method: 'POST',
    headers: { authorization: `Bearer ${creds.token}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`whatsapp cloud media upload failed: ${res.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { id?: string };
  if (!json.id) throw new Error('whatsapp cloud media upload returned no id');
  return json.id;
}

/**
 * Send a previously uploaded media id.
 *
 * `caption` is dropped for audio and `filename` is sent only for a document,
 * because Meta rejects the payload outright rather than ignoring a field it
 * does not accept for that kind.
 */
export async function sendMedia(
  creds: CloudCreds,
  opts: {
    to: string;
    kind: CloudMediaKind;
    mediaId: string;
    caption?: string;
    filename?: string;
  },
): Promise<CloudSendResult> {
  const media: Record<string, string> = { id: opts.mediaId };
  if (opts.caption && opts.kind !== 'audio') {
    media.caption = opts.caption.slice(0, CLOUD_CAPTION_MAX);
  }
  if (opts.kind === 'document' && opts.filename) media.filename = opts.filename;

  return post(creds, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.to,
    type: opts.kind,
    [opts.kind]: media,
  });
}

/**
 * Download an inbound media id.
 *
 * Two hops by design: the media node hands back a short-lived URL, and that
 * URL still needs the bearer token — it is not public. Both halves have to
 * succeed, so a failure here is the caller's cue to keep the caption rather
 * than pretend a file arrived.
 */
export async function fetchMedia(
  creds: CloudCreds,
  mediaId: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const metaRes = await fetch(mediaNodeUrl(creds, mediaId), {
    headers: { authorization: `Bearer ${creds.token}` },
  });
  if (!metaRes.ok) {
    throw new Error(`whatsapp cloud media lookup failed: ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) throw new Error(`whatsapp cloud media ${mediaId} has no url`);

  const binRes = await fetch(meta.url, {
    headers: { authorization: `Bearer ${creds.token}` },
  });
  if (!binRes.ok) {
    throw new Error(`whatsapp cloud media download failed: ${binRes.status}`);
  }
  return {
    bytes: Buffer.from(await binRes.arrayBuffer()),
    mimeType: meta.mime_type ?? 'application/octet-stream',
  };
}

/**
 * An approved template — the only thing deliverable OUTSIDE the 24h window.
 *
 * `bodyParams` fill the template's `{{n}}` slots in order. `buttons` fill its
 * quick-reply button payloads, one component per button index, which is how
 * Meta lets an approved template carry a dynamic callback id.
 */
export async function sendTemplate(
  creds: CloudCreds,
  opts: {
    to: string;
    name: string;
    languageCode: string;
    bodyParams?: string[];
    buttons?: CloudButton[];
  },
): Promise<CloudSendResult> {
  const components: unknown[] = [];
  if (opts.bodyParams?.length) {
    components.push({
      type: 'body',
      parameters: opts.bodyParams.map((text) => ({ type: 'text', text })),
    });
  }
  opts.buttons?.forEach((b, index) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload: b.id }],
    });
  });
  return post(creds, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.to,
    type: 'template',
    template: {
      name: opts.name,
      language: { code: opts.languageCode },
      ...(components.length ? { components } : {}),
    },
  });
}

/**
 * Verify `X-Hub-Signature-256` against the RAW request body.
 *
 * Must be the raw bytes: re-serialising the parsed JSON reorders keys and the
 * HMAC no longer matches. Comparison is timing-safe.
 */
export function verifyMetaSignature(opts: {
  appSecret: string;
  signatureHeader: string | undefined;
  rawBody: string;
}): boolean {
  const { appSecret, signatureHeader, rawBody } = opts;
  if (!appSecret || !signatureHeader) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself a failure.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
