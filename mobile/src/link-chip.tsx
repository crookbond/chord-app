/**
 * The one way Chord renders a link out to somebody else's site.
 *
 * Extracted from the To Do's tab when a third surface needed it (ADR 0138):
 * a tracking link on a delivery, a FlightAware link on a flight, and the saved
 * links that were already here. Copies of a tap target drift in padding and in
 * what they do on failure, and a link that silently does nothing is worse than
 * no link at all.
 *
 * Chord never FETCHES these — it renders them and the user taps (ADR 0135).
 */
import { Image, Linking, Pressable, Text } from 'react-native';

import { themed } from '@/theme';

export function urlHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] ?? url;
  }
}

/**
 * Cached favicon via Google's S2 service. Tiny image, edge-cached across the
 * planet, no API key, no setup. Renders instantly even on first load because
 * Google already has these in its CDN.
 */
export function faviconUrl(url: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(urlHost(url))}&sz=32`;
}

export function openExternal(url: string) {
  Linking.openURL(url).catch(() => {});
}

export function LinkChip({
  url,
  label,
  icon,
}: {
  url: string;
  label?: string;
  /** Shown instead of the favicon — for a link whose host says nothing. */
  icon?: string;
}) {
  return (
    <Pressable style={styles.linkChip} onPress={() => openExternal(url)}>
      {icon ? (
        <Text style={styles.icon}>{icon}</Text>
      ) : (
        <Image source={{ uri: faviconUrl(url) }} style={styles.favicon} />
      )}
      <Text style={styles.linkText} numberOfLines={1}>
        {label ?? urlHost(url)}
      </Text>
    </Pressable>
  );
}

const styles = themed((colors) => ({
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 8,
    backgroundColor: colors.bg2,
    alignSelf: 'flex-start',
  },
  favicon: { width: 14, height: 14, borderRadius: 3 },
  icon: { fontSize: 12 },
  linkText: { fontSize: 12, color: colors.accent, flexShrink: 1 },
}));
