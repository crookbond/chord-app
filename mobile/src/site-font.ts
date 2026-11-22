import { Platform } from 'react-native';

/**
 * Inter for the public web pages (landing, privacy policy, terms).
 *
 * react-native-web stamps the system font stack on every <Text> through its
 * reset class, so a body-level font-family never cascades into text, and a
 * global CSS override of that class would also clobber the icon fonts the
 * app screens use - the font has to be named per text style. Native resolves
 * this to undefined (a no-op), keeping the platform font in the app.
 */
export const siteFont = Platform.select({
  web: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  default: undefined,
});

/** Idempotently load Inter from Google Fonts (web only). */
export function ensureSiteFontLoaded(): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const id = 'chord-inter-font';
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href =
    'https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap';
  document.head.appendChild(link);
}
