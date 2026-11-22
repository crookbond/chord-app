/**
 * The email reader's floating bar and the sheets its buttons open.
 *
 * The reader used to spend its top on a row of text buttons and its bottom on
 * an always-open reply box, which left a strip in the middle for the email.
 * Three icons floating over the mail give that space back; everything else is
 * one tap behind them.
 */
import type { ComponentProps } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, themed } from '@/theme';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export function Icon({
  name,
  size = 22,
  color = colors.accent,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return <MaterialCommunityIcons name={name} size={size} color={color} />;
}

export function ReaderBar({
  onTrash,
  onMore,
  onReply,
  disabled,
}: {
  onTrash: () => void;
  onMore: () => void;
  onReply: () => void;
  disabled?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[styles.barWrap, { bottom: Math.max(insets.bottom, 12) + 4 }]}
      pointerEvents="box-none"
    >
      <View style={[styles.bar, disabled && styles.barDisabled]}>
        <Pressable
          style={styles.barBtn}
          onPress={onTrash}
          disabled={disabled}
          hitSlop={6}
          accessibilityLabel="Move to Trash"
        >
          <Icon name="trash-can-outline" size={24} />
        </Pressable>
        <Pressable
          style={styles.barBtn}
          onPress={onMore}
          disabled={disabled}
          hitSlop={6}
          accessibilityLabel="More actions"
        >
          <Icon name="dots-horizontal" size={24} />
        </Pressable>
        <Pressable
          style={styles.barBtn}
          onPress={onReply}
          disabled={disabled}
          hitSlop={6}
          accessibilityLabel="Reply, reply all, forward or suggested reply"
        >
          <Icon name="reply" size={26} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The same pill over a list with rows ticked. Trash sits where it does in the
 * reader; the count and the way out take the place of reply, which a pile of
 * mail has no use for.
 */
export function SelectionBar({
  count,
  onTrash,
  onArchive,
  onMore,
  onCancel,
}: {
  count: number;
  onTrash: () => void;
  onArchive: () => void;
  onMore: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={[styles.barWrap, { bottom: 12 }]} pointerEvents="box-none">
      <View style={styles.bar}>
        <Pressable
          style={styles.barBtn}
          onPress={onTrash}
          hitSlop={6}
          accessibilityLabel="Move to Trash"
        >
          <Icon name="trash-can-outline" size={24} />
        </Pressable>
        <Pressable
          style={styles.barBtn}
          onPress={onArchive}
          hitSlop={6}
          accessibilityLabel="Archive"
        >
          <Icon name="archive-arrow-down-outline" size={24} />
        </Pressable>
        <Pressable
          style={styles.barBtn}
          onPress={onMore}
          hitSlop={6}
          accessibilityLabel="More actions"
        >
          <Icon name="dots-horizontal" size={24} />
        </Pressable>
        <View style={styles.barDivider} />
        <Text style={styles.barCount} accessibilityLabel={`${count} selected`}>
          {count}
        </Text>
        <Pressable
          style={styles.barBtn}
          onPress={onCancel}
          hitSlop={6}
          accessibilityLabel="Clear selection"
        >
          <Icon name="close" size={24} color={colors.muted} />
        </Pressable>
      </View>
    </View>
  );
}

export interface SheetRow {
  key: string;
  icon: IconName;
  label: string;
  hint?: string;
  onPress: () => void;
}

/** A short list of actions rising from the bar. Picking one closes it. */
export function ActionSheet({
  open,
  rows,
  onClose,
}: {
  open: boolean;
  rows: SheetRow[];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { marginBottom: Math.max(insets.bottom, 12) + 64 }]}
          onPress={(e) => e.stopPropagation()}
        >
          {rows.map((r, i) => (
            <Pressable
              key={r.key}
              style={[styles.row, i === rows.length - 1 && styles.rowLast]}
              onPress={() => {
                onClose();
                r.onPress();
              }}
            >
              <Icon name={r.icon} />
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>{r.label}</Text>
                {r.hint ? <Text style={styles.rowHint}>{r.hint}</Text> : null}
              </View>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = themed((colors) => ({
  barWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 26,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  barDisabled: { opacity: 0.5 },
  barBtn: { minWidth: 32, alignItems: 'center' },
  barDivider: { width: 1, alignSelf: 'stretch', backgroundColor: colors.border },
  barCount: { color: colors.text, fontWeight: '600', fontSize: 15, marginRight: -12 },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  sheet: {
    width: '92%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: 14,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  rowText: { flex: 1 },
  rowLabel: { color: colors.text, fontSize: 15 },
  rowHint: { color: colors.muted, fontSize: 12, marginTop: 1 },
}));
