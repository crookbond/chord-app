/**
 * ADR 0326 - a signature pasted from another mail app, pictures and all.
 * The rules are in kernel (`signature-paste.ts`); this uploads the pictures
 * and reads the clipboard on each platform.
 */
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

import {
  cleanPastedSignatureHtml,
  listImageSources,
  looksLikeHtml,
  pastedImageNeed,
  plainTextToSignatureHtml,
  replaceImageSources,
} from '@chord/kernel';

import { uploadSignatureImage } from './api';

/** Wider than this is drawn smaller before upload (web): a logo, not a photo. */
const MAX_WIDTH = 800;
const MAX_UPLOAD = 900_000;

export interface PastedSignature {
  /** Signature HTML, its pictures at public links. */
  html: string;
  /** Pictures that could not be kept (and the reason for the first). */
  dropped: number;
  error: string | null;
}

/** A browser `data:` URL drawn smaller when it is wide or heavy. */
async function shrinkOnWeb(dataUrl: string): Promise<string> {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return dataUrl;
  const isGif = /^data:image\/gif/i.test(dataUrl);
  const img = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
  if (!loaded) return dataUrl;
  const heavy = dataUrl.length * 0.75 > MAX_UPLOAD;
  if (img.naturalWidth <= MAX_WIDTH && !heavy) return dataUrl;
  // An animated GIF would lose its animation; only shrink one too big to keep.
  if (isGif && !heavy) return dataUrl;
  const scale = Math.min(1, MAX_WIDTH / img.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const png = canvas.toDataURL('image/png');
  return png.length * 0.75 <= MAX_UPLOAD ? png : canvas.toDataURL('image/jpeg', 0.85);
}

async function upload(dataUrl: string): Promise<string> {
  const { url } = await uploadSignatureImage(await shrinkOnWeb(dataUrl));
  return url;
}

/**
 * Pasted content as signature HTML. `html` is the clipboard's HTML (null when
 * it had only text or a picture); `text` its plain text; `images` the
 * pictures copied with it, as `data:` URLs, in order.
 */
export async function signatureFromPaste(input: {
  html: string | null;
  text?: string | null;
  images: string[];
}): Promise<PastedSignature | null> {
  let html: string;
  if (input.html && looksLikeHtml(input.html)) html = cleanPastedSignatureHtml(input.html);
  else if (input.images.length) {
    html = [input.text?.trim() ? plainTextToSignatureHtml(input.text.trim()) : '', ...input.images.map((_, i) => `<img src="cid:${i}">`)]
      .filter(Boolean)
      .join('<br>');
  } else return null;

  const sources = listImageSources(html);
  const clipboard = [...input.images];
  let dropped = 0;
  let error: string | null = null;
  const urls = await Promise.all(
    sources.map(async (src) => {
      const need = pastedImageNeed(src);
      if (need === 'keep') return src;
      const data = need === 'upload' ? src : clipboard.shift();
      if (!data) {
        dropped++;
        return null;
      }
      try {
        return await upload(data);
      } catch (e) {
        dropped++;
        error ??= e instanceof Error ? e.message : 'A picture could not be kept.';
        return null;
      }
    }),
  );
  return { html: replaceImageSources(html, (_src, i) => urls[i] ?? null), dropped, error };
}

/** A picture file, read as a `data:` URL (web). */
function fileToDataUrl(file: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

export interface PasteTarget {
  /** The box's text when the paste happened, and the selection it replaces. */
  value: string;
  start: number;
  end: number;
}

export type ClipboardContent = { html: string | null; text: string; images: string[] };

/**
 * A ref for a signature box on the web: a paste that carries formatting or a
 * picture is taken over and handed to `onPaste`; plain text pastes as usual.
 * The clipboard is only readable during the event, so it is copied out then.
 */
export function useWebSignaturePaste(
  onPaste: (paste: ClipboardContent, at: PasteTarget) => void,
): (node: unknown) => void {
  const latest = useRef(onPaste);
  latest.current = onPaste;
  const attached = useRef<{ el: HTMLTextAreaElement; off: () => void } | null>(null);
  return useCallback((node: unknown) => {
    if (Platform.OS !== 'web') return;
    const el = (node as HTMLTextAreaElement | null) ?? null;
    if (attached.current?.el === el) return;
    attached.current?.off();
    attached.current = null;
    if (!el || typeof el.addEventListener !== 'function') return;
    const handler = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const html = data.getData('text/html') || null;
      const files = Array.from(data.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!(html && looksLikeHtml(html)) && !files.length) return;
      e.preventDefault();
      const at = { value: el.value, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
      const text = data.getData('text/plain');
      void Promise.all(files.map(fileToDataUrl)).then((images) =>
        latest.current({ html, text, images: images.filter((x): x is string => !!x) }, at),
      );
    };
    el.addEventListener('paste', handler as EventListener);
    attached.current = { el, off: () => el.removeEventListener('paste', handler as EventListener) };
  }, []);
}

/** The phone's clipboard: its HTML when it has some, and a picture on it. */
export async function readNativeClipboard(): Promise<{ html: string | null; text: string; images: string[] }> {
  const [html, text, hasImage] = await Promise.all([
    Clipboard.getStringAsync({ preferredFormat: Clipboard.StringFormat.HTML }).catch(() => ''),
    Clipboard.getStringAsync().catch(() => ''),
    Clipboard.hasImageAsync().catch(() => false),
  ]);
  let image = hasImage ? await Clipboard.getImageAsync({ format: 'png' }).catch(() => null) : null;
  // A photo copied as PNG is often too heavy to keep; JPEG is a fraction of it.
  if (image?.data && image.data.length * 0.75 > MAX_UPLOAD) {
    image = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.85 }).catch(() => null);
  }
  return { html: html && looksLikeHtml(html) ? html : null, text, images: image?.data ? [image.data] : [] };
}

/** One picture from the photo library, uploaded; null when none was picked. */
export async function pickSignaturePicture(): Promise<string | null> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.6 });
  const asset = r.canceled ? null : r.assets?.[0];
  if (!asset) return null;
  if (!asset.base64) return asset.uri.startsWith('data:image/') ? upload(asset.uri) : null;
  const mime = asset.mimeType && /^image\//.test(asset.mimeType) ? asset.mimeType : 'image/jpeg';
  return upload(`data:${mime};base64,${asset.base64}`);
}
