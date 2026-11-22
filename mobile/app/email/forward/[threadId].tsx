/**
 * Forward a thread onward (ADR 0112).
 *
 * Its own screen rather than a mode of the reply box: forwarding is addressed
 * to people who are not in the conversation, so it needs a recipient field
 * first and an empty note — the opposite of a reply, which has its recipients
 * already and wants the cursor in the body.
 *
 * The note is optional on purpose. "Here, look at this" is the whole message
 * most of the time, and requiring text to send would be a lie about what
 * forwarding is.
 *
 * Laid out like the other composers (ADR 0222): Cancel and Send in the header,
 * ruled field lines, then the note. Under the note is the email being passed
 * on, exactly as it will be quoted (ADR 0112 addendum): the server builds the
 * preview and the send from one source, so what is shown is what goes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { BackHandler, Pressable, Switch, Text, View } from 'react-native';
import { TextInput } from '@/text-input';
import { useSignatureCaret } from '@/signature-caret';
import {
  bodyWithSignature,
  defaultComposeFormat,
  isOnlySignature,
  type EmailDraft,
  type EmailForwardPreview,
  runExclusive,
} from '@chord/kernel';

import { forwardEmailThread, getEmailForwardPreview } from '@/api';
import { showAlert } from '@/alert';
import {
  EmailAttachments,
  FileDropOverlay,
  readableSize,
  useEmailAttachments,
} from '@/email-attach';
import { EmailBody } from '@/email-body';
import { KeyboardScrollView } from '@/keyboard';
import { DraftExitSheet, composeHeaderOptions, composeStyles as cs } from '@/email-compose-ui';
import { RecipientField } from '@/email-recipient-field';
import { useDraftAutosave } from '@/email-draft';
import { PHONE_DRAFT_NOTICE, outboxNotice, queueEmail, useEmailWaiting } from '@/email-outbox';
import { newSendId } from '@/send-queue';
import { useEmailSignature, useEmailSignatureHtml } from '@/email-signature';
import { ComposeBodyEditor, FormatSwitch, useComposeBody } from '@/compose-body';
import { OutdatedSignatureNote, useSignatureFollow } from '@/outdated-signature';
import { OfflineError } from '@/network';
import { colors, themed } from '@/theme';
import { backHomeHeaderLeft, goBackOr } from '@/back-home';

function parseRecipients(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Only whole addresses go into a draft; a half-typed one would refuse the save. */
function wholeAddresses(s: string): string[] {
  return parseRecipients(s).filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
}

