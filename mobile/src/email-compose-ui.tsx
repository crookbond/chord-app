/**
 * The parts every composer shares (reply, new message, forward): Cancel and
 * Send in the header, ruled field lines, a body that takes the remaining
 * height, the ask bar, and the Save / Delete choice on the way out.
 *
 * One module because three screens drawing the same thing three ways is how
 * the New message screen ended up with Send at the bottom after the reply
 * composer had moved it to the top.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';

import { ActionSheet, Icon, type IconName, type SheetRow } from '@/email-reader-bar';
import { colors, themed } from '@/theme';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

export interface HeaderAction {
  key: string;
  icon: IconName;
  label: string;
  onPress: () => void;
  busy?: boolean;
  active?: boolean;
}

/** `Stack.Screen` options for a composer: Cancel left, icons and Send right. */
export function composeHeaderOptions(opts: {
  title: string;
  onCancel: () => void;
  actions?: HeaderAction[];
  canSend: boolean;
  sending?: boolean;
  onSend: () => void;
}) {
  return {
    title: opts.title,
    headerBackVisible: false,
    headerLeft: () => (
      <Pressable onPress={opts.onCancel} hitSlop={8} accessibilityLabel="Cancel">
        <Text style={composeStyles.cancelTxt}>Cancel</Text>
      </Pressable>
    ),
    headerRight: () => (
      <View style={composeStyles.headerRight}>
        {(opts.actions ?? []).map((a) => (
          <Pressable
            key={a.key}
            style={[composeStyles.headerIcon, a.active && composeStyles.headerIconActive]}
            onPress={a.onPress}
            disabled={a.busy}
            hitSlop={8}
            accessibilityLabel={a.label}
          >
            {a.busy ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Icon name={a.icon} />
            )}
          </Pressable>
        ))}
        <Pressable
          style={[composeStyles.sendCircle, !opts.canSend && composeStyles.disabled]}
          disabled={!opts.canSend}
          onPress={opts.onSend}
          accessibilityLabel="Send"
        >
          {opts.sending ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <Icon name="arrow-up" size={20} color={colors.onAccent} />
          )}
        </Pressable>
      </View>
    ),
  };
}

/** One ruled line: a muted label, then whatever the field is. */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={composeStyles.fld}>
      <Text style={composeStyles.fldLabel}>{label}:</Text>
      {children}
    </View>
  );
}

export interface AskChip {
  label: string;
  ask: string;
}

/**
 * ADR 0197 — ask Chord to write or change the message. Visibly not part of
 * it: dashed, tinted, labelled, and sitting under the body in every composer.
 */
export function AskBar({
  hasDraft,
  chips,
  value,
  onChangeText,
  onAsk,
  busy,
  err,
  placeholder,
}: {
  hasDraft: boolean;
  chips: AskChip[];
  value: string;
  onChangeText: (v: string) => void;
  onAsk: (instruction: string) => void;
  busy: boolean;
  err: string | null;
  placeholder: string;
}) {
  return (
    <View style={composeStyles.aiBlock}>
      <Text style={composeStyles.aiLabel}>
        {hasDraft ? 'Ask Chord to change it' : 'Ask Chord to write it'} · this part is never sent
      </Text>
      {!busy && chips.length > 0 ? (
        <ScrollView {...DISMISS_KEYBOARD_ON_DRAG}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={composeStyles.aiChips}
        >
          {chips.map((q) => (
            <Pressable key={q.label} style={composeStyles.aiChip} onPress={() => onAsk(q.ask)}>
              <Text style={composeStyles.aiChipTxt}>{q.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={composeStyles.aiRow}>
        <TextInput
          style={composeStyles.aiInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          editable={!busy}
          blurOnSubmit
          onSubmitEditing={() => onAsk(value)}
          returnKeyType="send"
        />
        <Pressable
          style={[composeStyles.aiBtn, (!value.trim() || busy) && composeStyles.disabled]}
          disabled={!value.trim() || busy}
          onPress={() => onAsk(value)}
        >
          <Text style={composeStyles.aiBtnTxt}>Write</Text>
        </Pressable>
      </View>
      {err ? <Text style={composeStyles.aiErr}>{err}</Text> : null}
    </View>
  );
}

/** "Chord is writing…" above the body while an ask is out. */
export function AskWriting() {
  return (
    <View style={composeStyles.aiWriting}>
      <ActivityIndicator size="small" color={colors.accent} />
      <Text style={composeStyles.aiWritingTxt}>Chord is writing…</Text>
    </View>
  );
}

/**
 * What Cancel asks once something has been written. Tapping away from it
 * goes back to writing.
 */
export function DraftExitSheet({
  open,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const rows: SheetRow[] = [
    {
      key: 'save',
      icon: 'content-save-outline',
      label: 'Save draft',
      hint: 'Find it later under Drafts',
      onPress: onSave,
    },
    { key: 'delete', icon: 'trash-can-outline', label: 'Delete draft', onPress: onDelete },
  ];
  return <ActionSheet open={open} rows={rows} onClose={onClose} />;
}

export const composeStyles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.card },
  cancelTxt: {
    color: colors.accent,
    fontSize: 16,
    // The web header gives its side slots no inset of their own.
    marginLeft: Platform.OS === 'web' ? 16 : 0,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: Platform.OS === 'web' ? 12 : 0,
  },
  headerIcon: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  headerIconActive: { backgroundColor: colors.accentLight },
  sendCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.4 },
  fld: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    minHeight: 42,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  fldLabel: { color: colors.muted, fontSize: 15 },
  fldInput: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 8 },
  fldStatic: { flex: 1, color: colors.text, fontSize: 15 },
  fldLink: { color: colors.muted, fontSize: 13 },
  fldPress: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 42 },
  attach: { paddingHorizontal: 16, paddingBottom: 6 },
  err: { color: colors.red, fontSize: 13, paddingHorizontal: 16, paddingBottom: 6 },
  // Takes whatever the fields above and the keyboard below leave, and scrolls
  // inside itself - so the line being typed is always on screen.
  body: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    // The browser's focus ring would frame the whole page-sized box.
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  aiWriting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  aiWritingTxt: { color: colors.muted, fontSize: 13 },
  aiBlock: {
    marginHorizontal: 10,
    marginBottom: 8,
    padding: 8,
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  aiLabel: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  aiRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  aiInput: {
    flex: 1,
    minHeight: 34,
    color: colors.text,
    backgroundColor: colors.bg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
  },
  aiBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: 12,
    paddingVertical: 7,
    minWidth: 60,
    alignItems: 'center',
  },
  aiBtnTxt: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  aiChips: { flexDirection: 'row', gap: 6 },
  aiChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  aiChipTxt: { color: colors.text, fontSize: 12 },
  aiErr: { color: colors.red, fontSize: 12 },
}));
