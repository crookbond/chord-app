/**
 * ADR 0297 — no text box is left behind the on-screen keyboard.
 *
 * Android draws edge-to-edge, so its window never shrinks for the keyboard,
 * and iOS never did: a box low on a screen, or a Save button under a form,
 * was hidden with no way to reach it. Two pieces cover every screen:
 *
 * - `KeyboardScrollView` — a ScrollView that pads its bottom by the keyboard
 *   and scrolls the focused box into view. Every `TextInput` from
 *   `@/text-input` inside one reveals itself on focus; nothing to wire per box.
 * - `KeyboardModalBody` — the body of a Modal with a text box: it shrinks
 *   the space the sheet is laid out in, so a centred sheet moves up.
 *
 * The web is left alone: the browser already does both.
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';
import { keyboardOffset, keyboardRevealDelta } from '@chord/kernel';

import { useOfflineStripHeight } from '@/offline-bar';

/**
 * Dragging a scrolling screen closes the keyboard: on iPhone it follows the
 * finger down, on Android any drag closes it. React Native's default is to
 * leave it open, so every scrollable that sits under a text box spreads this.
 */
export const DISMISS_KEYBOARD_ON_DRAG: Pick<ScrollViewProps, 'keyboardDismissMode'> = {
  keyboardDismissMode: Platform.OS === 'ios' ? 'interactive' : 'on-drag',
};

/** Height of the keyboard now showing, 0 when hidden or on the web. */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    // iOS announces before it animates; Android only after.
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(show, (e) => setHeight(e.endCoordinates.height));
    const b = Keyboard.addListener(hide, () => setHeight(0));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  return height;
}

/**
 * A screen whose bottom edge (a composer, a reply box) must sit on top of the
 * keyboard. iOS uses KeyboardAvoidingView with the header's height. Android
 * measures where this view's bottom really is on screen and pads by exactly
 * the part the keyboard covers: the header-height offset guessed wrong there
 * (edge-to-edge headers, a window that sometimes does shrink), leaving a
 * blank band between the composer and the keyboard.
 */
export function KeyboardScreen({
  children,
  style,
  headerHeight,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  headerHeight: number;
}) {
  // The offline strip sits above the header (ADR 0311): the screen's top is
  // that much lower than the header alone says.
  const aboveHeader = useOfflineStripHeight();
  if (Platform.OS !== 'android') {
    return (
      <KeyboardAvoidingView
        style={style}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardOffset({ headerHeight, aboveHeader })}
      >
        {children}
      </KeyboardAvoidingView>
    );
  }
  return <AndroidKeyboardScreen style={style}>{children}</AndroidKeyboardScreen>;
}

function AndroidKeyboardScreen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const box = useRef<View>(null);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [bottom, setBottom] = useState<number | null>(null);

  const measure = useCallback(() => {
    box.current?.measureInWindow((_x, y, _w, h) => setBottom(y + h));
  }, []);

  useEffect(() => {
    const a = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardTop(e.endCoordinates.screenY);
      measure();
    });
    const b = Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(null));
    return () => {
      a.remove();
      b.remove();
    };
  }, [measure]);

  // Padding sits inside the view, so its outer bottom does not move when it
  // changes; it moves only if the window itself shrank, which onLayout catches.
  const overlap = keyboardTop != null && bottom != null ? Math.max(0, bottom - keyboardTop) : 0;
  return (
    <View ref={box} style={[style, overlap > 0 ? { paddingBottom: overlap } : null]} onLayout={measure}>
      {children}
    </View>
  );
}

/** True while the on-screen keyboard is up (never on the web). */
export function useKeyboardShown(): boolean {
  return useKeyboardHeight() > 0;
}

type Measurable = Pick<View, 'measureInWindow'>;
const RevealContext = createContext<((box: Measurable) => void) | null>(null);

/** Used by `@/text-input`: call on focus to bring the box above the keyboard. */
export function useRevealOnFocus(): ((box: Measurable) => void) | null {
  return useContext(RevealContext);
}

export const KeyboardScrollView = forwardRef<ScrollView, ScrollViewProps>(function KeyboardScrollView(
  { children, contentContainerStyle, onScroll, scrollEventThrottle, keyboardShouldPersistTaps, ...rest },
  ref,
) {
  const inner = useRef<ScrollView>(null);
  useImperativeHandle(ref, () => inner.current as ScrollView);
  const offset = useRef(0);
  const pending = useRef<Measurable | null>(null);
  const keyboard = useKeyboardHeight();

  const reveal = useCallback((box: Measurable, kb: number) => {
    box.measureInWindow((_x, y, _w, h) => {
      const delta = keyboardRevealDelta({
        boxTop: y,
        boxHeight: h,
        windowHeight: Dimensions.get('window').height,
        keyboardHeight: kb,
      });
      if (delta > 0) inner.current?.scrollTo({ y: offset.current + delta, animated: true });
    });
  }, []);

  // The box is focused before the keyboard reports its height, so a focus
  // waits for it; once it is up, a focus moving between boxes reveals at once.
  useEffect(() => {
    if (keyboard <= 0 || !pending.current) return;
    // A frame for the bottom padding to lay out, or there is nothing to scroll into.
    const t = setTimeout(() => pending.current && reveal(pending.current, keyboard), 50);
    return () => clearTimeout(t);
  }, [keyboard, reveal]);

  const keyboardRef = useRef(keyboard);
  keyboardRef.current = keyboard;
  const onFocusBox = useCallback(
    (box: Measurable) => {
      pending.current = box;
      if (keyboardRef.current > 0) setTimeout(() => reveal(box, keyboardRef.current), 50);
    },
    [reveal],
  );

  const padded = useMemo(
    () => [contentContainerStyle, keyboard > 0 ? { paddingBottom: keyboard + 24 } : null],
    [contentContainerStyle, keyboard],
  );

  return (
    <RevealContext.Provider value={Platform.OS === 'web' ? null : onFocusBox}>
      <ScrollView
        ref={inner}
        {...DISMISS_KEYBOARD_ON_DRAG}
        {...rest}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps ?? 'handled'}
        contentContainerStyle={padded}
        scrollEventThrottle={scrollEventThrottle ?? 16}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
          offset.current = e.nativeEvent.contentOffset.y;
          onScroll?.(e);
        }}
      >
        {children}
      </ScrollView>
    </RevealContext.Provider>
  );
});

/**
 * Wrap a Modal's content in this: the area the sheet is laid out in loses
 * the keyboard's height, so a centred sheet rises above it. `padding` on both
 * platforms (Android draws edge-to-edge, ADR 0263).
 */
export function KeyboardModalBody({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <KeyboardAvoidingView
      style={[styles.fill, style]}
      behavior={Platform.OS === 'web' ? undefined : 'padding'}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
