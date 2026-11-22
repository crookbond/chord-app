/**
 * ADR 0297 — a time is picked on wheels (hour, minute, AM/PM), as on an
 * iPhone, never typed. Pure JS like `DateField` (ADR 0273), so it ships over
 * the air and is the same on iOS, Android and web. No keyboard opens, so
 * nothing is hidden behind one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {
  HOURS_12,
  MINUTES,
  formatTimeOfDay,
  fromWheel,
  timeZoneChoices,
  timeZoneLabel,
  toWheel,
  type TimeOfDay,
} from '@chord/kernel';

import { KeyboardModalBody } from '@/keyboard';
import { TextInput } from '@/text-input';
import { colors, themed } from '@/theme';

const ROW = 40;
const VISIBLE = 5; // odd: the middle row is the chosen one
const PAD = ROW * ((VISIBLE - 1) / 2);

/** A button showing the time; tapping it opens the wheels. */
export function TimeField({
  value,
  onChange,
  placeholder = 'Set time',
  clearable = false,
  style,
  accessibilityLabel,
}: {
  value: TimeOfDay | null;
  onChange: (v: TimeOfDay | null) => void;
  placeholder?: string;
  /** Offer "None" (an optional end time). */
  clearable?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.field, style]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? 'Pick a time'}
      >
        <Text style={value ? styles.fieldTxt : styles.fieldPlaceholder}>
          {value ? formatTimeOfDay(value.hour, value.minute) : placeholder}
        </Text>
        <MaterialCommunityIcons name="clock-outline" size={18} color={colors.muted} />
      </Pressable>
      {open && (
        <TimeWheelSheet
          initial={value ?? { hour: 9, minute: 0 }}
          clearable={clearable}
          onCancel={() => setOpen(false)}
          onClear={() => {
            setOpen(false);
            onChange(null);
          }}
          onDone={(t) => {
            setOpen(false);
            onChange(t);
          }}
        />
      )}
    </>
  );
}

function TimeWheelSheet({
  initial,
  clearable,
  onCancel,
  onClear,
  onDone,
}: {
  initial: TimeOfDay;
  clearable: boolean;
  onCancel: () => void;
  onClear: () => void;
  onDone: (t: TimeOfDay) => void;
}) {
  const start = toWheel(initial);
  const [hour12, setHour12] = useState(start.hour12);
  const [minute, setMinute] = useState(start.minute);
  const [pm, setPm] = useState(start.pm);
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.preview}>
            {formatTimeOfDay(fromWheel(hour12, minute, pm).hour, minute)}
          </Text>
          <View style={styles.wheels}>
            <View pointerEvents="none" style={styles.band} />
            <Wheel
              items={HOURS_12}
              value={hour12}
              label={(h) => String(h)}
              onChange={setHour12}
              width={64}
              name="Hour"
            />
            <Text style={styles.colon}>:</Text>
            <Wheel
              items={MINUTES}
              value={minute}
              label={(m) => String(m).padStart(2, '0')}
              onChange={setMinute}
              width={64}
              name="Minute"
            />
            <Wheel
              items={[false, true]}
              value={pm}
              label={(p) => (p ? 'PM' : 'AM')}
              onChange={setPm}
              width={64}
              name="AM or PM"
            />
          </View>
          <View style={styles.footer}>
            {clearable && (
              <Pressable onPress={onClear} style={styles.footBtn}>
                <Text style={[styles.footTxt, { color: colors.red }]}>None</Text>
              </Pressable>
            )}
            <View style={{ flex: 1 }} />
            <Pressable onPress={onCancel} style={styles.footBtn}>
              <Text style={styles.footTxt}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => onDone(fromWheel(hour12, minute, pm))} style={styles.footBtn}>
              <Text style={[styles.footTxt, styles.doneTxt]}>Done</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** One scrolling column that settles on a row; tapping a row picks it too. */
