/**
 * ADR 0327 — the animated drawings on the first-launch intro. Each is a small
 * scene driven by one looping clock `t` (0 → 1, then a pause on the finished
 * picture), so every element is just "what does it look like at time t".
 * Pure React Native Animated: no native module, so it ships over the air and
 * draws the same on iOS, Android and the web. With Reduce Motion on, the
 * clock is parked at 1 and the finished picture is shown still.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, Platform, Text, View, type ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps } from 'react';
import { CHORD_CALENDAR_PALETTE } from '@chord/kernel';

import { colors, themed } from '@/theme';

type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];
type AV = Animated.Value | Animated.AnimatedInterpolation<number>;

const [ORANGE, BLUE, GREEN, YELLOW, PURPLE] = CHORD_CALENDAR_PALETTE;
const NATIVE = Platform.OS !== 'web';
// Metro resolves image assets only through require().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const APP_ICON = require('../assets/icon.png');
const RUN_MS = 3400;
const HOLD_MS = 1400;

export const ART_W = 300;
export const ART_H = 240;

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((r) => live && setReduce(r))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** The scene clock: runs while the page is in front, parked at the end otherwise. */
function useClock(active: boolean): Animated.Value {
  const t = useRef(new Animated.Value(0)).current;
  const reduce = useReduceMotion();
  useEffect(() => {
    if (reduce || !active) {
      t.setValue(reduce ? 1 : 0);
      return;
    }
    t.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: RUN_MS, easing: Easing.linear, useNativeDriver: NATIVE }),
        Animated.delay(HOLD_MS),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduce, t]);
  return t;
}

/** `from` before a, `to` after b, eased in between. */
function seg(t: Animated.Value, a: number, b: number, from: number, to: number, ease = true): AV {
  if (!ease) return t.interpolate({ inputRange: [a, b], outputRange: [from, to], extrapolate: 'clamp' });
  const steps = 8;
  const input: number[] = [];
  const output: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    const e = 1 - Math.pow(1 - x, 3);
    input.push(a + (b - a) * x);
    output.push(from + (to - from) * e);
  }
  return t.interpolate({ inputRange: input, outputRange: output, extrapolate: 'clamp' });
}

/** 0 → a little over 1 → 1: something arriving. */
function pop(t: Animated.Value, a: number, b: number): AV {
  const m = a + (b - a) * 0.65;
  return t.interpolate({ inputRange: [a, m, b], outputRange: [0, 1.12, 1], extrapolate: 'clamp' });
}

function At({
  x,
  y,
  children,
  style,
}: {
  x: number;
  y: number;
  children: ReactNode;
  style?: Animated.WithAnimatedValue<ViewStyle>;
}) {
  return <Animated.View style={[{ position: 'absolute', left: x, top: y }, style]}>{children}</Animated.View>;
}

function Icon({ name, size = 22, color }: { name: IconName; size?: number; color: string }) {
  return <MaterialCommunityIcons name={name} size={size} color={color} />;
}

function Envelope({ color, w = 64, icon }: { color: string; w?: number; icon?: IconName }) {
  const h = Math.round(w * 0.7);
  return (
    <View style={[s.env, { width: w, height: h, borderColor: color }]}>
      <View style={[s.flapL, { width: w * 0.62, borderColor: color, top: -h * 0.06 }]} />
      <View style={[s.flapR, { width: w * 0.62, borderColor: color, top: -h * 0.06 }]} />
      {icon ? (
        <View style={[s.envBadge, { backgroundColor: color }]}>
          <Icon name={icon} size={13} color="#fff" />
        </View>
      ) : null}
    </View>
  );
}

function Line({ w, color }: { w: number; color?: string }) {
  return <View style={[s.line, { width: w, backgroundColor: color ?? colors.border }]} />;
}

function Check({ color = GREEN }: { color?: string }) {
  return (
    <View style={[s.check, { backgroundColor: color }]}>
      <Icon name="check" size={13} color="#fff" />
    </View>
  );
}

/** A fingertip tap: a ring that grows and fades at time a. */
function Tap({ t, a, x, y }: { t: Animated.Value; a: number; x: number; y: number }) {
  const scale = seg(t, a, a + 0.1, 0.4, 1.4, false);
  const opacity = t.interpolate({
    inputRange: [a - 0.001, a, a + 0.1],
    outputRange: [0, 0.55, 0],
    extrapolate: 'clamp',
  });
  return <At x={x - 18} y={y - 18} style={{ opacity, transform: [{ scale }] }}><View style={s.tap} /></At>;
}

