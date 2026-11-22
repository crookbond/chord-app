/**
 * ADR 0273 — a date field that can be typed into OR picked from a calendar.
 *
 * Pure JS (no native date-picker module) so it ships over the air and looks
 * the same on iOS, Android and web. The value is the `YYYY-MM-DD` string the
 * fields already stored; `allowUnknownYear` adds a "Year unknown" switch that
 * writes `0000-MM-DD` (People birthdays, ADR 0016).
 */
import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { TextInput } from '@/text-input';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {
  MONTH_NAMES,
  WEEKDAY_INITIALS,
  addMonths,
  formatYmd,
  monthGrid,
  parseYmd,
  pickerYears,
  sameYmd,
  todayYmd,
  type Ymd,
} from '@chord/kernel';

import { colors, themed } from '@/theme';

export function DateField({
  value,
  onChange,
  placeholder = 'YYYY-MM-DD',
  allowUnknownYear = false,
  style,
  inputStyle,
  onSubmitEditing,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  allowUnknownYear?: boolean;
  style?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  onSubmitEditing?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.row, style]}>
      <TextInput
        style={[styles.input, inputStyle]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="done"
      />
      <Pressable
        style={styles.iconBtn}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Pick a date from the calendar"
        hitSlop={6}
      >
        <MaterialCommunityIcons name="calendar-month-outline" size={22} color={colors.text} />
      </Pressable>
      <CalendarPicker
        visible={open}
        value={value}
        allowUnknownYear={allowUnknownYear}
        onCancel={() => setOpen(false)}
        onPick={(v) => {
          setOpen(false);
          onChange(v);
        }}
      />
    </View>
  );
}