function Wheel<T>({
  items,
  value,
  label,
  onChange,
  width,
  name,
}: {
  items: T[];
  value: T;
  label: (v: T) => string;
  onChange: (v: T) => void;
  width: number;
  name: string;
}) {
  const ref = useRef<ScrollView>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const index = Math.max(0, items.indexOf(value));

  useEffect(() => {
    // Wait a frame: the sheet has to be laid out before it can scroll.
    const t = setTimeout(() => ref.current?.scrollTo({ y: index * ROW, animated: false }), 0);
    return () => clearTimeout(t);
    // Only on open; afterwards the wheel's own position is the truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
  }, []);

  const pickAt = (y: number) => {
    const i = Math.min(items.length - 1, Math.max(0, Math.round(y / ROW)));
    if (items[i] !== value) onChange(items[i]!);
    return i;
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    pickAt(y);
    // The web has no momentum-end event and no snapping of its own: snap
    // once scrolling has been still for a moment.
    if (Platform.OS === 'web') {
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(() => {
        const i = pickAt(y);
        ref.current?.scrollTo({ y: i * ROW, animated: true });
      }, 120);
    }
  };

  return (
    <ScrollView
      ref={ref}
      style={{ height: ROW * VISIBLE, width }}
      contentContainerStyle={{ paddingVertical: PAD }}
      showsVerticalScrollIndicator={false}
      snapToInterval={ROW}
      decelerationRate="fast"
      scrollEventThrottle={16}
      onScroll={onScroll}
      onMomentumScrollEnd={(e) => pickAt(e.nativeEvent.contentOffset.y)}
      accessibilityLabel={name}
      nestedScrollEnabled
    >
      {items.map((it, i) => {
        const sel = i === index;
        return (
          <Pressable
            key={label(it)}
            style={styles.row}
            onPress={() => {
              onChange(it);
              ref.current?.scrollTo({ y: i * ROW, animated: true });
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: sel }}
            accessibilityLabel={`${name} ${label(it)}`}
          >
            <Text style={[styles.rowTxt, sel && styles.rowTxtSel]}>{label(it)}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A button naming the time zone; tapping it opens a searchable list. */
export function TimeZoneField({
  value,
  onChange,
  deviceZone,
  at,
  style,
}: {
  value: string;
  onChange: (zone: string) => void;
  deviceZone: string | null;
  /** The instant the offsets are shown for (they change with daylight saving). */
  at: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const choices = useMemo(() => timeZoneChoices([value, deviceZone]), [value, deviceZone]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return choices;
    return choices.filter((z) => z.toLowerCase().replace(/_/g, ' ').includes(needle));
  }, [choices, q]);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.field, style]}
        accessibilityRole="button"
        accessibilityLabel="Pick a time zone"
      >
        <Text style={styles.fieldTxt} numberOfLines={1}>
          {timeZoneLabel(value, at)}
        </Text>
        <MaterialCommunityIcons name="earth" size={18} color={colors.muted} />
      </Pressable>
      <Modal transparent animationType="fade" visible={open} onRequestClose={() => setOpen(false)}>
        <KeyboardModalBody>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={[styles.sheet, styles.zoneSheet]} onPress={() => {}}>
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search city"
              placeholderTextColor={colors.muted}
              autoCorrect={false}
              style={styles.search}
            />
            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              {shown.map((z) => (
                <Pressable
                  key={z}
                  style={styles.zoneRow}
                  onPress={() => {
                    setOpen(false);
                    setQ('');
                    onChange(z);
                  }}
                >
                  <View style={styles.zoneCheck}>
                    {z === value && <MaterialCommunityIcons name="check" size={18} color={colors.text} />}
                  </View>
                  <Text style={styles.footTxt}>{timeZoneLabel(z, at)}</Text>
                  {z === deviceZone && <Text style={styles.zoneHint}>this device</Text>}
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
        </KeyboardModalBody>
      </Modal>
    </>
  );
}

const styles = themed((colors) => ({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: colors.card,
  },
  fieldTxt: { fontSize: 15, color: colors.text, flexShrink: 1 },
  fieldPlaceholder: { fontSize: 15, color: colors.muted },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  sheet: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
    width: 280,
    maxWidth: '100%',
  },
  zoneSheet: { width: 340 },
  preview: { fontSize: 18, fontWeight: '600', color: colors.text, textAlign: 'center', marginBottom: 6 },
  wheels: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', position: 'relative' },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: PAD,
    height: ROW,
    borderRadius: 8,
    backgroundColor: colors.bg2,
  },
  colon: { fontSize: 20, color: colors.text, fontWeight: '600' },
  row: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  rowTxt: { fontSize: 18, color: colors.muted },
  rowTxtSel: { color: colors.text, fontWeight: '600', fontSize: 20 },
  footer: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  footBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  footTxt: { fontSize: 15, color: colors.text, fontWeight: '500' },
  doneTxt: { color: colors.accent, fontWeight: '700' },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: colors.text,
    marginBottom: 8,
  },
  zoneRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 6 },
  zoneCheck: { width: 22, alignItems: 'center' },
  zoneHint: { fontSize: 12, color: colors.muted, marginLeft: 'auto' },
}));
