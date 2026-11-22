/**
 * Who an email is from and who it went to (ADR 0294).
 *
 * Tapping the sender's name opens `SenderSheet`: the real address, what the
 * mail server confirmed, whether the user has heard from them before, and
 * Chord's sender checks. Tapping the To line opens `RecipientsSheet`.
 * `SenderWarning` is the line above the body when a check found something.
 *
 * Nothing here ever says an email is safe: with no findings it says Chord
 * found nothing unusual, which is all a check can know.
 */
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import {
  addressOf,
  hostToUnicode,
  linkHostsFromHtml,
  replyToWarning,
  type EmailMessage,
  type SenderCheck,
  type SenderSignal,
} from '@chord/kernel';

import { colors, themed } from '@/theme';

function levelColors(level: SenderCheck['level']): { fg: string; bg: string } {
  if (level === 'danger') return { fg: colors.red, bg: colors.redBg };
  if (level === 'caution') return { fg: colors.warn, bg: colors.warnBg };
  return { fg: colors.muted, bg: colors.bg };
}

/** The first finding worth a line above the body, or null. */
function headline(check: SenderCheck | undefined): SenderSignal | null {
  if (!check || (check.level !== 'danger' && check.level !== 'caution')) return null;
  return check.signals.find((s) => s.level === check.level) ?? null;
}