// ── 1 · connect ──────────────────────────────────────────────────────────

function ConnectArt({ t }: { t: Animated.Value }) {
  const providers: { icon: IconName; color: string; y: number }[] = [
    { icon: 'gmail', color: '#D64545', y: 22 },
    { icon: 'microsoft-outlook', color: BLUE, y: 98 },
    { icon: 'yahoo', color: PURPLE, y: 174 },
  ];
  const hub = pop(t, 0.62, 0.78);
  return (
    <View style={s.canvas}>
      {providers.map((p, i) => {
        const a = 0.08 + i * 0.12;
        const travel = seg(t, a + 0.08, a + 0.42, 0, 150);
        const rise = seg(t, a + 0.08, a + 0.42, 0, 98 - p.y);
        const fade = t.interpolate({
          inputRange: [a + 0.36, a + 0.44],
          outputRange: [1, 0],
          extrapolate: 'clamp',
        });
        return (
          <View key={p.icon}>
            <At x={8} y={p.y} style={{ transform: [{ scale: pop(t, a - 0.06, a + 0.06) }] }}>
              <View style={[s.provider, { borderColor: p.color }]}>
                <Icon name={p.icon} size={26} color={p.color} />
              </View>
            </At>
            <At x={64} y={p.y + 8} style={{ opacity: fade, transform: [{ translateX: travel }, { translateY: rise }] }}>
              <Envelope color={p.color} w={40} />
            </At>
          </View>
        );
      })}
      <At x={196} y={70} style={{ transform: [{ scale: seg(t, 0.0, 0.1, 0.85, 1) }] }}>
        <View style={s.hub}>
          <Image source={APP_ICON} style={{ width: 82, height: 82 }} />
        </View>
      </At>
      <At x={262} y={60} style={{ transform: [{ scale: hub }] }}>
        <Check />
      </At>
    </View>
  );
}

// ── 2 · action items ─────────────────────────────────────────────────────

function ActionsArt({ t }: { t: Animated.Value }) {
  const envOut = t.interpolate({ inputRange: [0.18, 0.3], outputRange: [1, 0], extrapolate: 'clamp' });
  const envShrink = seg(t, 0.18, 0.3, 1, 0.6);
  const card = pop(t, 0.26, 0.4);
  const rows = ['Sign field-trip slip', 'Pay piano lessons', 'Reply to Coach Dana'];
  return (
    <View style={s.canvas}>
      <At x={102} y={70} style={{ opacity: envOut, transform: [{ scale: envShrink }] }}>
        <Envelope color={ORANGE} w={96} icon="bus-school" />
      </At>
      <At x={40} y={36} style={{ opacity: card, transform: [{ scale: card }] }}>
        <View style={[s.card, { width: 220 }]}>
          <Text style={s.cardTitle}>To do</Text>
          {rows.map((r, i) => {
            const a = 0.46 + i * 0.12;
            return (
              <Animated.View
                key={r}
                style={[s.row, { opacity: seg(t, a - 0.06, a, 0, 1), transform: [{ translateY: seg(t, a - 0.06, a, 8, 0) }] }]}
              >
                <View style={s.boxEmpty} />
                <Animated.View style={{ position: 'absolute', left: 0, top: 6, transform: [{ scale: pop(t, a + 0.06, a + 0.14) }] }}>
                  <Check />
                </Animated.View>
                <Text style={s.rowTxt}>{r}</Text>
              </Animated.View>
            );
          })}
        </View>
      </At>
    </View>
  );
}

// ── 3 · calendar ─────────────────────────────────────────────────────────

const DAYS = ['M', 'T', 'W', 'T', 'F'];

function CalendarGrid({ children }: { children?: ReactNode }) {
  return (
    <View style={[s.card, { width: 216, padding: 10 }]}>
      <View style={s.calHead}>
        {DAYS.map((d, i) => (
          <Text key={i} style={s.calDay}>
            {d}
          </Text>
        ))}
      </View>
      {[0, 1].map((r) => (
        <View key={r} style={s.calRow}>
          {DAYS.map((_, c) => (
            <View key={c} style={s.calCell} />
          ))}
        </View>
      ))}
      {children}
    </View>
  );
}

