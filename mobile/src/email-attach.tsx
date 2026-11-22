/**
 * Attaching files to an outgoing message (ADR 0111). Shared by the composer
 * and the reply box, because the picking-uploading-listing dance is the same
 * in both and two copies would drift.
 *
 * A picked file is uploaded into the user's PERSONAL group before it is
 * attached. That is deliberate rather than incidental: the wire carries
 * attachment ids, so the file has to exist in Chord first — and once it does,
 * it is a file the user has, searchable and re-sendable, instead of a byte
 * stream that existed only for the length of one send. It is also where ADR
 * 0071 already puts files that arrive by email, so mail in and mail out share
 * a shelf.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';

import { listGroups, uploadFile } from '@/api';
import { colors, themed } from '@/theme';

export interface PendingFile {
  id: string;
  filename: string;
  size: number;
}

export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

interface UploadAsset {
  uri: string;
  name: string;
  mimeType?: string;
  file?: File;
}

/**
 * Files dragged from the desktop onto the page (web only). Listens on the
 * whole window because the composer fills the screen, and only for drags
 * that carry files, so dragging text into the body still works as usual.
 */
function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled || typeof window === 'undefined') return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Without this the browser opens the file instead of dropping it.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      reset();
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (dropped.length) onFilesRef.current(dropped);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
      reset();
    };
  }, [enabled]);

  return dragging;
}

export function useEmailAttachments({ dropEnabled = true }: { dropEnabled?: boolean } = {}) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upload = useCallback(async (assets: UploadAsset[]) => {
    setBusy(true);
    try {
      const groups = await listGroups();
      const personal = groups.find((g) => g.kind === 'personal');
      if (!personal) {
        setErr('No personal space to keep the file in.');
        return;
      }
      const uploaded: PendingFile[] = [];
      for (const asset of assets) {
        const att = await uploadFile(personal.id, asset);
        uploaded.push({ id: att.id, filename: att.filename, size: att.size });
      }
      setFiles((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const pick = useCallback(async () => {
    setErr(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (picked.canceled || !picked.assets?.length) return;
      await upload(
        picked.assets.map((a) => ({ uri: a.uri, name: a.name, mimeType: a.mimeType, file: a.file })),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [upload]);

  const dragging = useFileDrop(dropEnabled, (dropped) => {
    setErr(null);
    void upload(
      dropped.map((f) => ({ uri: '', name: f.name, mimeType: f.type || undefined, file: f })),
    );
  });

  const remove = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clear = useCallback(() => setFiles([]), []);

  /** The files a resumed draft already carries. */
  const restore = useCallback((saved: PendingFile[]) => setFiles(saved), []);

  return { files, ids: files.map((f) => f.id), pick, remove, clear, restore, busy, err, dragging };
}

/** Shown over the composer while files are being dragged onto it (web). */
export function FileDropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <View style={styles.drop} pointerEvents="none">
      <Text style={styles.dropTxt}>Drop files to attach</Text>
    </View>
  );
}

export function EmailAttachments({
  files,
  onPick,
  onRemove,
  busy,
  err,
  hidePick,
}: {
  files: PendingFile[];
  onPick: () => void;
  onRemove: (id: string) => void;
  busy?: boolean;
  err?: string | null;
  /** The screen has its own attach button (the reply composer's header). */
  hidePick?: boolean;
}) {
  return (
    <View style={styles.wrap}>
      {hidePick ? null : (
        <View style={styles.row}>
          <Pressable onPress={onPick} hitSlop={6} disabled={busy}>
            <Text style={[styles.add, busy && { opacity: 0.5 }]}>
              {busy ? 'Adding…' : '📎 Attach a file'}
            </Text>
          </Pressable>
          {busy ? <ActivityIndicator size="small" color={colors.accent} /> : null}
        </View>
      )}
      {files.map((f) => (
        <View key={f.id} style={styles.chip}>
          <Text style={styles.chipTxt} numberOfLines={1}>
            {f.filename}
          </Text>
          <Text style={styles.size}>{readableSize(f.size)}</Text>
          <Pressable onPress={() => onRemove(f.id)} hitSlop={8}>
            <Text style={styles.remove}>×</Text>
          </Pressable>
        </View>
      ))}
      {err ? <Text style={styles.err}>{err}</Text> : null}
    </View>
  );
}

const styles = themed((colors) => ({
  wrap: { gap: 6, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  add: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipTxt: { flex: 1, color: colors.text, fontSize: 13 },
  size: { color: colors.muted, fontSize: 11 },
  remove: { color: colors.muted, fontSize: 18, lineHeight: 18 },
  err: { color: colors.red, fontSize: 12 },
  drop: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    bottom: 8,
    zIndex: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.accent,
    borderRadius: 12,
    backgroundColor: colors.card,
    opacity: 0.92,
  },
  dropTxt: { color: colors.accent, fontSize: 16, fontWeight: '600' },
}));
