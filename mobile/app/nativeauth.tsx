import * as Linking from 'expo-linking';
import { Redirect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { themed } from '@/theme';

WebBrowser.maybeCompleteAuthSession();

/**
 * Google's redirect target for the Android build (ADR 0081).
 *
 * The happy path never renders anything: the verified App Link hands the URL
 * straight to the app, `AuthSession` resolves off the deep link, and we bounce
 * home like /oauthredirect does. This screen only becomes visible when App Link
 * verification hasn't taken - a fresh install racing the OS verifier, an
 * unpublished assetlinks.json - and the Custom Tab is left showing the page.
 */
function buildDeepLink(params: Record<string, string | string[] | undefined>): string | null {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') qs.set(key, value);
  }
  const query = qs.toString();
  return query ? `chord://oauthredirect?${query}` : null;
}

export default function NativeAuth() {
  const params = useLocalSearchParams<Record<string, string>>();
  const deepLink = useMemo(() => buildDeepLink(params), [params]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !deepLink) return;
    // Google won't accept chord:// as a redirect_uri, but Android routes it
    // app-to-app happily - so the code can still reach the app this way.
    void Linking.openURL(deepLink).catch(() => {});
  }, [deepLink]);

  if (Platform.OS !== 'web') return <Redirect href="/" />;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        <Text style={styles.title}>Signing you in…</Text>
        <Text style={styles.note}>
          If Chord doesn&apos;t open on its own, tap below to finish signing in.
        </Text>
        {deepLink ? (
          <Pressable style={styles.button} onPress={() => void Linking.openURL(deepLink)}>
            <Text style={styles.buttonText}>Open Chord</Text>
          </Pressable>
        ) : (
          <Text style={styles.note}>This page has nothing to hand back - start again from Chord.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = themed((colors) => ({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: '600', color: colors.text },
  note: { fontSize: 14, color: colors.muted, textAlign: 'center' },
  button: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  buttonText: { color: colors.onAccent, fontSize: 16, fontWeight: '600' },
}));