function CalendarArt({ t }: { t: Animated.Value }) {
  const x = seg(t, 0.12, 0.42, 0, 128);
  const y = t.interpolate({ inputRange: [0.12, 0.27, 0.42], outputRange: [0, -40, 34], extrapolate: 'clamp' });
  const shrink = seg(t, 0.12, 0.42, 1, 0.45);
  const gone = t.interpolate({ inputRange: [0.4, 0.44], outputRange: [1, 0], extrapolate: 'clamp' });
  const chip = pop(t, 0.44, 0.56);
  return (
    <View style={s.canvas}>
      <At x={42} y={78}>
        <CalendarGrid>
          <Animated.View style={[s.calChip, { left: 10 + 3 * 39, top: 74, backgroundColor: GREEN, transform: [{ scale: chip }] }]}>
            <Text style={s.calChipTxt}>5pm</Text>
          </Animated.View>
        </CalendarGrid>
      </At>
      <At x={20} y={20} style={{ opacity: gone, transform: [{ translateX: x }, { translateY: y }, { scale: shrink }] }}>
        <Envelope color={GREEN} w={70} icon="soccer" />
      </At>
      <At x={128} y={200} style={{ opacity: seg(t, 0.56, 0.66, 0, 1) }}>
        <Text style={[s.caption, { color: GREEN }]}>Practice · Thu 5pm</Text>
      </At>
      <Tap t={t} a={0.1} x={55} y={45} />
    </View>
  );
}

// ── 4 · school ───────────────────────────────────────────────────────────

function SchoolArt({ t }: { t: Animated.Value }) {
  const pills = [
    { label: 'Oct 14 · Photos', color: ORANGE },
    { label: 'Oct 22 · Book fair', color: BLUE },
    { label: 'Oct 31 · Parade', color: PURPLE },
  ];
  return (
    <View style={s.canvas}>
      <At x={14} y={16} style={{ transform: [{ scale: seg(t, 0, 0.1, 0.9, 1) }] }}>
        <View style={[s.card, { width: 120, height: 206, padding: 10 }]}>
          <View style={s.newsHead}>
            <Icon name="school" size={18} color={YELLOW} />
            <Text style={s.newsTitle}>Newsletter</Text>
          </View>
          {[90, 70, 96, 60, 84, 92, 66, 80, 74, 88].map((w, i) => {
            const hit = i === 1 || i === 4 || i === 7;
            const glow = hit ? seg(t, 0.12 + i * 0.03, 0.2 + i * 0.03, 0, 1) : null;
            return (
              <View key={i} style={{ marginTop: 7 }}>
                <Line w={w} />
                {glow ? (
                  <Animated.View style={[s.line, { position: 'absolute', width: w, backgroundColor: YELLOW, opacity: glow }]} />
                ) : null}
              </View>
            );
          })}
        </View>
      </At>
      {pills.map((p, i) => {
        const a = 0.34 + i * 0.13;
        return (
          <At
            key={p.label}
            x={142}
            y={42 + i * 54}
            style={{ opacity: seg(t, a, a + 0.08, 0, 1), transform: [{ translateX: seg(t, a, a + 0.14, -70, 0) }] }}
          >
            <View style={[s.pill, { backgroundColor: p.color }]}>
              <Icon name="calendar-check" size={15} color="#fff" />
              <Text style={s.pillTxt}>{p.label}</Text>
            </View>
          </At>
        );
      })}
    </View>
  );
}

// ── 5 · reply ────────────────────────────────────────────────────────────

