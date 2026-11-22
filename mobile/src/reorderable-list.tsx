/**
 * A vertical list whose items can be pressed and held, then dragged to a new
 * place (ADR 0266). The gesture only starts after a long press, so an
 * ordinary scroll or tap is never taken over. Items do not shift while one is
 * being dragged; a line shows where it will land.
 *
 * Inside a `DragScrollView`, holding a dragged card near the top or bottom
 * edge scrolls the view, faster the closer the finger is to the edge, so a
 * card can be dropped anywhere in the list and not only where it was visible.
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';

import { dropIndex, edgeScrollStep, type DropSlot } from '@chord/kernel';

import { themed } from '@/theme';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

/** What a list needs from the view that scrolls it. */
interface DragScroller {
  /** Called when a drag starts: where the viewport is, on screen. */
  begin: () => void;
  /** The finger's position on screen; `onScrolled` hears every scroll step. */
  track: (absoluteY: number, onScrolled: () => void) => void;
  end: () => void;
  offset: () => number;
}

const DragScrollContext = createContext<DragScroller | null>(null);

/** A ScrollView that a `ReorderableList` inside it can scroll during a drag. */
export const DragScrollView = forwardRef<ScrollView, ScrollViewProps>(function DragScrollView(
  { onScroll, onLayout, onContentSizeChange, children, ...rest },
  ref,
) {
  const inner = useRef<ScrollView>(null);
  useImperativeHandle(ref, () => inner.current as ScrollView);
  const offset = useRef(0);
  const viewportH = useRef(0);
  const contentH = useRef(0);
  const windowTop = useRef(0);
  const finger = useRef<number | null>(null);
  const listener = useRef<(() => void) | null>(null);
  const frame = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const step = useCallback(() => {
    frame.current = null;
    const y = finger.current;
    if (y === null) return;
    const delta = edgeScrollStep(y - windowTop.current, viewportH.current);
    const max = Math.max(0, contentH.current - viewportH.current);
    const next = Math.min(max, Math.max(0, offset.current + delta));
    if (next === offset.current) return;
    offset.current = next;
    inner.current?.scrollTo({ y: next, animated: false });
    listener.current?.();
    frame.current = requestAnimationFrame(step);
  }, []);

  const scroller = useMemo<DragScroller>(
    () => ({
      begin: () => {
        // The host view measures; ScrollView's type just doesn't declare it.
        (inner.current as unknown as View | null)?.measureInWindow?.((_x, y, _w, h) => {
          windowTop.current = y;
          if (h > 0) viewportH.current = h;
        });
      },
      track: (absoluteY, onScrolled) => {
        finger.current = absoluteY;
        listener.current = onScrolled;
        if (frame.current === null) frame.current = requestAnimationFrame(step);
      },
      end: () => {
        finger.current = null;
        listener.current = null;
        stop();
      },
      offset: () => offset.current,
    }),
    [step, stop],
  );

  return (
    <DragScrollContext.Provider value={scroller}>
      <ScrollView
        {...DISMISS_KEYBOARD_ON_DRAG}
        {...rest}
        ref={inner}
        scrollEventThrottle={16}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
          offset.current = e.nativeEvent.contentOffset.y;
          onScroll?.(e);
        }}
        onLayout={(e) => {
          viewportH.current = e.nativeEvent.layout.height;
          onLayout?.(e);
        }}
        onContentSizeChange={(w, h) => {
          contentH.current = h;
          onContentSizeChange?.(w, h);
        }}
      >
        {children}
      </ScrollView>
    </DragScrollContext.Provider>
  );
});