/** The calendar sheet on its own, for callers that do not want a text box. */
export function CalendarPicker({
  visible,
  value,
  allowUnknownYear = false,
  onPick,
  onCancel,
  onClear,
}: {
  visible: boolean;
  value: string | null;
  allowUnknownYear?: boolean;
  onPick: (v: string) => void;
  onCancel: () => void;
  onClear?: () => void;
}) {
  if (!visible) return null;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <CalendarBody
            value={value}
            allowUnknownYear={allowUnknownYear}
            onPick={onPick}
            onCancel={onCancel}
            onClear={onClear}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function CalendarBody({
  value,
  allowUnknownYear,
  onPick,
  onCancel,
  onClear,
}: {
  value: string | null;
  allowUnknownYear: boolean;
  onPick: (v: string) => void;
  onCancel: () => void;
  onClear?: () => void;
}) {
  const today = todayYmd();
  const parsed = parseYmd(value, { allowUnknownYear });
  const [noYear, setNoYear] = useState(allowUnknownYear && parsed?.y === 0);
  const selected: Ymd | null = parsed ? { ...parsed, y: parsed.y === 0 ? today.y : parsed.y } : null;
  const [view, setView] = useState(() => ({ y: selected?.y ?? today.y, m: selected?.m ?? today.m }));
  const [yearList, setYearList] = useState(false);
  const weeks = useMemo(() => monthGrid(view.y, view.m), [view.y, view.m]);
  const years = useMemo(() => pickerYears(), []);

  const pick = (d: Ymd) => onPick(formatYmd({ ...d, y: noYear ? 0 : d.y }));
  const step = (delta: number) => setView((v) => addMonths(v.y, v.m, delta));

  return (
    <View>
      <View style={styles.header}>
        <Pressable onPress={() => step(-1)} hitSlop={8} accessibilityLabel="Previous month" style={styles.navBtn}>
          <MaterialCommunityIcons name="chevron-left" size={26} color={colors.text} />
        </Pressable>
        <Pressable
          onPress={() => !noYear && setYearList((s) => !s)}
          accessibilityLabel="Choose a year"
          style={styles.titleBtn}
        >
          <Text style={styles.title}>
            {MONTH_NAMES[view.m - 1]}
            {noYear ? '' : ` ${view.y}`}
          </Text>
          {!noYear && (
            <MaterialCommunityIcons name={yearList ? 'menu-up' : 'menu-down'} size={20} color={colors.text} />
          )}
        </Pressable>
        <Pressable onPress={() => step(1)} hitSlop={8} accessibilityLabel="Next month" style={styles.navBtn}>
          <MaterialCommunityIcons name="chevron-right" size={26} color={colors.text} />
        </Pressable>
      </View>

      {yearList ? (
        <ScrollView style={styles.yearList} contentContainerStyle={styles.yearWrap}>
          {years.map((y) => (
            <Pressable
              key={y}
              style={[styles.yearBtn, y === view.y && styles.daySelected]}
              onPress={() => {
                setView((v) => ({ y, m: v.m }));
                setYearList(false);
              }}
            >
              <Text style={[styles.yearTxt, y === view.y && styles.dayTxtSelected]}>{y}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View>
          <View style={styles.week}>
            {WEEKDAY_INITIALS.map((w, i) => (
              <Text key={i} style={styles.weekday}>
                {w}
              </Text>
            ))}
          </View>
          {weeks.map((week, wi) => (
            <View key={wi} style={styles.week}>
              {week.map((d) => {
                const isSel = sameYmd(d, selected);
                const isToday = sameYmd(d, today);
                return (
                  <Pressable
                    key={`${d.y}-${d.m}-${d.d}`}
                    style={[styles.day, isSel && styles.daySelected, !isSel && isToday && styles.dayToday]}
                    onPress={() => pick(d)}
                    accessibilityLabel={`${MONTH_NAMES[d.m - 1]} ${d.d}${noYear ? '' : `, ${d.y}`}`}
                  >
                    <Text
                      style={[styles.dayTxt, !d.inMonth && styles.dayTxtOut, isSel && styles.dayTxtSelected]}
                    >
                      {d.d}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      )}

      {allowUnknownYear && (
        <View style={styles.noYearRow}>
          <Text style={styles.footTxt}>Year unknown</Text>
          <Switch
            value={noYear}
            onValueChange={(v) => {
              setNoYear(v);
              setYearList(false);
            }}
          />
        </View>
      )}

      <View style={styles.footer}>
        <Pressable onPress={() => pick(today)} style={styles.footBtn}>
          <Text style={styles.footTxt}>Today</Text>
        </Pressable>
        {onClear && (
          <Pressable onPress={onClear} style={styles.footBtn}>
            <Text style={[styles.footTxt, { color: colors.red }]}>Clear</Text>
          </Pressable>
        )}
        <View style={{ flex: 1 }} />
        <Pressable onPress={onCancel} style={styles.footBtn}>
          <Text style={styles.footTxt}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const CELL = 40;

const styles = themed((colors) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.card,
  },
  iconBtn: {
    padding: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.card,
  },
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
    width: CELL * 7 + 28,
    maxWidth: '100%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  navBtn: { padding: 4 },
  titleBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  weekday: { width: CELL, textAlign: 'center', fontSize: 12, color: colors.muted, paddingVertical: 4 },
  day: { width: CELL, height: CELL, alignItems: 'center', justifyContent: 'center', borderRadius: CELL / 2 },
  dayToday: { borderWidth: 1, borderColor: colors.text },
  daySelected: { backgroundColor: colors.accent },
  dayTxt: { fontSize: 15, color: colors.text },
  dayTxtOut: { color: colors.muted },
  dayTxtSelected: { color: colors.onAccent, fontWeight: '600' },
  yearList: { maxHeight: CELL * 6 + 24 },
  yearWrap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  yearBtn: { width: '23%', paddingVertical: 10, alignItems: 'center', borderRadius: 8, marginBottom: 4 },
  yearTxt: { fontSize: 15, color: colors.text },
  noYearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  footer: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  footBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  footTxt: { fontSize: 15, color: colors.text, fontWeight: '500' },
}));