function ReplyArt({ t }: { t: Animated.Value }) {
  const draft = 'Tuesday 3pm or Thursday 10am both work for me.';
  const width = seg(t, 0.36, 0.7, 0, 196, false);
  return (
    <View style={s.canvas}>
      <At x={12} y={10} style={{ opacity: seg(t, 0.02, 0.12, 0, 1), transform: [{ translateY: seg(t, 0.02, 0.14, 10, 0) }] }}>
        <View style={[s.bubbleIn]}>
          <Text style={s.bubbleFrom}>Priya</Text>
          <Text style={s.bubbleTxt}>Could we meet next week?</Text>
        </View>
      </At>
      <At x={70} y={92} style={{ opacity: seg(t, 0.2, 0.3, 0, 1), transform: [{ scale: pop(t, 0.2, 0.32) }] }}>
        <View style={[s.card, { width: 218, padding: 12 }]}>
          <View style={s.draftHead}>
            <Icon name="auto-fix" size={15} color={PURPLE} />
            <Text style={[s.draftLabel, { color: PURPLE }]}>Draft from Chord</Text>
          </View>
          <Animated.View style={{ width, overflow: 'hidden', height: 40 }}>
            <Text style={[s.bubbleTxt, { width: 196 }]}>{draft}</Text>
          </Animated.View>
          <Animated.View style={[s.sendBtn, { transform: [{ scale: pop(t, 0.72, 0.8) }] }]}>
            <Text style={s.sendTxt}>Send</Text>
            <Icon name="send" size={13} color="#fff" />
          </Animated.View>
        </View>
      </At>
      <Tap t={t} a={0.86} x={250} y={192} />
    </View>
  );
}

// ── 6 · share with partner ───────────────────────────────────────────────

function Phone({ color, children }: { color: string; children?: ReactNode }) {
  return (
    <View style={[s.phone, { borderColor: color }]}>
      <View style={[s.phoneNotch, { backgroundColor: color }]} />
      {children}
    </View>
  );
}

function ShareArt({ t }: { t: Animated.Value }) {
  const x = seg(t, 0.2, 0.6, 0, 162, false);
  const y = t.interpolate({ inputRange: [0.2, 0.4, 0.6], outputRange: [0, -70, 0], extrapolate: 'clamp' });
  const rot = t.interpolate({ inputRange: [0.2, 0.6], outputRange: ['-8deg', '8deg'], extrapolate: 'clamp' });
  return (
    <View style={s.canvas}>
      <At x={14} y={50}>
        <Phone color={ORANGE}>
          <View style={[s.avatar, { backgroundColor: ORANGE }]}>
            <Icon name="account" size={18} color="#fff" />
          </View>
        </Phone>
      </At>
      <At x={196} y={50}>
        <Phone color={BLUE}>
          <View style={[s.avatar, { backgroundColor: BLUE }]}>
            <Icon name="account" size={18} color="#fff" />
          </View>
          <Animated.View style={{ marginTop: 10, transform: [{ scale: pop(t, 0.6, 0.72) }] }}>
            <Envelope color={ORANGE} w={46} />
          </Animated.View>
        </Phone>
      </At>
      <At
        x={30}
        y={110}
        style={{
          opacity: t.interpolate({ inputRange: [0.16, 0.2, 0.58, 0.6], outputRange: [0, 1, 1, 0], extrapolate: 'clamp' }),
          transform: [{ translateX: x }, { translateY: y }, { rotate: rot }],
        }}
      >
        <Envelope color={ORANGE} w={56} icon="share" />
      </At>
      <At x={226} y={30} style={{ transform: [{ scale: pop(t, 0.7, 0.82) }] }}>
        <Icon name="heart" size={26} color="#D64545" />
      </At>
      <Tap t={t} a={0.14} x={56} y={124} />
    </View>
  );
}

// ── 7 · chat ─────────────────────────────────────────────────────────────

function ChatArt({ t }: { t: Animated.Value }) {
  const dots = [0, 1, 2];
  const think = t.interpolate({ inputRange: [0.3, 0.34, 0.5, 0.54], outputRange: [0, 1, 1, 0], extrapolate: 'clamp' });
  return (
    <View style={s.canvas}>
      <At x={66} y={18} style={{ opacity: seg(t, 0.04, 0.14, 0, 1), transform: [{ translateX: seg(t, 0.04, 0.18, 40, 0) }] }}>
        <View style={s.bubbleOut}>
          <Text style={s.bubbleOutTxt}>Move the dentist to Friday at 2</Text>
        </View>
      </At>
      <At x={14} y={90} style={{ opacity: think }}>
        <View style={[s.bubbleIn, { flexDirection: 'row', gap: 5, paddingVertical: 14 }]}>
          {dots.map((d) => (
            <Animated.View
              key={d}
              style={[s.dot, { transform: [{ translateY: seg(t, 0.34 + d * 0.04, 0.4 + d * 0.04, 0, -4) }] }]}
            />
          ))}
        </View>
      </At>
      <At x={14} y={90} style={{ opacity: seg(t, 0.52, 0.6, 0, 1), transform: [{ translateY: seg(t, 0.52, 0.62, 10, 0) }] }}>
        <View style={s.bubbleIn}>
          <Text style={s.bubbleFrom}>Chord</Text>
          <Text style={s.bubbleTxt}>Done. Dentist moved to Fri 2:00pm.</Text>
        </View>
      </At>
      <At x={40} y={196} style={{ transform: [{ scale: pop(t, 0.68, 0.8) }] }}>
        <View style={[s.pill, { backgroundColor: BLUE }]}>
          <Icon name="calendar-clock" size={15} color="#fff" />
          <Text style={s.pillTxt}>Fri 2:00pm · Dentist</Text>
        </View>
      </At>
    </View>
  );
}

