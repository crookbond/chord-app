/**
 * The frame a new message is written in (ADR 0341): a floating window in the
 * corner of a wide web page, a sheet over the mail everywhere else. Pulling
 * the sheet down puts the message away as a draft, the same on iPhone,
 * Android and a narrow browser - the gesture is drawn here, not left to the
 * platform, because iOS's own sheet swipe has no Android equivalent and its
 * offset in the window breaks the keyboard avoidance (ADR 0222).
 *
 * The route is a transparent modal, so the Email list stays drawn behind it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  composeLayout,
  composePopoutSize,
  sheetDragStarts,
  sheetSwipeDismisses,
} from '@chord/kernel';

import { composeHeaderOptions } from '@/email-compose-ui';
import { Icon } from '@/email-reader-bar';
import { KeyboardScreen } from '@/keyboard';
import { colors, themed } from '@/theme';

type HeaderOpts = Parameters<typeof composeHeaderOptions>[0];

export function ComposeFrame({
  header,
  onSwipeAway,
  children,
}: {
  header: HeaderOpts;
  /** Pulled down (or Escape on web): save it as a draft and close. */
  onSwipeAway: () => void;
  children: ReactNode;
}) {
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = composeLayout(Platform.OS, win.width);
  const [expanded, setExpanded] = useState(false);
  const h = composeHeaderOptions(header);

  const drag = useRef(new Animated.Value(0)).current;
  const away = useRef(onSwipeAway);
  away.current = onSwipeAway;
  const heightRef = useRef(win.height);
  heightRef.current = win.height;
  const nativeDriver = Platform.OS !== 'web';

  const pan = useMemo(() => {
    const back = () =>
      Animated.spring(drag, { toValue: 0, useNativeDriver: nativeDriver, bounciness: 0 }).start();
    return PanResponder.create({
      // Capture, so a drag that begins on a header button still pulls the
      // sheet; a tap never crosses the threshold and stays a tap.
      onMoveShouldSetPanResponderCapture: (_e, g) => sheetDragStarts(g.dx, g.dy),
      onPanResponderGrant: () => Keyboard.dismiss(),
      onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (!sheetSwipeDismisses(g.dy, g.vy)) return back();
        Animated.timing(drag, {
          toValue: heightRef.current,
          duration: 160,
          useNativeDriver: nativeDriver,
        }).start(() => away.current());
      },
      onPanResponderTerminate: back,
    });
  }, [drag, nativeDriver]);

  // Escape puts a popout away the way a pull puts a sheet away.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') away.current();
    };
    // Capture: a focused text field stops Escape from reaching the window.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const bar = (
    <View style={styles.bar}>
      <View style={styles.barSide}>{h.headerLeft()}</View>
      <Text style={styles.title} numberOfLines={1}>
        {header.title}
      </Text>
      <View style={[styles.barSide, styles.barRight]}>
        {layout === 'popout' ? (
          <Pressable
            onPress={() => setExpanded((v) => !v)}
            hitSlop={8}
            style={styles.expand}
            accessibilityLabel={expanded ? 'Make the window smaller' : 'Make the window bigger'}
          >
            <Icon name={expanded ? 'arrow-collapse' : 'arrow-expand'} size={18} color={colors.muted} />
          </Pressable>
        ) : null}
        {h.headerRight()}
      </View>
    </View>
  );

  if (layout === 'popout') {
    const size = composePopoutSize(win, expanded);
    return (
      <View style={styles.root}>
        <View style={[styles.backdrop, !expanded && styles.backdropLight]} />
        <View
          style={[
            styles.popout,
            size,
            expanded
              ? { top: (win.height - size.height) / 2, left: (win.width - size.width) / 2 }
              : { right: 24, bottom: 24 },
          ]}
        >
          {bar}
          {children}
        </View>
      </View>
    );
  }

  const top = Platform.OS === 'web' ? 16 : insets.top + 8;
  return (
    <KeyboardScreen style={styles.root} headerHeight={0}>
      <View style={styles.backdrop} />
      <Animated.View
        style={[
          styles.sheet,
          { marginTop: top, paddingBottom: insets.bottom, transform: [{ translateY: drag }] },
        ]}
      >
        <View {...pan.panHandlers}>
          <View style={styles.grabZone} accessibilityLabel="Pull down to save as a draft">
            <View style={styles.grabber} />
          </View>
          {bar}
        </View>
        {children}
      </Animated.View>
    </KeyboardScreen>
  );
}

const styles = themed((colors) => ({
  root: { flex: 1, backgroundColor: 'transparent' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  backdropLight: { backgroundColor: 'rgba(0,0,0,0.12)' },
  sheet: {
    flex: 1,
    backgroundColor: colors.card,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    overflow: 'hidden',
  },
  popout: {
    position: 'absolute',
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  grabZone: { alignItems: 'center', paddingTop: 8, paddingBottom: 2 },
  grabber: { width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: Platform.OS === 'web' ? 0 : 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  barSide: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  barRight: { justifyContent: 'flex-end' },
  title: { color: colors.text, fontSize: 16, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  expand: { paddingHorizontal: 6, paddingVertical: 4 },
}));
