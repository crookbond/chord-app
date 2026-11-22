/**
 * A file opened inside Chord, full screen, with X (close) and Share (ADR 0310).
 * Share is the share sheet the file used to go straight to, so saving it or
 * opening it in another app stays one tap away. On web the button is Download.
 *
 * Which files come here, and how each is drawn, is `fileViewerPlan` in kernel:
 * - `native`: iOS's web view draws the local file itself (PDF, Word, Excel,
 *   PowerPoint, Pages/Numbers/Keynote, RTF, images, audio, video), with
 *   script off. On web the browser shows the `blob:` the caller made from an
 *   authenticated fetch (`showInViewerOnWeb` in api.ts), relabelled with a
 *   type it shows inertly; it is revoked when the viewer closes.
 * - anything else: a page of Chord's own (`file-render-page.ts`) with the file
 *   written into it - pdf.js on Android, docx-preview, SheetJS, text, image -
 *   in a web view on a phone, in a sandboxed iframe on web. Only the pinned
 *   library is fetched; the file never leaves the device.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { WebView } from 'react-native-webview';

import {
  RENDER_PAGE_MAX_BYTES,
  fileRenderPage,
  fileViewerPlan,
  isDeletableViewerFile,
  viewerNavigation,
  viewerMimeType,
  type FileFormat,
  type FileRenderer,
  type ViewerFile,
} from '@chord/kernel';

import { colors, themed } from '@/theme';
import { viewerFiles } from '@/viewer-files';

const TOO_LARGE = 'This file is too large to show here.';
const GONE = 'This file is no longer open. Close and tap it again.';

/** A fresh nonce for one render page's script policy. */
function pageNonce(): string {
  const bytes = Crypto.getRandomBytes(18);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

/** A link handed out of a viewer page opens in the browser, never in it. */
function openOutside(url: string): void {
  if (viewerNavigation(url, []) !== 'external') return;
  if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer');
  else void Linking.openURL(url).catch(() => {});
}

const RENDER_BASE_URL = 'https://localhost/';

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(raw);
}

