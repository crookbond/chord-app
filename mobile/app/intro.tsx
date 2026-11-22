/**
 * ADR 0327 — the first-launch intro: what Chord does, in twelve animated pages,
 * shown once on this device: on a phone before the sign-in page, else after
 * sign-in and before the AI consent screen.
 * Settings → "What Chord does" plays it again (`replay=1`, back to Settings).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { INTRO_SEEN_KEY, INTRO_SLIDES, bootReturnPath } from '@chord/kernel';

import { IntroArt } from '@/intro-art';
import { launchTab } from '@/group-nav';
import { themed } from '@/theme';

const NATIVE = Platform.OS !== 'web';
const MAX_W = 560;

export default function IntroScreen() {
  const { next, consent, replay, signin } = useLocalSearchParams<{
    next?: string;
    consent?: string;
    replay?: string;
    signin?: string;
  }>();
  const { width: winW } = useWindowDimensions();
  const pageW = Math.min(winW, MAX_W);
  const [index, setIndex] = useState(0);
  const pos = useRef(new Animated.Value(0)).current;
  const indexRef = useRef(0);
  const last = INTRO_SLIDES.length - 1;

  const goTo = useCallback(
    (i: number) => {
      const to = Math.max(0, Math.min(last, i));
      indexRef.current = to;
      setIndex(to);
      Animated.spring(pos, { toValue: to, useNativeDriver: NATIVE, bounciness: 4, speed: 14 }).start();
    },
    [last, pos],
  );

  const finish = useCallback(async () => {
    try {
      await AsyncStorage.setItem(INTRO_SEEN_KEY, '1');
    } catch {
      /* a failed write only means the intro shows again */
    }
    if (replay === '1') {
      if (router.canGoBack()) router.back();
      else router.replace('/settings');
      return;
    }
    if (signin === '1') {
      router.replace('/');
      return;
    }
    const to = bootReturnPath(next, launchTab());
    if (consent === '1') router.replace({ pathname: '/ai-consent', params: { next: to } });
    else router.replace(to as never);
  }, [consent, next, replay, signin]);

  const pageWRef = useRef(pageW);
  const goToRef = useRef(goTo);
  useEffect(() => {
    pageWRef.current = pageW;
    goToRef.current = goTo;
  }, [pageW, goTo]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_, g) => pos.setValue(indexRef.current - g.dx / pageWRef.current),
      onPanResponderRelease: (_, g) => {
        const fling = Math.abs(g.vx) > 0.4 ? Math.sign(-g.vx) : 0;
        const moved = Math.abs(g.dx) > pageWRef.current * 0.25 ? Math.sign(-g.dx) : 0;
        goToRef.current(indexRef.current + (fling || moved));
      },
      onPanResponderTerminate: () => goToRef.current(indexRef.current),
    }),
  ).current;

  // Arrow keys on the web.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goToRef.current(indexRef.current + 1);
      if (e.key === 'ArrowLeft') goToRef.current(indexRef.current - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const translateX = pos.interpolate({ inputRange: [0, 1], outputRange: [0, -pageW] });
  const isLast = index === last;

  return (
    <SafeAreaView style={s.root} edges={['top', 'bottom', 'left', 'right']}>
      <View style={[s.top, { width: pageW }]}>
        <Text style={s.brand}>Chord</Text>
        {!isLast ? (
          <Pressable onPress={() => void finish()} hitSlop={12} accessibilityRole="button">
            <Text style={s.skip}>Skip</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={[s.viewport, { width: pageW }]} {...pan.panHandlers}>
        <Animated.View style={[s.strip, { width: pageW * INTRO_SLIDES.length, transform: [{ translateX }] }]}>
          {INTRO_SLIDES.map((slide, i) => (
            <View key={slide.key} style={[s.page, { width: pageW }]} accessible={i === index}>
              <View style={s.artWrap}>
                <IntroArt slide={slide.key} active={i === index} />
              </View>
              <Text style={s.title} accessibilityRole="header">
                {slide.title}
              </Text>
              <Text style={s.body}>{slide.body}</Text>
            </View>
          ))}
        </Animated.View>
      </View>

      <View style={[s.bottom, { width: pageW }]}>
        <View style={s.dots}>
          {INTRO_SLIDES.map((slide, i) => (
            <Pressable
              key={slide.key}
              onPress={() => goTo(i)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Page ${i + 1} of ${INTRO_SLIDES.length}`}
            >
              <View style={[s.dot, i === index && s.dotOn]} />
            </Pressable>
          ))}
        </View>
        <View style={s.buttons}>
          {index > 0 ? (
            <Pressable style={s.ghost} onPress={() => goTo(index - 1)} accessibilityRole="button">
              <Text style={s.ghostTxt}>Back</Text>
            </Pressable>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <Pressable
            style={s.btn}
            onPress={() => (isLast ? void finish() : goTo(index + 1))}
            accessibilityRole="button"
          >
            <Text style={s.btnTxt}>{isLast ? (replay === '1' ? 'Done' : 'Get started') : 'Next'}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = themed((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center' as const },
  top: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 24,
    paddingTop: 12,
    height: 52,
  },
  brand: { color: colors.text, fontSize: 20, fontWeight: '800' as const, letterSpacing: -0.3 },
  skip: { color: colors.muted, fontSize: 16, fontWeight: '600' as const },
  viewport: { flex: 1, overflow: 'hidden' as const },
  strip: { flex: 1, flexDirection: 'row' as const },
  page: { flex: 1, justifyContent: 'center' as const, paddingHorizontal: 28 },
  artWrap: {
    alignSelf: 'center' as const,
    padding: 16,
    borderRadius: 28,
    backgroundColor: colors.bg2,
    marginBottom: 32,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' as const, textAlign: 'center' as const, letterSpacing: -0.4 },
  body: {
    color: colors.muted,
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center' as const,
    marginTop: 12,
    maxWidth: 420,
    alignSelf: 'center' as const,
  },
  bottom: { paddingHorizontal: 24, paddingBottom: 16 },
  dots: { flexDirection: 'row' as const, justifyContent: 'center' as const, gap: 8, marginBottom: 20 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  dotOn: { width: 24, backgroundColor: colors.text },
  buttons: { flexDirection: 'row' as const, gap: 12 },
  btn: { flex: 1, backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center' as const },
  btnTxt: { color: colors.onAccent, fontSize: 16, fontWeight: '700' as const },
  ghost: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center' as const,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ghostTxt: { color: colors.text, fontSize: 16, fontWeight: '600' as const },
}));