// ── 8 · lists ────────────────────────────────────────────────────────────

function ListsArt({ t }: { t: Animated.Value }) {
  const items = ['Milk', 'Eggs', 'Sunscreen', 'Birthday candles'];
  const people = [ORANGE, BLUE, GREEN];
  return (
    <View style={s.canvas}>
      <At x={40} y={10} style={{ transform: [{ scale: seg(t, 0, 0.1, 0.9, 1) }] }}>
        <View style={[s.card, { width: 220 }]}>
          <View style={s.listHead}>
            <Icon name="cart" size={18} color={YELLOW} />
            <Text style={s.cardTitle}>Costco</Text>
            <View style={{ flex: 1 }} />
            {people.map((c, i) => (
              <Animated.View
                key={c}
                style={[s.mini, { backgroundColor: c, marginLeft: i ? -6 : 0, transform: [{ scale: pop(t, 0.06 + i * 0.06, 0.16 + i * 0.06) }] }]}
              />
            ))}
          </View>
          {items.map((it, i) => {
            const a = 0.24 + i * 0.12;
            const done = i < 2;
            return (
              <Animated.View
                key={it}
                style={[s.row, { opacity: seg(t, a, a + 0.06, 0, 1), transform: [{ translateY: seg(t, a, a + 0.08, -14, 0) }] }]}
              >
                <View style={s.boxEmpty} />
                {done ? (
                  <Animated.View style={{ position: 'absolute', left: 0, top: 6, transform: [{ scale: pop(t, 0.78 + i * 0.06, 0.86 + i * 0.06) }] }}>
                    <Check />
                  </Animated.View>
                ) : null}
                <Text style={s.rowTxt}>{it}</Text>
              </Animated.View>
            );
          })}
        </View>
      </At>
    </View>
  );
}

// ── 9 · unsubscribe ──────────────────────────────────────────────────────

function UnsubscribeArt({ t }: { t: Animated.Value }) {
  const lists = [
    { name: 'Deals Daily', color: ORANGE },
    { name: 'Style Weekly', color: PURPLE },
    { name: 'Gadget News', color: BLUE },
  ];
  return (
    <View style={s.canvas}>
      <At x={30} y={6} style={{ transform: [{ scale: seg(t, 0, 0.1, 0.9, 1) }] }}>
        <View style={[s.card, { width: 240 }]}>
          <View style={s.listHead}>
            <Icon name="email-multiple" size={18} color={ORANGE} />
            <Text style={s.cardTitle}>Mailing lists</Text>
            <View style={{ flex: 1 }} />
            <Text style={s.tag}>Never opened</Text>
          </View>
          {lists.map((l, i) => {
            const a = 0.08 + i * 0.08;
            const leave = 0.56 + i * 0.07;
            return (
              <Animated.View
                key={l.name}
                style={[s.row, { opacity: seg(t, a, a + 0.06, 0, 1), transform: [{ translateY: seg(t, a, a + 0.08, 8, 0) }] }]}
              >
                <Animated.View style={{ opacity: seg(t, leave, leave + 0.06, 1, 0) }}>
                  <Icon name="email-newsletter" size={20} color={l.color} />
                </Animated.View>
                <Animated.View style={{ position: 'absolute', left: 0, top: 6, transform: [{ scale: pop(t, leave, leave + 0.08) }] }}>
                  <Check />
                </Animated.View>
                <Animated.Text style={[s.rowTxt, { flex: 1, opacity: seg(t, leave, leave + 0.08, 1, 0.4) }]}>{l.name}</Animated.Text>
                <Animated.Text style={[s.rowMeta, { opacity: seg(t, leave, leave + 0.08, 1, 0.4) }]}>0 of 24</Animated.Text>
              </Animated.View>
            );
          })}
          <Animated.View style={[s.wideBtn, { transform: [{ scale: pop(t, 0.34, 0.44) }] }]}>
            <Icon name="email-off" size={15} color="#fff" />
            <Text style={s.sendTxt}>Unsubscribe from all</Text>
          </Animated.View>
        </View>
      </At>
      <At x={72} y={212} style={{ opacity: seg(t, 0.8, 0.9, 0, 1) }}>
        <Text style={[s.caption, { color: GREEN }]}>Left 3 lists in one tap</Text>
      </At>
      <Tap t={t} a={0.5} x={150} y={186} />
    </View>
  );
}