export default function FileViewer() {
  // The route carries only an id the app registered (`@/viewer-files`),
  // never a file address: a link from outside must not choose what is
  // framed, read or deleted here.
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [file] = useState<ViewerFile | null>(() => viewerFiles.get(id));
  const uri = file?.uri;
  const name = file?.name;
  const mime = file?.mime;
  const plan = fileViewerPlan(mime ?? '', name ?? '', Platform.OS);
  const format: FileFormat | undefined = plan?.format;
  const renderer: FileRenderer | undefined = plan?.renderer;
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const failed = useCallback((why: string) => {
    setLoading(false);
    setErr(why || 'The file could not be shown.');
  }, []);

  // Chord's own page: read the bytes on the device and write them into it.
  useEffect(() => {
    if (!uri || !renderer || renderer === 'native') return;
    let live = true;
    (async () => {
      let base64: string;
      if (Platform.OS === 'web') {
        const blob = await (await fetch(uri)).blob();
        if (blob.size > RENDER_PAGE_MAX_BYTES) throw new Error(TOO_LARGE);
        base64 = await blobToBase64(blob);
      } else {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && 'size' in info && (info.size ?? 0) > RENDER_PAGE_MAX_BYTES) throw new Error(TOO_LARGE);
        base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      }
      const html = fileRenderPage(renderer, base64, format ? (viewerMimeType(format, name) ?? '') : '', pageNonce());
      if (live && html) setPage(html);
    })().catch((e: Error) => {
      if (!live) return;
      // A reload of /file-viewer keeps the blob: address but not the blob.
      failed(Platform.OS === 'web' && e.message !== TOO_LARGE ? GONE : e.message);
    });
    return () => {
      live = false;
    };
  }, [uri, renderer, format, name, failed]);

  // The browser draws it: check the blob is still there (see above).
  useEffect(() => {
    if (Platform.OS !== 'web' || !uri || renderer !== 'native') return;
    let live = true;
    fetch(uri)
      .then(() => {
        if (live) setLoading(false);
      })
      .catch(() => {
        if (live) failed(GONE);
      });
    return () => {
      live = false;
    };
  }, [uri, renderer, failed]);

  // Messages from Chord's page in the sandboxed iframe (web).
  useEffect(() => {
    if (Platform.OS !== 'web' || !page) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const m = (e.data as { chordViewer?: unknown } | null)?.chordViewer;
      if (typeof m !== 'string') return;
      if (m === 'loaded') setLoading(false);
      else if (m.startsWith('error:')) failed(m.slice(6));
      else if (m.startsWith('open:')) openOutside(m.slice(5));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [page, failed]);

  // The file was downloaded for this view alone (every open fetches it
  // again), so it goes when the view does. Only a file this viewer was
  // handed, and only one directly in our own cache.
  useEffect(() => {
    return () => {
      const done = viewerFiles.release(id);
      if (!done?.owned) return;
      if (Platform.OS === 'web') {
        if (done.uri.startsWith('blob:')) URL.revokeObjectURL(done.uri);
        return;
      }
      if (isDeletableViewerFile(done.uri, FileSystem.cacheDirectory)) {
        void FileSystem.deleteAsync(done.uri, { idempotent: true }).catch(() => {});
      }
    };
  }, [id]);

  const share = useCallback(async () => {
    if (!uri) return;
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = uri;
      a.download = name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    try {
      await Sharing.shareAsync(uri, {
        mimeType: mime || undefined,
        UTI: format === 'pdf' ? 'com.adobe.pdf' : undefined,
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [uri, name, mime, format]);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/email');
  }, []);

  const onBridge = useCallback(
    (m: string) => {
      if (m === 'loaded') setLoading(false);
      else if (m.startsWith('error:')) failed(m.slice(6));
      else if (m.startsWith('open:')) openOutside(m.slice(5));
    },
    [failed],
  );

  let body = null;
  if (!file) {
    body = <Text style={styles.err}>{GONE}</Text>;
  } else if (!uri || !renderer) {
    body = <Text style={styles.err}>No file to show.</Text>;
  } else if (err) {
    body = null;
  } else if (renderer === 'native' && Platform.OS === 'web') {
    // Only the blob the app made from its own authenticated fetch.
    body = uri.startsWith('blob:') ? (
      <iframe src={uri} title={name || 'File'} style={webFrameStyle} />
    ) : (
      <Text style={styles.err}>{GONE}</Text>
    );
  } else if (renderer === 'native') {
    body = (
      <WebView
        source={{ uri }}
        originWhitelist={['file://*']}
        // Only the file itself loads here; a link in it opens in the browser.
        onShouldStartLoadWithRequest={(req) => {
          const what = viewerNavigation(req.url, [uri]);
          if (what === 'external') openOutside(req.url);
          return what === 'allow';
        }}
        allowingReadAccessToURL={FileSystem.cacheDirectory ?? undefined}
        allowFileAccess
        // A document drawn by the platform needs no script; a PDF keeps the
        // web view as it shipped before ADR 0310.
        javaScriptEnabled={format === 'pdf'}
        allowsInlineMediaPlayback
        onLoadEnd={() => setLoading(false)}
        onError={(e) => failed(e.nativeEvent.description)}
        style={styles.web}
      />
    );
  } else if (page && Platform.OS === 'web') {
    body = (
      <iframe
        ref={frameRef}
        srcDoc={page}
        // No allow-same-origin: the page runs in an origin of its own and can
        // reach neither Chord's storage nor its session.
        sandbox="allow-scripts"
        title={name || 'File'}
        style={webFrameStyle}
      />
    );
  } else if (page) {
    body = (
      <WebView
        source={{ html: page, baseUrl: RENDER_BASE_URL }}
        originWhitelist={['*']}
        // Chord's page never navigates; a link in the file opens outside.
        onShouldStartLoadWithRequest={(req) => {
          const what = viewerNavigation(req.url, [RENDER_BASE_URL]);
          if (what === 'external') openOutside(req.url);
          return what === 'allow';
        }}
        onMessage={(e) => onBridge(e.nativeEvent.data)}
        onError={(e) => failed(e.nativeEvent.description)}
        style={styles.web}
      />
    );
  }

  return (
    <View style={styles.page}>
      <Stack.Screen
        options={{
          title: name || 'File',
          presentation: 'fullScreenModal',
          headerLeft: () => (
            <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
              <MaterialCommunityIcons name="close" size={24} color={colors.text} />
            </Pressable>
          ),
          headerRight: () => (
            <Pressable onPress={() => void share()} hitSlop={10} accessibilityRole="button">
              <Text style={styles.headerBtn}>{Platform.OS === 'web' ? 'Download' : 'Share'}</Text>
            </Pressable>
          ),
        }}
      />
      {body}
      {loading && uri && renderer && !err ? (
        <ActivityIndicator style={styles.spinner} color={colors.muted} />
      ) : null}
      {err ? (
        <Text style={styles.err}>
          {err}
          {Platform.OS === 'web' ? ' Tap Download to save it.' : ' Tap Share to open it in another app.'}
        </Text>
      ) : null}
    </View>
  );
}

const webFrameStyle = { flex: 1, width: '100%', height: '100%', border: 'none', background: '#fff' } as const;

const styles = themed((colors) => ({
  page: { flex: 1, backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: colors.bg },
  headerBtn: { color: colors.text, fontSize: 16, fontWeight: '600' as const, paddingHorizontal: 4 },
  spinner: { position: 'absolute' as const, top: 24, alignSelf: 'center' as const },
  err: { color: colors.red, fontSize: 14, padding: 16 },
}));
