/**
 * A recipient field that suggests as you type (ADR 0114).
 *
 * Suggestions are fetched for the token being edited, not the whole field —
 * "ruth@example.com, ch" should offer Ms Chen, not search for the entire
 * string. That is the only real complexity here, and it is why this is a
 * component rather than a prop on a TextInput.
 *
 * The list is dismissed on pick, on blur, and whenever the token stops
 * matching, because a dropdown covering the message you are writing is worse
 * than no dropdown.
 *
 * On a phone, this phone's contacts are matched on the device and added after
 * the mail-derived rows (ADR 0114 addendum); nothing from the address book is
 * sent. Web has no address book and shows the mail-derived rows only.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { TextInput } from '@/text-input';
import { mergeRecipientSuggestions, type EmailRecipientSuggestion } from '@chord/kernel';

import { suggestEmailRecipients } from '@/api';
import { prepareDeviceContacts, suggestFromDeviceContacts } from '@/device-contacts';
import { colors, themed } from '@/theme';

const DEBOUNCE_MS = 200;

/** The token the cursor is in: everything after the last separator. */
function activeToken(value: string): string {
  const parts = value.split(/[,;]/);
  return (parts[parts.length - 1] ?? '').trim();
}

/** Replace that trailing token with the chosen address, ready for the next. */
function withPicked(value: string, email: string): string {
  const parts = value.split(/[,;]/);
  parts[parts.length - 1] = ` ${email}`;
  return `${parts.join(',').trim()}, `;
}

export function RecipientField({
  label,
  value,
  onChangeText,
  placeholder,
  autoFocus,
  row,
  trailing,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** One ruled line, label beside the input: the full-screen composers. */
  row?: boolean;
  /** Sits at the end of that line (the Cc/Bcc link). */
  trailing?: ReactNode;
}) {
  const [suggestions, setSuggestions] = useState<EmailRecipientSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  // Guards against an older request landing after a newer one and repopulating
  // a list the user has already moved past.
  const seq = useRef(0);

  const token = activeToken(value);

  useEffect(() => {
    if (token.length < 2) {
      setSuggestions([]);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      // Either source failing leaves the other: a field that still works
      // without suggestions beats an error message under a half-typed address.
      void Promise.all([
        suggestEmailRecipients(token).catch(() => [] as EmailRecipientSuggestion[]),
        suggestFromDeviceContacts(token).catch(() => [] as EmailRecipientSuggestion[]),
      ]).then(([server, device]) => {
        if (seq.current !== mine) return;
        const rows = mergeRecipientSuggestions(server, device);
        setSuggestions(rows);
        setOpen(rows.length > 0);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [token]);

  const pick = useCallback(
    (s: EmailRecipientSuggestion) => {
      onChangeText(withPicked(value, s.email));
      setSuggestions([]);
      setOpen(false);
    },
    [value, onChangeText],
  );

  const input = (
    <TextInput
      style={row ? styles.rowInput : styles.input}
      value={value}
      onChangeText={onChangeText}
      onBlur={() => setOpen(false)}
      onFocus={() => {
        prepareDeviceContacts();
        setOpen(suggestions.length > 0);
      }}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="email-address"
      autoFocus={autoFocus}
    />
  );

  return (
    <View>
      {row ? (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>{label}:</Text>
          {input}
          {trailing}
        </View>
      ) : (
        <>
          <Text style={styles.label}>{label}</Text>
          {input}
        </>
      )}
      {open ? (
        <View style={[styles.menu, row && styles.rowMenu]}>
          {suggestions.map((s) => (
            <Pressable
              key={s.email}
              style={styles.item}
              // onPressIn, not onPress: blur fires first on a tap and would
              // close the menu before the press landed.
              onPressIn={() => pick(s)}
            >
              <View style={styles.itemTop}>
                <Text style={[styles.itemName, styles.itemNameFlex]} numberOfLines={1}>
                  {s.name ?? s.email}
                </Text>
                {s.source === 'contacts' ? <Text style={styles.itemTag}>Contacts</Text> : null}
              </View>
              {s.name ? (
                <Text style={styles.itemEmail} numberOfLines={1}>
                  {s.email}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = themed((colors) => ({
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 8 },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    minHeight: 42,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowLabel: { color: colors.muted, fontSize: 15 },
  rowInput: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 8 },
  rowMenu: { marginHorizontal: 12, marginBottom: 4 },
  menu: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  item: { paddingHorizontal: 10, paddingVertical: 8 },
  itemName: { color: colors.text, fontSize: 14 },
  itemTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  itemNameFlex: { flexShrink: 1 },
  itemTag: { color: colors.muted, fontSize: 11 },
  itemEmail: { color: colors.muted, fontSize: 12 },
}));
