/**
 * ADR 0253 - the app's way into WhatsApp. The number is configuration the server
 * hands out (`WHATSAPP_PUBLIC_NUMBER`), so these only turn it into something to
 * tap or read; nothing here knows a number.
 */

/** `https://wa.me/<digits>` (with an optional first message), or null when there
 *  is no usable number. wa.me wants digits only: no `+`, spaces or dashes. */
export function whatsappChatUrl(e164: string | null | undefined, prefill?: string): string | null {
  const digits = (e164 ?? '').replace(/\D+/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  const text = prefill?.trim();
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** A number as a person would write it: `+1 555 555 0142` for North America,
 *  otherwise the E.164 string unchanged (country grouping rules differ too
 *  much to guess at without a library). */
export function formatWhatsappNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+1 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
