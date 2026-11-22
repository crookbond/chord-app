/**
 * ADR 0083 - Email-tab long-press folder sheet. Junk is one live-peek row.
 *
 * Sent and Archive read the mirror through a folder predicate (ADR 0108).
 * Drafts lists Chord's own unsent mail (ADR 0113) — its footer says so, because
 * a draft begun in Gmail stays in Gmail. Trash stays a stub for a reason, not
 * for lack of time: trashed rows are reaped by the backfill's reverse-delete,
 * so the folder would be right one day and empty the next. Filing is the
 * provider's job either way (ADR 0107) — every thread carries a link there.
 *
 * Labels (ADR 0125 + 0141): provider labels from the mirror, plus Chord
 * labels that live only here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import type { EmailLabelSummary } from '@chord/kernel';

import { listEmailLabels } from '@/api';
import { useEmailOutbox, usePhoneDrafts } from '@/email-outbox';
import { useAndroidBottomInset } from '@/system-bars';
import { themed } from '@/theme';

export type EmailFolderAction =
  | 'inbox'
  | 'sent'
  | 'archive'
  | 'snoozed'
  | 'drafts'
  | 'junk'
  /** The mailing lists the user is on, each with Unsubscribe. */
  | 'lists'
  /** ADR 0309 — filing rules (mail from X goes to folder Z). */
  | 'filters'
  /** ADR 0311 — mail sent with no network, waiting on this phone. */
  | 'outbox'
  | 'close'
  /** ADR 0125 - browse one label. */
  | { label: EmailLabelSummary };

export function EmailFolderSheet({
  open,
  onAction,
}: {
  open: boolean;
  onAction: (a: EmailFolderAction) => void;
}) {
  const bottomInset = useAndroidBottomInset();
  const waiting = useEmailOutbox().length + usePhoneDrafts().length;
  const [showLabels, setShowLabels] = useState(false);
  const [labels, setLabels] = useState<EmailLabelSummary[] | null>(null);

  // Fetched when asked for, not when the sheet opens: most opens are someone
  // going to Sent.
  const openLabels = useCallback(() => {
    setShowLabels(true);
    if (labels === null) void listEmailLabels().then(setLabels).catch(() => setLabels([]));
  }, [labels]);

  // Every open starts at the folder list.
  useEffect(() => {
    if (!open) setShowLabels(false);
  }, [open]);

  const { provider, chord } = useMemo(() => {
    const all = labels ?? [];
    return {
      provider: all.filter((l) => l.scope !== 'chord'),
      chord: all.filter((l) => l.scope === 'chord'),
    };
  }, [labels]);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => onAction('close')}>
      <Pressable style={styles.scrim} onPress={() => onAction('close')}>
        <Pressable
          style={[styles.sheet, { paddingBottom: 18 + bottomInset }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.grab} />
          {showLabels ? (
            <>
              <Pressable style={styles.row} onPress={() => setShowLabels(false)}>
                <Text style={styles.back}>&lsaquo;  Folders</Text>
              </Pressable>
              {labels === null ? (
                <Text style={styles.note}>Loading&#8230;</Text>
              ) : labels.length === 0 ? (
                // Honest rather than absent: Outlook and IMAP mirror no user
                // labels, and nobody has typed a Chord label yet.
                <Text style={styles.note}>
                  No labels yet. Apply a Chord label on a thread, or file mail in
                  Gmail.
                </Text>
              ) : (
                <ScrollView style={styles.labelScroll}>
                  {chord.length > 0 ? (
                    <>
                      <Text style={styles.section}>Chord labels</Text>
                      <Text style={styles.honesty}>
                        Live in Chord. Your mail app shows them only if you turned
                        on tagging in Settings.
                      </Text>
                      {chord.map((l) => (
                        <FolderRow
                          key={`c:${l.id}`}
                          label={`${l.name}  ·  ${l.threads}`}
                          onPress={() => onAction({ label: l })}
                        />
                      ))}
                    </>
                  ) : null}
                  {provider.length > 0 ? (
                    <>
                      <Text style={styles.section}>In your mail</Text>
                      {provider.map((l) => (
                        <FolderRow
                          key={`p:${l.id}`}
                          label={`${l.name}  ·  ${l.threads}`}
                          onPress={() => onAction({ label: l })}
                        />
                      ))}
                    </>
                  ) : null}
                </ScrollView>
              )}
            </>
          ) : (
            <>
              <FolderRow label="Inbox" onPress={() => onAction('inbox')} />
              <FolderRow label="Sent" onPress={() => onAction('sent')} />
              <FolderRow label="Drafts" onPress={() => onAction('drafts')} />
              <FolderRow
                label={waiting > 0 ? `Outbox (${waiting})` : 'Outbox'}
                onPress={() => onAction('outbox')}
                chevron
              />
              <FolderRow label="Archive" onPress={() => onAction('archive')} />
              <FolderRow label="Snoozed" onPress={() => onAction('snoozed')} />
              <FolderRow label="Junk" onPress={() => onAction('junk')} />
              <FolderRow label="Mailing lists" onPress={() => onAction('lists')} chevron />
              <FolderRow label="Filters" onPress={() => onAction('filters')} chevron />
              <FolderRow label="Trash" disabled />
              <FolderRow label="Labels" onPress={openLabels} chevron />
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function FolderRow({
  label,
  onPress,
  disabled,
  chevron,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  chevron?: boolean;
}) {
  return (
    <Pressable
      style={[styles.row, disabled && styles.rowDisabled]}
      disabled={disabled || !onPress}
      onPress={onPress}
    >
      <Text style={[styles.label, disabled && styles.labelDisabled]}>{label}</Text>
      {chevron ? <Text style={styles.chev}>›</Text> : null}
    </Pressable>
  );
}

const styles = themed((colors) => ({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(26,26,24,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 13,
    paddingBottom: 18,
    paddingTop: 8,
  },
  grab: {
    width: 34,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowDisabled: { opacity: 0.45 },
  label: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '500' },
  labelDisabled: { fontWeight: '400' },
  back: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  note: { color: colors.muted, fontSize: 13, padding: 16 },
  section: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    paddingTop: 14,
    paddingBottom: 4,
  },
  honesty: { color: colors.muted, fontSize: 12, paddingBottom: 6, lineHeight: 16 },
  labelScroll: { maxHeight: 320 },
  chev: { color: colors.muted, fontSize: 18 },
}));
