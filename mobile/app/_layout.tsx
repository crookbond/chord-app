import { Fragment, useCallback, useEffect, type ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAppleSync } from '@/applesync';
import { useResolvedColorScheme } from '@/color-scheme';
import { startEmailOutbox } from '@/email-outbox';
import { addNotificationTapHandler, refreshPushRegistration } from '@/push';
import { colors, themed } from '@/theme';
import { useSyncDeviceLocation } from '@/device-location';
import { useReportTimezone } from '@/timezone';
import { UpdateBanner } from '@/update-banner';
import { OfflineFrame } from '@/offline-bar';
// Registers the chat sender so a queue saved before a restart goes out without
// the chat screen being opened first (ADR 0311 addendum).
import '@/chat-outbox';
import '@/todo-sync';
import '@/todo-copies';
import '@/proposal-answers';

/**
 * A render error anywhere below a layout lands here (expo-router), instead of
 * a white screen (web) or the app closing (phones). Try again re-renders the
 * route; nothing the user had saved is touched.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    console.error('screen crashed', error);
  }, [error]);
  return (
    <View style={crash.page}>
      <Text style={crash.title}>Something went wrong</Text>
      <Text style={crash.body}>This screen hit a problem. Your messages and email are safe.</Text>
      {__DEV__ ? <Text style={crash.detail}>{error.message}</Text> : null}
      <Pressable onPress={() => void retry()} style={crash.btn} accessibilityRole="button">
        <Text style={crash.btnText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const crash = themed((colors) => ({
  page: { flex: 1, backgroundColor: colors.bg, alignItems: 'center' as const, justifyContent: 'center' as const, padding: 24, gap: 12 },
  title: { color: colors.text, fontSize: 18, fontWeight: '600' as const },
  body: { color: colors.muted, fontSize: 15, textAlign: 'center' as const },
  detail: { color: colors.red, fontSize: 12, textAlign: 'center' as const },
  btn: { marginTop: 8, backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  btnText: { color: colors.onAccent, fontSize: 15, fontWeight: '600' as const },
}));

export default function RootLayout() {
  // ADR 0057 - mirror the device calendar into Chord + two-way sync Reminders on
  // foreground. Self-gating (iOS-only reminders; calendar pull no-ops until the
  // user opts calendars in via Settings).
  useAppleSync();

  // Keep the daily briefing on the user's clock after they travel.
  useReportTimezone();
  useSyncDeviceLocation();

  useEffect(() => {
    // If the user enabled push before, refresh the (rotatable) token on launch.
    void refreshPushRegistration();
    // ADR 0311 - email sent with no network goes once the server answers.
    startEmailOutbox();
    // Route taps on a delivered notification to the relevant group.
    const sub = addNotificationTapHandler();
    return () => sub.remove();
  }, []);

  // ADR 0282 - a scheme change remounts each screen's content (styles are read
  // through getters, so a fresh render picks up the new palette). The
  // navigator itself stays mounted, so history and the current route survive.
  const { scheme, epoch, ready } = useResolvedColorScheme();
  const screenLayout = useCallback(
    ({ children }: { children: ReactNode }) => <Fragment key={epoch}>{children}</Fragment>,
    [epoch],
  );

  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  return (
    // ADR 0128 - Swipeable needs this at the root; without it a swipe does
    // nothing on Android and the feature would look built and be inert.
    <GestureHandlerRootView style={{ flex: 1 }}>
    <SafeAreaProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <OfflineFrame>
      <Stack
        screenLayout={screenLayout}
        screenOptions={{
          headerStyle: { backgroundColor: colors.card },
          headerTitleStyle: { color: colors.text },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        {/*
          Top-level tabs (Messages / Email / Catchup / Calendar / Settings) are
          siblings reached via router.replace, not a push hierarchy - so a
          directional slide is misleading (it always enters from the right
          regardless of the tab's position in the nav bar). The default
          replaceAnimation is 'push', which slides horizontally; we swap them
          instantly instead, like a classic bottom-tab bar. Drill-down screens
          (group detail/settings) keep the default slide_from_right, where the
          left↔right motion is correct.
        */}
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="join/[code]" options={{ headerShown: false }} />
        <Stack.Screen name="intro" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="ai-consent" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="connect" options={{ title: 'Connect an app' }} />
        <Stack.Screen name="privacy" options={{ title: 'Privacy Policy' }} />
        <Stack.Screen name="tos" options={{ title: 'Terms of Service' }} />
        <Stack.Screen name="delete-account" options={{ title: 'Delete your account' }} />
        <Stack.Screen name="email/index" options={{ title: 'Email', animation: 'none' }} />
        <Stack.Screen
          name="groups/index"
          options={{ title: 'Messages', animation: 'none', headerBackVisible: false }}
        />
        <Stack.Screen name="groups/[id]/index" options={{ title: '' }} />
        <Stack.Screen name="groups/[id]/settings" options={{ title: 'Group settings' }} />
        <Stack.Screen name="groups/[id]/about" options={{ title: 'About this family' }} />
        <Stack.Screen name="catchup/[tab]" options={{ title: 'Action Items', animation: 'none' }} />
        <Stack.Screen name="calendar" options={{ title: 'Calendar', animation: 'none' }} />
        <Stack.Screen name="people" options={{ title: 'People', animation: 'none' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings', animation: 'none' }} />
        <Stack.Screen name="file-viewer" options={{ presentation: 'fullScreenModal' }} />
        {/* ADR 0341 - a sheet / popout over the Email list, which stays drawn behind it. */}
        <Stack.Screen
          name="email/compose"
          options={{
            presentation: 'transparentModal',
            headerShown: false,
            animation: Platform.OS === 'web' ? 'none' : 'slide_from_bottom',
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
      </Stack>
      </OfflineFrame>
      <UpdateBanner key={epoch} />
    </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