export default function ForwardScreen() {
  // `message` = the message selected in the reader; none = the newest.
  const { threadId, message } = useLocalSearchParams<{ threadId: string; message?: string }>();
  const routeMessage = typeof message === 'string' && message ? message : undefined;
  // A resumed draft names the message it was forwarding; a selection made
  // just now in the reader wins over it.
  const [restoredMessage, setRestoredMessage] = useState<string | undefined>(undefined);
  const messageId = routeMessage ?? restoredMessage;
  const [preview, setPreview] = useState<EmailForwardPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [noteHeight, setNoteHeight] = useState(0);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [note, setNote] = useState('');
  // The signature of the mailbox the forward leaves from (the thread's).
  const signature = useEmailSignature(preview?.accountId ?? null);
  useSignatureFollow(signature, setNote);
  const noteCaret = useSignatureCaret(note, signature);
  const signatureHtml = useEmailSignatureHtml(preview?.accountId ?? null);
  // ADR 0339: the note opens the way the forwarded email was written.
  const noteCompose = useComposeBody(note, setNote, signature, signatureHtml);
  const noteLoad = noteCompose.load;
  const noteInit = noteCompose.init;
  const originalIsHtml = preview ? !!preview.originalIsHtml : null;
  useEffect(() => {
    if (originalIsHtml !== null) {
      noteInit(defaultComposeFormat({ kind: 'forward', original: { bodyHtml: originalIsHtml ? 'html' : null } }));
    }
  }, [originalIsHtml, noteInit]);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const attach = useEmailAttachments();
  const emailWaiting = useEmailWaiting();
  const [sent, setSent] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);

  const restoreAttachments = attach.restore;
  const onRestore = useCallback(
    (d: EmailDraft) => {
      setTo(d.to.join(', '));
      setCc(d.cc.join(', '));
      setNote(d.body);
      noteLoad(d.format, d.body, d.bodyHtml);
      if (d.forwardMessageId) setRestoredMessage(d.forwardMessageId);
      if (d.attachments?.length) restoreAttachments(d.attachments);
    },
    [restoreAttachments, noteLoad],
  );

  const { saveNow, discard, handOff, isSavedOnPhoneOnly } = useDraftAutosave({
    kind: 'forward',
    threadId,
    enabled: !sent,
    content: {
      to: wholeAddresses(to),
      cc: wholeAddresses(cc),
      body: note,
      attachmentIds: attach.ids,
      ...noteCompose.wire,
      // The message the preview shows, so a resumed draft forwards the same one.
      forwardMessageId: preview?.messageId ?? messageId ?? null,
    },
    onRestore,
    signature,
  });

  // The note opens with the signature under it, above the forwarded message
  // (ADR 0260 addendum). Deleting it means none goes. Waits for the preview,
  // which names the mailbox and so which signature.
  const hasPreview = !!preview;
  useEffect(() => {
    if (signature && hasPreview) setNote((cur) => (cur.trim() ? cur : bodyWithSignature('', signature)));
  }, [signature, hasPreview]);

  useEffect(() => {
    if (!threadId) return;
    let live = true;
    setPreviewErr(null);
    getEmailForwardPreview(threadId, messageId)
      .then((p) => live && setPreview(p))
      .catch((e: Error) => live && setPreviewErr(e.message || 'Could not load the email.'));
    return () => {
      live = false;
    };
  }, [threadId, messageId]);

  // A ref, not the busy state: a second tap in the same frame does not see
  // that state yet, and would send the message twice.
  const sendGate = useRef(false);
  const send = useCallback(
    () =>
      runExclusive(sendGate, async () => {
        if (!threadId) return;
        const toList = parseRecipients(to);
        if (toList.length === 0) {
          setErr('Add at least one recipient.');
          return;
        }
        setBusy(true);
        setErr(null);
        let savedId: string | null = null;
        // One id for this Send, used by the direct attempt and by the Outbox if it
        // falls back there, so the server sends it once (ADR 0311 addendum).
        const sendId = newSendId();
        // The message the preview showed, so the two cannot differ.
        const forwarded = preview?.messageId ?? messageId ?? null;
        try {
          savedId = await saveNow();
          // An earlier email still waits in the Outbox: this forward joins the
          // line behind it rather than overtaking it (ADR 0311 addendum).
          if (emailWaiting) throw new OfflineError();
          const res = await forwardEmailThread(threadId, {
            to: toList,
            cc: parseRecipients(cc),
            ...(note.trim() ? { body: note, ...noteCompose.wire } : {}),
            includeAttachments,
            ...(attach.ids.length ? { attachmentIds: attach.ids } : {}),
            ...(forwarded ? { messageId: forwarded } : {}),
            ...(savedId ? { draftId: savedId } : {}),
          }, sendId);
          setSent(true);
          showAlert('Forwarded', `Sent from ${res.fromEmail}.`);
          goBackOr(`/email/${threadId}`);
        } catch (e) {
          // No network (ADR 0311): the forward waits in the Outbox and goes,
          // through this same call, when the server answers again.
          if (e instanceof OfflineError) {
            try {
              await queueEmail({
                kind: 'forward',
                threadId,
                to: toList,
                cc: parseRecipients(cc),
                bcc: [],
                body: note,
                ...noteCompose.wire,
                includeAttachments,
                attachmentIds: attach.ids,
                messageId: forwarded,
                draftId: savedId,
              }, sendId);
              await handOff();
              setSent(true);
              showAlert('In your Outbox', outboxNotice());
              goBackOr(`/email/${threadId}`);
            } catch (qe) {
              setErr((qe as Error).message);
            }
            return;
          }
          // The server refuses a forward it cannot send whole, and the message is
          // written for the sender — show it rather than a generic failure.
          setErr((e as Error).message);
        } finally {
          setBusy(false);
        }
      }),
    [threadId, to, cc, note, includeAttachments, attach.ids, saveNow, preview, messageId, handOff, emailWaiting],
  );

  const written =
    !!to.trim() || !!cc.trim() || !isOnlySignature(note, signature) || attach.ids.length > 0;
  const cancel = useCallback(() => {
    if (sent || !written) goBackOr(`/email/${threadId}`);
    else setExitOpen(true);
  }, [sent, written]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      cancel();
      return true;
    });
    return () => sub.remove();
  }, [cancel]);

  const ccVisible = showCc || !!cc.trim();
  const originalFiles = preview?.attachments ?? [];

  return (
    <View style={styles.root}>
      <KeyboardScrollView style={cs.screen} contentContainerStyle={styles.content}>
        <Stack.Screen
          options={composeHeaderOptions({
            title: 'Forward',
            onCancel: cancel,
            actions: [
              {
                key: 'attach',
                icon: 'paperclip',
                label: 'Attach a file',
                onPress: () => void attach.pick(),
                busy: attach.busy,
              },
            ],
            canSend: !busy && !!to.trim(),
            sending: busy,
            onSend: () => void send(),
          })}
        />

        <RecipientField
          row
          label="To"
          value={to}
          onChangeText={setTo}
          placeholder="name@example.com"
          autoFocus
          trailing={
            !ccVisible ? (
              <Pressable onPress={() => setShowCc(true)} hitSlop={8}>
                <Text style={cs.fldLink}>Cc</Text>
              </Pressable>
            ) : null
          }
        />
        {ccVisible ? <RecipientField row label="Cc" value={cc} onChangeText={setCc} /> : null}

        {originalFiles.length > 0 ? (
          <View style={[cs.fld, styles.switchRow]}>
            <View style={styles.switchLabel}>
              <Text style={styles.switchTitle}>Include the original files</Text>
              <Text style={styles.switchHint}>Off sends the message text only.</Text>
            </View>
            <Switch
              value={includeAttachments}
              onValueChange={setIncludeAttachments}
              trackColor={{ true: colors.accent }}
            />
          </View>
        ) : null}

        {attach.files.length > 0 || attach.err || attach.busy ? (
          <View style={cs.attach}>
            <EmailAttachments
              files={attach.files}
              onPick={() => void attach.pick()}
              onRemove={attach.remove}
              busy={attach.busy}
              err={attach.err}
              hidePick
            />
          </View>
        ) : null}

        {/* Grows with its text rather than scrolling inside itself: the page
            scrolls, so the note and the email under it are one column. */}
        <FormatSwitch value={noteCompose.format} onChange={noteCompose.choose} />
        <OutdatedSignatureNote body={note} signature={signature} onChange={setNote} />
        <ComposeBodyEditor
          compose={noteCompose}
          placeholder="Add a note (optional)"
          plain={
            <TextInput
              ref={noteCaret.ref}
              onFocus={noteCaret.onFocus}
              onBlur={noteCaret.onBlur}
              style={[cs.body, styles.note, { height: Math.max(NOTE_MIN, noteHeight) }]}
              value={note}
              onChangeText={setNote}
              onContentSizeChange={(e) => {
                // Rounded and compared, or the box's own resize reports a new size
                // and the two chase each other.
                const h = Math.ceil(e.nativeEvent.contentSize.height);
                setNoteHeight((prev) => (Math.abs(prev - h) < 2 ? prev : h));
              }}
              scrollEnabled={false}
              multiline
              textAlignVertical="top"
              placeholder="Add a note (optional)"
              placeholderTextColor={colors.muted}
            />
          }
        />

        {err ? <Text style={cs.err}>{err}</Text> : null}

        <View style={styles.original} accessibilityLabel="The email being forwarded">
          {preview ? (
            <>
              {preview.header.map((line, i) => (
                <Text key={i} style={i === 0 ? styles.marker : styles.headerLine} selectable>
                  {line}
                </Text>
              ))}
              <View style={styles.originalBody}>
                {/* Shown as the text that is sent: no images, no links, the
                    quoted history unfolded (it all goes). */}
                <EmailBody html={null} text={preview.body} collapseQuoted={false} plainOnly />
              </View>
              {originalFiles.length > 0 ? (
                <View style={styles.files}>
                  {originalFiles.map((f) => (
                    <Text
                      key={f.id}
                      style={[styles.file, !includeAttachments && styles.fileOff]}
                      numberOfLines={1}
                    >
                      {`📎 ${f.filename} · ${readableSize(f.size)}`}
                    </Text>
                  ))}
                  <Text style={styles.switchHint}>
                    {includeAttachments
                      ? 'These files go with the forward.'
                      : 'These files will not be sent.'}
                  </Text>
                </View>
              ) : null}
            </>
          ) : (
            <Text style={styles.switchHint}>
              {previewErr ? `Couldn't show the email: ${previewErr}` : 'Loading the email…'}
            </Text>
          )}
        </View>

        <DraftExitSheet
          open={exitOpen}
          onClose={() => setExitOpen(false)}
          onSave={() => {
            void saveNow().finally(() => {
              if (isSavedOnPhoneOnly()) showAlert('Saved on this phone', PHONE_DRAFT_NOTICE);
              goBackOr(`/email/${threadId}`);
            });
          }}
          onDelete={() => {
            void discard().finally(() => goBackOr(`/email/${threadId}`));
          }}
        />
      </KeyboardScrollView>
      <FileDropOverlay visible={attach.dragging} />
    </View>
  );
}

const NOTE_MIN = 120;

const styles = themed((colors) => ({
  root: { flex: 1 },
  content: { flexGrow: 1, paddingBottom: 24 },
  note: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  original: {
    marginHorizontal: 16,
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  marker: { color: colors.muted, fontSize: 13, marginBottom: 4 },
  headerLine: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  originalBody: { marginTop: 10 },
  files: { marginTop: 10, gap: 4 },
  file: { color: colors.text, fontSize: 14 },
  fileOff: { color: colors.muted, textDecorationLine: 'line-through' },
  switchRow: { justifyContent: 'space-between', paddingVertical: 6 },
  switchLabel: { flex: 1 },
  switchTitle: { color: colors.text, fontSize: 15 },
  switchHint: { color: colors.muted, fontSize: 12, marginTop: 1 },
}));