export function SenderWarning({ msg, onPress }: { msg: EmailMessage; onPress: () => void }) {
  const top = headline(msg.senderCheck);
  if (!top) return null;
  const c = levelColors(msg.senderCheck!.level);
  // On a likely fake the Reply-To is where an answer would be collected, so it
  // gets its own line even when another finding is the headline.
  const reply = replyToWarning(msg.senderCheck);
  const replyLine = reply?.level === 'danger' && top.code !== 'reply_to_elsewhere' ? reply : null;
  return (
    <>
      <Pressable style={[styles.warn, { backgroundColor: c.bg }]} onPress={onPress}>
        <Text style={[styles.warnTxt, { color: c.fg }]}>
          {msg.senderCheck!.level === 'danger' ? '⚠️ Be careful. ' : '⚠️ '}
          {top.message}
        </Text>
        <Text style={[styles.warnMore, { color: c.fg }]}>Details</Text>
      </Pressable>
      {replyLine ? (
        <Pressable style={[styles.warn, styles.warnStrong, { backgroundColor: c.bg }]} onPress={onPress}>
          <Text style={[styles.warnTxt, { color: c.fg }]}>⛔ {replyLine.message}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

/**
 * Above the body of a suspect email: why it is shown as plain text, where its
 * links would have gone, and the way back to the original.
 */
export function PlainModeNotice({
  html,
  showingOriginal,
  onToggle,
  imagesLoaded,
  onLoadImages,
}: {
  html: string | null;
  showingOriginal: boolean;
  onToggle: () => void;
  imagesLoaded: boolean;
  /** Shows the original with its images, for this message only. */
  onLoadImages: () => void;
}) {
  const hosts = linkHostsFromHtml(html).map((h) => hostToUnicode(h));
  const shown = hosts.slice(0, 4);
  return (
    <View style={styles.plainNote}>
      <Text style={styles.plainNoteTxt}>
        {!showingOriginal
          ? 'Shown as plain text, with images and links turned off, because this may not be from who it says.'
          : imagesLoaded
            ? 'Showing the original with its images. Its links are live, and loading images tells the sender this address is read.'
            : 'Showing the original. Images stay off, and its links are live.'}
      </Text>
      {!showingOriginal && shown.length > 0 ? (
        <Text style={styles.plainNoteTxt}>
          Its links go to {shown.join(', ')}
          {hosts.length > shown.length ? ` and ${hosts.length - shown.length} more` : ''}.
        </Text>
      ) : null}
      <View style={styles.plainNoteActions}>
        <Pressable onPress={onToggle} hitSlop={6}>
          <Text style={styles.copy}>{showingOriginal ? 'Back to plain text' : 'Show original without images'}</Text>
        </Pressable>
        {imagesLoaded && showingOriginal ? null : (
          <Pressable onPress={onLoadImages} hitSlop={6}>
            <Text style={styles.copy}>{showingOriginal ? 'Load images' : 'Show original with images'}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** A small mark beside the sender's name when a check found something. */
export function senderMark(check: SenderCheck | undefined): { text: string; color: string } | null {
  if (!check || (check.level !== 'danger' && check.level !== 'caution')) return null;
  return { text: '⚠', color: levelColors(check.level).fg };
}

function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.box} onPress={(e) => e.stopPropagation()}>
          <View style={styles.head}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={{ gap: 10 }}>
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      hitSlop={6}
      onPress={() => {
        void Clipboard.setStringAsync(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Text style={styles.copy}>{copied ? 'Copied' : label}</Text>
    </Pressable>
  );
}

function historyLine(check: SenderCheck): string | null {
  const h = check.history;
  if (!h) return null;
  const parts = [
    h.received === 0
      ? 'First email from this address'
      : `${h.received} earlier email${h.received === 1 ? '' : 's'} from this address`,
    h.wrote > 0 ? 'you have written to them' : "you haven't written to them",
  ];
  if (h.inPeople) parts.push('saved in your People');
  return parts.join(' · ');
}

export function SenderSheet({
  open,
  onClose,
  msg,
}: {
  open: boolean;
  onClose: () => void;
  msg: EmailMessage;
}) {
  const check = msg.senderCheck;
  const address = msg.fromEmail ?? '';
  const findings = check?.signals.filter((s) => s.level !== 'info') ?? [];
  const c = levelColors(check?.level ?? 'none');
  const history = check ? historyLine(check) : null;
  return (
    <Sheet open={open} onClose={onClose} title={msg.fromName || address || 'Sender'}>
      <View style={styles.row}>
        <Text style={styles.address} selectable>
          {address || 'No address'}
        </Text>
        {address ? <CopyButton value={address} /> : null}
      </View>
      {check?.domain ? <Text style={styles.meta}>Sent from {check.domain}</Text> : null}
      {msg.replyTo && msg.replyTo.toLowerCase() !== address.toLowerCase() ? (
        <View style={styles.row}>
          <Text style={styles.meta} selectable>
            Replies go to {msg.replyTo}
          </Text>
          <CopyButton value={msg.replyTo} />
        </View>
      ) : null}

      {check ? (
        <View style={[styles.verdict, { backgroundColor: c.bg }]}>
          {findings.length > 0 ? (
            <>
              <Text style={[styles.verdictHead, { color: c.fg }]}>
                {check.level === 'danger' ? 'This may not be who it says it is' : 'Worth a second look'}
              </Text>
              {findings.map((s) => (
                <Text key={s.code} style={[styles.finding, { color: c.fg }]}>
                  • {s.message}
                </Text>
              ))}
              {check.level === 'danger' ? (
                <Text style={[styles.finding, { color: c.fg }]}>
                  Don't use its links or reply with personal details. If you're unsure, go to the
                  company's site or app yourself.
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.finding}>Chord found nothing unusual about this sender.</Text>
          )}
        </View>
      ) : null}

      {check ? (
        <Text style={styles.meta}>
          {check.verifiedDomain
            ? `Your mail provider confirmed it was sent by ${check.domain}.`
            : check.authChecked
              ? `Your mail provider could not confirm it was sent by ${check.domain ?? 'this address'}.`
              : 'No mail-server check is available for this email.'}
        </Text>
      ) : null}
      {history ? <Text style={styles.meta}>{history}</Text> : null}
    </Sheet>
  );
}

function RecipientRows({ label, list, own }: { label: string; list: string[]; own: Set<string> }) {
  if (list.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.section}>{label}</Text>
      {list.map((raw) => {
        const addr = addressOf(raw);
        return (
          <View key={raw} style={styles.row}>
            <Text style={styles.recipient} selectable numberOfLines={2}>
              {raw}
              {own.has(addr) ? '  (you)' : ''}
            </Text>
            <CopyButton value={addr} />
          </View>
        );
      })}
    </View>
  );
}

export function RecipientsSheet({
  open,
  onClose,
  msg,
  mailboxEmail,
}: {
  open: boolean;
  onClose: () => void;
  msg: EmailMessage;
  mailboxEmail: string | null;
}) {
  const own = new Set(mailboxEmail ? [mailboxEmail.toLowerCase()] : []);
  const notYou = msg.senderCheck?.signals.find((s) => s.code === 'not_addressed_to_you');
  const total = msg.toEmails.length + msg.ccEmails.length;
  return (
    <Sheet open={open} onClose={onClose} title={`${total} recipient${total === 1 ? '' : 's'}`}>
      <RecipientRows label="To" list={msg.toEmails} own={own} />
      <RecipientRows label="Cc" list={msg.ccEmails} own={own} />
      {notYou ? <Text style={styles.meta}>{notYou.message} You may have been Bcc'd.</Text> : null}
      {total > 1 ? (
        <CopyButton value={[...msg.toEmails, ...msg.ccEmails].map(addressOf).join(', ')} label="Copy all" />
      ) : null}
    </Sheet>
  );
}

const styles = themed((colors) => ({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  box: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '80%',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  body: { flexGrow: 0 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '700' },
  done: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  address: { flex: 1, color: colors.text, fontSize: 14 },
  recipient: { flex: 1, color: colors.text, fontSize: 14 },
  meta: { flex: 1, color: colors.muted, fontSize: 13, lineHeight: 18 },
  copy: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  section: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  verdict: { borderRadius: 10, padding: 10, gap: 6 },
  verdictHead: { fontSize: 14, fontWeight: '700' },
  finding: { color: colors.text, fontSize: 13, lineHeight: 18 },
  warn: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginVertical: 4,
  },
  warnStrong: { borderWidth: 1, borderColor: colors.red },
  warnTxt: { flex: 1, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  warnMore: { fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  plainNote: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
    gap: 4,
    marginBottom: 6,
  },
  plainNoteActions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6 },
  plainNoteTxt: { color: colors.muted, fontSize: 12, lineHeight: 17 },
}));