// ── 10 · trips ───────────────────────────────────────────────────────────

function TripsArt({ t }: { t: Animated.Value }) {
  const rows: { icon: IconName; label: string; color: string; a: number }[] = [
    { icon: 'airplane-takeoff', label: 'BOS → DEN · Thu', color: BLUE, a: 0.36 },
    { icon: 'bed', label: 'Hotel · 4 nights', color: PURPLE, a: 0.66 },
    { icon: 'airplane-landing', label: 'DEN → BOS · Mon', color: BLUE, a: 0.44 },
  ];
  const mails: { icon: IconName; color: string; y: number; a: number }[] = [
    { icon: 'airplane', color: BLUE, y: 34, a: 0.08 },
    { icon: 'bed', color: PURPLE, y: 140, a: 0.38 },
  ];
  return (
    <View style={s.canvas}>
      {mails.map((m) => (
        <At
          key={m.icon}
          x={6}
          y={m.y}
          style={{
            opacity: t.interpolate({ inputRange: [m.a + 0.2, m.a + 0.26], outputRange: [1, 0], extrapolate: 'clamp' }),
            transform: [
              { translateX: seg(t, m.a, m.a + 0.26, 0, 130) },
              { translateY: seg(t, m.a, m.a + 0.26, 0, 70 - m.y) },
              { scale: seg(t, m.a, m.a + 0.26, 1, 0.5) },
            ],
          }}
        >
          <Envelope color={m.color} w={58} icon={m.icon} />
        </At>
      ))}
      <At x={92} y={28} style={{ transform: [{ scale: seg(t, 0, 0.1, 0.9, 1) }] }}>
        <View style={[s.card, { width: 200 }]}>
          <View style={s.listHead}>
            <Icon name="map-marker" size={18} color={ORANGE} />
            <Text style={s.cardTitle}>Denver</Text>
            <View style={{ flex: 1 }} />
            <Text style={s.rowMeta}>Feb 11–15</Text>
          </View>
          {rows.map((r) => (
            <Animated.View
              key={r.label}
              style={[s.row, { opacity: seg(t, r.a, r.a + 0.06, 0, 1), transform: [{ translateX: seg(t, r.a, r.a + 0.1, -16, 0) }] }]}
            >
              <Icon name={r.icon} size={18} color={r.color} />
              <Text style={s.rowTxt}>{r.label}</Text>
            </Animated.View>
          ))}
        </View>
      </At>
      <At x={104} y={198} style={{ transform: [{ scale: pop(t, 0.78, 0.9) }] }}>
        <View style={[s.pill, { backgroundColor: BLUE }]}>
          <Icon name="calendar-check" size={15} color="#fff" />
          <Text style={s.pillTxt}>Thu · Flight to Denver</Text>
        </View>
      </At>
    </View>
  );
}

// ── 11 · saves ───────────────────────────────────────────────────────────