export function ReorderableList<T>({
  items,
  keyOf,
  render,
  onMove,
  gap = 8,
}: {
  items: T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
  onMove: (from: number, to: number) => void;
  gap?: number;
}) {
  const slots = useRef<DropSlot[]>([]);
  const [target, setTarget] = useState<{ from: number; to: number } | null>(null);
  const scroller = useContext(DragScrollContext);
  // How far the view has scrolled since the drag began: the dragged card is
  // moved by this much too, so it stays under the finger.
  const scrolled = useSharedValue(0);
  const drag = useRef<{ from: number; startOffset: number; ty: number } | null>(null);

  const onLayoutAt = useCallback((i: number, e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    slots.current[i] = { y, h: height };
  }, []);

  const scrollDelta = useCallback(
    () => (scroller && drag.current ? scroller.offset() - drag.current.startOffset : 0),
    [scroller],
  );

  const showTarget = useCallback((from: number, dy: number) => {
    const to = dropIndex(slots.current, from, dy);
    setTarget((t) => (t && t.from === from && t.to === to ? t : { from, to }));
  }, []);

  const start = useCallback(
    (from: number) => {
      drag.current = { from, startOffset: scroller?.offset() ?? 0, ty: 0 };
      scrolled.value = 0;
      scroller?.begin();
    },
    [scroller, scrolled],
  );

  const hover = useCallback(
    (from: number, ty: number, absoluteY: number) => {
      if (!drag.current) return;
      drag.current.ty = ty;
      showTarget(from, ty + scrollDelta());
      scroller?.track(absoluteY, () => {
        const d = drag.current;
        if (!d) return;
        const delta = scrollDelta();
        scrolled.value = delta;
        showTarget(d.from, d.ty + delta);
      });
    },
    [scroller, scrollDelta, showTarget, scrolled],
  );

  const drop = useCallback(
    (from: number, ty: number) => {
      const dy = ty + scrollDelta();
      scroller?.end();
      drag.current = null;
      scrolled.value = 0;
      setTarget(null);
      const to = dropIndex(slots.current, from, dy);
      if (to !== from) onMove(from, to);
    },
    [onMove, scroller, scrollDelta, scrolled],
  );

  // Where the landing line goes: above the card it will sit before.
  const lineBefore =
    target && target.to !== target.from ? (target.to > target.from ? target.to + 1 : target.to) : null;

  return (
    <View style={{ gap }}>
      {items.map((it, i) => (
        <View key={keyOf(it)} onLayout={(e) => onLayoutAt(i, e)}>
          {/* Overlays, not rows: a line that took space would move the very
              cards the drop is being measured against. */}
          {lineBefore === i ? <View style={[styles.line, { top: -gap / 2 - 1.5 }]} /> : null}
          <DragItem index={i} scrolled={scrolled} onStart={start} onHover={hover} onDrop={drop}>
            {render(it)}
          </DragItem>
          {lineBefore === items.length && i === items.length - 1 ? (
            <View style={[styles.line, { bottom: -gap / 2 - 1.5 }]} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function DragItem({
  index,
  scrolled,
  onStart,
  onHover,
  onDrop,
  children,
}: {
  index: number;
  scrolled: SharedValue<number>;
  onStart: (from: number) => void;
  onHover: (from: number, ty: number, absoluteY: number) => void;
  onDrop: (from: number, ty: number) => void;
  children: ReactNode;
}) {
  const ty = useSharedValue(0);
  const scale = useSharedValue(1);
  const lifted = useSharedValue(0);

  // Memoised so a re-render mid-press does not rebuild the recognizer and
  // reset the long-press timer (the same care the Trips drag takes).
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(350)
        .onStart(() => {
          lifted.value = 1;
          scale.value = withSpring(1.03);
          runOnJS(onStart)(index);
        })
        .onUpdate((e) => {
          ty.value = e.translationY;
          runOnJS(onHover)(index, e.translationY, e.absoluteY);
        })
        .onEnd((e) => {
          runOnJS(onDrop)(index, e.translationY);
          ty.value = 0;
          lifted.value = 0;
          scale.value = withSpring(1);
        })
        .onFinalize(() => {
          ty.value = 0;
          lifted.value = 0;
          scale.value = withSpring(1);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, onStart, onHover, onDrop],
  );

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: ty.value + (lifted.value ? scrolled.value : 0) },
      { scale: scale.value },
    ],
    zIndex: lifted.value ? 10 : 0,
    opacity: lifted.value ? 0.92 : 1,
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={style}>{children}</Animated.View>
    </GestureDetector>
  );
}

const styles = themed((colors) => ({
  line: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2, backgroundColor: colors.accent, zIndex: 5 },
}));
