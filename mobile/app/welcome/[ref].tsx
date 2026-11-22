/**
 * Welcome-DM referrer landing route: `/welcome/<ref>` (ADR 0053 / 0031).
 *
 * The bot's welcome message links here. On web and on native (verified
 * universal/app link - ADR 0048), opening it stashes the referrer token
 * (survives Google's full-page OAuth redirect, same AsyncStorage trick as
 * `/join/<CODE>`) and bounces to the landing page to sign in. The welcome
 * screen consumes the token after sign-in and passes it to `authGoogle`,
 * which soft-links the WhatsApp/Telegram identity to the new account.
 */
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { isValidSignupRef, writePendingSignupRef } from '@/signup-ref';
import { colors, themed } from '@/theme';

export default function WelcomeRefScreen() {
  const { ref } = useLocalSearchParams<{ ref: string }>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Persist BEFORE navigating so the landing page is guaranteed to see
      // it after sign-in (including the OAuth round-trip).
      if (isValidSignupRef(ref)) await writePendingSignupRef(ref);
      if (!cancelled) router.replace('/');
    })();
    return () => {
      cancelled = true;
    };
  }, [ref]);

  if (!isValidSignupRef(ref)) return <Redirect href="/" />;

  return (
    <View style={styles.root}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.body}>Linking your chat to Chord…</Text>
    </View>
  );
}

const styles = themed((colors) => ({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: colors.bg,
  },
  body: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
}));