function SavesArt({ t }: { t: Animated.Value }) {
  const items: { icon: IconName; label: string; color: string; date: boolean }[] = [
    { icon: 'silverware-fork-knife', label: 'Lucali · pizza', color: ORANGE, date: true },
    { icon: 'chef-hat', label: 'Lemon pasta', color: GREEN, date: false },
    { icon: 'television', label: 'The Bear, season 3', color: PURPLE, date: true },
    { icon: 'link-variant', label: 'Summer camp list', color: BLUE, date: false },
  ];
  const filter = 0.76;
  return (
    <View style={s.canvas}>
      <At x={30} y={8} style={{ transform: [{ scale: seg(t, 0, 0.1, 0.9, 1) }] }}>
        <View style={[s.card, { width: 240 }]}>
          <View style={s.listHead}>
            <Icon name="bookmark" size={18} color={YELLOW} />
            <Text style={s.cardTitle}>Saves</Text>
          </View>
          <View style={s.chips}>
            <View style={s.chip}>
              <Animated.View style={[StyleFill, s.chipOn, { opacity: seg(t, filter, filter + 0.06, 0, 1) }]} />
              <Text style={s.chipTxt}>Date night</Text>
            </View>
            <View style={s.chip}>
              <Text style={s.chipTxt}>Kids</Text>
            </View>
            <View style={s.chip}>
              <Text style={s.chipTxt}>Recipes</Text>
            </View>
          </View>
          {items.map((it, i) => {
            const a = 0.12 + i * 0.12;
            const dim = it.date ? 1 : seg(t, filter, filter + 0.08, 1, 0.25);
            return (
              <Animated.View
                key={it.label}
                style={[s.row, { opacity: seg(t, a, a + 0.06, 0, 1), transform: [{ scale: pop(t, a, a + 0.1) }] }]}
              >
                <Animated.View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: dim }}>
                  <Icon name={it.icon} size={18} color={it.color} />
                  <Text style={s.rowTxt}>{it.label}</Text>
                </Animated.View>
              </Animated.View>
            );
          })}
        </View>
      </At>
      <Tap t={t} a={filter - 0.02} x={84} y={66} />
    </View>
  );
}

const StyleFill = { position: 'absolute' as const, left: 0, right: 0, top: 0, bottom: 0 };

// ── 12 · and more ────────────────────────────────────────────────────────

function MoreArt({ t }: { t: Animated.Value }) {
  const tiles: { icon: IconName; label: string; color: string }[] = [
    { icon: 'weather-sunny', label: 'Briefing', color: YELLOW },
    { icon: 'cake-variant', label: 'Birthdays', color: ORANGE },
    { icon: 'package-variant-closed', label: 'Packages', color: BLUE },
    { icon: 'receipt-text', label: 'Receipts', color: GREEN },
    { icon: 'whatsapp', label: 'WhatsApp', color: '#25D366' },
    { icon: 'dots-horizontal', label: 'And more', color: PURPLE },
  ];
  return (
    <View style={s.canvas}>
      {tiles.map((tile, i) => {
        const a = 0.06 + i * 0.1;
        return (
          <At key={tile.label} x={12 + (i % 3) * 96} y={18 + Math.floor(i / 3) * 110} style={{ transform: [{ scale: pop(t, a, a + 0.12) }] }}>
            <View style={s.tile}>
              <View style={[s.tileIcon, { backgroundColor: tile.color }]}>
                <Icon name={tile.icon} size={24} color="#fff" />
              </View>
              <Text style={s.tileTxt}>{tile.label}</Text>
            </View>
          </At>
        );
      })}
    </View>
  );
}

const ARTS: Record<string, (p: { t: Animated.Value }) => ReactNode> = {
  connect: ConnectArt,
  actions: ActionsArt,
  calendar: CalendarArt,
  school: SchoolArt,
  unsubscribe: UnsubscribeArt,
  reply: ReplyArt,
  share: ShareArt,
  chat: ChatArt,
  lists: ListsArt,
  trips: TripsArt,
  saves: SavesArt,
  more: MoreArt,
};

export function IntroArt({ slide, active }: { slide: string; active: boolean }) {
  const t = useClock(active);
  const Art = ARTS[slide];
  return (
    <View style={s.frame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Art ? <Art t={t} /> : null}
    </View>
  );
}

const s = themed((colors) => ({
  frame: { width: ART_W, height: ART_H, alignSelf: 'center' as const },
  canvas: { width: ART_W, height: ART_H },
  env: {
    backgroundColor: colors.card,
    borderWidth: 2.5,
    borderRadius: 7,
    overflow: 'hidden' as const,
    alignItems: 'center' as const,
    justifyContent: 'flex-end' as const,
  },
  flapL: { position: 'absolute' as const, left: -2, height: 2.5, borderTopWidth: 2.5, transform: [{ rotate: '33deg' }, { translateX: 6 }] },
  flapR: { position: 'absolute' as const, right: -2, height: 2.5, borderTopWidth: 2.5, transform: [{ rotate: '-33deg' }, { translateX: -6 }] },
  envBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginBottom: 4,
  },
  provider: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: 2,
    backgroundColor: colors.card,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  hub: {
    width: 96,
    height: 96,
    borderRadius: 26,
    backgroundColor: '#FFFFFF',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' as const },
  row: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, paddingVertical: 6, marginTop: 4 },
  rowTxt: { color: colors.text, fontSize: 14 },
  boxEmpty: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.border },
  check: { width: 20, height: 20, borderRadius: 10, alignItems: 'center' as const, justifyContent: 'center' as const },
  line: { height: 6, borderRadius: 3 },
  tap: { width: 36, height: 36, borderRadius: 18, borderWidth: 3, borderColor: colors.text },
  calHead: { flexDirection: 'row' as const, justifyContent: 'space-around' as const, marginBottom: 6 },
  calDay: { color: colors.muted, fontSize: 12, fontWeight: '700' as const, width: 34, textAlign: 'center' as const },
  calRow: { flexDirection: 'row' as const, justifyContent: 'space-around' as const, marginTop: 5 },
  calCell: { width: 34, height: 34, borderRadius: 8, backgroundColor: colors.accentLight },
  calChip: {
    position: 'absolute' as const,
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  calChipTxt: { color: '#fff', fontSize: 11, fontWeight: '700' as const },
  caption: { fontSize: 14, fontWeight: '700' as const },
  newsHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, marginBottom: 4 },
  newsTitle: { color: colors.text, fontSize: 12, fontWeight: '700' as const },
  pill: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    alignSelf: 'flex-start' as const,
  },
  pillTxt: { color: '#fff', fontSize: 13, fontWeight: '700' as const },
  bubbleIn: {
    backgroundColor: colors.leftBubble,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: 240,
  },
  bubbleFrom: { color: colors.muted, fontSize: 11, fontWeight: '700' as const, marginBottom: 2 },
  bubbleTxt: { color: colors.text, fontSize: 14, lineHeight: 19 },
  bubbleOut: {
    backgroundColor: colors.accent,
    borderRadius: 16,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: 230,
  },
  bubbleOutTxt: { color: colors.onAccent, fontSize: 14, lineHeight: 19 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.muted },
  draftHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, marginBottom: 6 },
  draftLabel: { fontSize: 12, fontWeight: '700' as const },
  sendBtn: {
    marginTop: 8,
    alignSelf: 'flex-end' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    backgroundColor: PURPLE,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  sendTxt: { color: '#fff', fontSize: 13, fontWeight: '700' as const },
  phone: {
    width: 90,
    height: 150,
    borderRadius: 18,
    borderWidth: 3,
    backgroundColor: colors.card,
    alignItems: 'center' as const,
    paddingTop: 18,
  },
  phoneNotch: { position: 'absolute' as const, top: 6, width: 28, height: 4, borderRadius: 2 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center' as const, justifyContent: 'center' as const },
  listHead: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, marginBottom: 2 },
  mini: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.card },
  rowMeta: { color: colors.muted, fontSize: 12 },
  tag: { color: ORANGE, fontSize: 11, fontWeight: '700' as const },
  wideBtn: {
    marginTop: 10,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 6,
    backgroundColor: ORANGE,
    borderRadius: 999,
    paddingVertical: 8,
  },
  chips: { flexDirection: 'row' as const, gap: 6, marginTop: 8, marginBottom: 2 },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 10,
    paddingVertical: 4,
    overflow: 'hidden' as const,
  },
  chipOn: { backgroundColor: YELLOW, borderRadius: 999 },
  chipTxt: { color: colors.text, fontSize: 12, fontWeight: '600' as const },
  tile: {
    width: 84,
    height: 96,
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 8,
  },
  tileIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center' as const, justifyContent: 'center' as const },
  tileTxt: { color: colors.text, fontSize: 12, fontWeight: '700' as const },
}));
