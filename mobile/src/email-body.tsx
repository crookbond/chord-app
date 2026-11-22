/**
 * Sanitized HTML email body renderer. Prefers bodyHtml when present; plain
 * Text when only bodyText. The same sanitized document, under the same
 * policy, is drawn in a WebView on a phone and in a sandboxed iframe with an
 * opaque origin on web - never in the app's own page.
 */
import * as Crypto from 'expo-crypto';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import sanitizeHtmlLib from 'sanitize-html';

import {
  BLOCKED_IMAGE_ATTR,
  countBlockedImages,
  decodeHtmlEntities,
  clipForReader,
  EMAIL_READER_HTML_MAX,
  EMAIL_READER_TEXT_MAX,
  EMAIL_BODY_MIN_HEIGHT,
  EMAIL_FRAME_SANDBOX,
  emailBodyBox,
  emailBodyCsp,
  emailImageProxyUrl,
  emailInlineImageUrl,
  isOpenableEmailLink,
  isRemoteImageUrl,
  parseEmailFrameMessage,
  rewriteRemoteCssUrls,
  splitQuotedHtml,
  splitQuotedText,
  stripEscapingCss,
  stripRemoteCssUrls,
} from '@chord/kernel';

import { API_BASE } from '@/api';
import { activeColorScheme, paperColors, themed } from '@/theme';

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

const ALLOWED_ATTR: Record<string, string[]> = {
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'style'],
  td: ['colspan', 'rowspan', 'align', 'valign', 'style', 'width'],
  th: ['colspan', 'rowspan', 'align', 'valign', 'style', 'width'],
  table: ['width', 'border', 'cellpadding', 'cellspacing', 'style'],
  div: ['style', 'align'],
  p: ['style', 'align'],
  span: ['style'],
  '*': ['style'],
};

/** Cheap tag strip so an HTML-only message is at least readable as plain text. */
export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const out = decodeHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\u00a0/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return out.length > 0 ? out : null;
}

export interface SanitizeOptions {
  /** Default true. Off once the reader has asked to see them, or the sender is
   *  on the allow list. */
  blockRemoteImages?: boolean;
  /**
   * ADR 0136 — rewrites a remote image URL to fetch it through Chord.
   *
   * Applied whenever images are being shown at all, including for a sender the
   * reader explicitly allowed: once a proxy exists there is no case left where
   * the device should fetch out of someone else's email directly. Absent (the
   * route disabled) means a remote image is dropped even when showing, because
   * loading it direct is the thing this is here to avoid.
   */
  proxy?: (remoteUrl: string) => string;
  /**
   * Address for an inline `cid:` part of this message. Not gated on
   * `blockRemoteImages`: the bytes come from the reader's own mailbox, so
   * showing them tells no sender anything. Absent = left as `cid:`, which
   * renders nothing (the print path, which has no token).
   */
  inline?: (contentId: string) => string;
}

/** Sanitize untrusted email HTML to a safe subset. */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions = {}): string {
  const { proxy } = opts;
  // No proxy means no safe way to show a remote image, whatever the reader
  // chose — so the blocking path stays on.
  const block = opts.blockRemoteImages !== false || !proxy;
  const rewriteStyle = (style: string | undefined): string =>
    stripEscapingCss(block ? stripRemoteCssUrls(style) : rewriteRemoteCssUrls(style, proxy!));
  return sanitizeHtmlLib(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTR,
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: sanitizeHtmlLib.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
      img: (_tagName, attribs) => {
        const remote = isRemoteImageUrl(attribs.src);
        const cid = attribs.src?.trim().toLowerCase().startsWith('cid:');
        // Blocked: dropping the src entirely is the point — `referrerpolicy`
        // only hides who is asking, and the request that confirms the address
        // is real still goes out.
        // Showing: the src points at us, so the request that goes out is ours.
        const src: Record<string, string> =
          cid && opts.inline
            ? { src: opts.inline(attribs.src) }
            : !remote
              ? {}
              : block
                ? { src: '', [BLOCKED_IMAGE_ATTR]: '1' }
                : { src: proxy!(attribs.src) };
        return {
          tagName: 'img',
          attribs: {
            ...attribs,
            ...src,
            referrerpolicy: 'no-referrer',
            loading: 'lazy',
            style: [rewriteStyle(attribs.style), 'max-width:100%;height:auto']
              .filter(Boolean)
              .join(';'),
          },
        };
      },
      // Every other tag that may carry an inline style, for the
      // background-image case — which fetches on render exactly as an <img>
      // does, and is the half a blocker that only rewrites `src` leaves behind.
      '*': (tagName: string, attribs: Record<string, string>) => ({
        tagName,
        attribs: attribs.style ? { ...attribs, style: rewriteStyle(attribs.style) } : attribs,
      }),
    },
  }).trim();
}

/**
 * What can be made to fit by reflowing. A layout with a fixed width that
 * still overflows (a 600px newsletter table) is shrunk to fit instead — see
 * FIT_PROBE — so nothing ever needs sideways scrolling.
 */
const fitCss = (scope: string) => `
  ${scope}img, ${scope}video { max-width: 100% !important; height: auto !important; }
  ${scope}table { max-width: 100% !important; }
  ${scope}td, ${scope}th { overflow-wrap: anywhere; }
  ${scope}pre, ${scope}code { white-space: pre-wrap; overflow-wrap: anywhere; }
  ${scope}a { color: ${paperColors.accent}; }
`;

const WRAPPER_CSS = `
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: ${paperColors.text};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.45;
    word-wrap: break-word;
    overflow-wrap: anywhere;
    overflow-x: hidden;
  }
  ${fitCss('')}
`;

/**
 * `zoomable` is the full-screen view: inline, the body is a fixed-height box
 * inside the thread's scroll, where a zoomed page would be clipped at the
 * box's edges and pinching would fight the thread's scrolling.
 */
interface DocumentOptions {
  zoomable?: boolean;
  /** Web: the probe runs as this nonce's inline script (a WebView injects it
   *  instead, which a page policy does not govern). */
  scriptNonce?: string;
  /** ADR 0260 - the reader's own HTML, whose images load directly. */
  remoteImages?: boolean;
}

/**
 * The one document an email body is drawn in - in a WebView on a phone, in a
 * sandboxed iframe on web.
 *
 * `zoomable` is the full-screen view: inline, the body is a fixed-height box
 * inside the thread's scroll, where a zoomed page would be clipped at the
 * box's edges and pinching would fight the thread's scrolling.
 */
function wrapDocument(body: string, opts: DocumentOptions = {}): string {
  const viewport = opts.zoomable
    ? 'width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes'
    : 'width=device-width, initial-scale=1, maximum-scale=1';
  const csp = emailBodyCsp(API_BASE, { scriptNonce: opts.scriptNonce, remoteImages: opts.remoteImages });
  const probe = opts.scriptNonce ? `<script nonce="${opts.scriptNonce}">${FIT_PROBE}</script>` : '';
  // The web frame is sized to the probe's height, so it never scrolls itself;
  // a shrunk layout keeps its unscaled height, which would otherwise show a
  // scrollbar (a WebView has scrolling switched off instead).
  const frameCss = opts.scriptNonce ? 'html, body { overflow: hidden; }' : '';
  // First in <head>: a policy only governs what is parsed after it.
  // flow-root keeps a first or last child's margin inside the measured box.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="${viewport}"/>
<style>${WRAPPER_CSS}${frameCss}</style></head><body><div id="chord-fit" style="transform-origin:0 0;display:flow-root">${body}</div>${probe}</body></html>`;
}

/**
 * Post-sanitize fit + height probe - JS is on only for this trusted script,
 * never email content. Shrinks a body laid out wider than the screen (same
 * rule as kernel `fitScale`) and reports the height it then occupies, again
 * whenever an image or a resize changes it.
 *
 * On a phone it answers through the WebView bridge. On web it is in a frame
 * with no origin of its own, so it posts to the app (`parseEmailFrameMessage`
 * checks every message) - the height, and any link the reader clicks, which
 * the app opens; the frame itself never navigates.
 */
const FIT_PROBE = `
(function(){
  var root = document.getElementById('chord-fit');
  if (!root) return;
  var rn = window.ReactNativeWebView && window.ReactNativeWebView.postMessage ? window.ReactNativeWebView : null;
  var framed = !rn && window.parent && window.parent !== window;
  function send(m){ try { window.parent.postMessage(m, '*'); } catch (e) {} }
  var last = -1, pending = false;
  function measure(){
    pending = false;
    root.style.transform = '';
    var vw = document.documentElement.clientWidth || window.innerWidth;
    var cw = Math.max(root.scrollWidth, root.offsetWidth);
    var s = (cw > vw + 1 && vw > 0) ? vw / cw : 1;
    if (s < 1) root.style.transform = 'scale(' + s + ')';
    var h = Math.ceil(root.getBoundingClientRect().height);
    if (h === last) return;
    last = h;
    if (rn) rn.postMessage(String(h));
    else if (framed) send({ chordEmail: 'height', height: h });
  }
  function soon(){ if (!pending) { pending = true; requestAnimationFrame(measure); } }
  measure();
  var imgs = document.images;
  for (var i = 0; i < imgs.length; i++) {
    if (!imgs[i].complete) { imgs[i].addEventListener('load', soon); imgs[i].addEventListener('error', soon); }
  }
  window.addEventListener('resize', soon);
  window.addEventListener('load', soon);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(soon).observe(root);
  if (framed) {
    document.addEventListener('click', function(e){
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      var t = e.target;
      var a = t && t.closest ? t.closest('a') : null;
      if (!a || !a.getAttribute('href')) return;
      e.preventDefault();
      send({ chordEmail: 'open', url: a.href });
    });
  }
})();
true;
`;

/** A fresh nonce for one email frame's script policy. */
function frameNonce(): string {
  const bytes = Crypto.getRandomBytes(18);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

export interface EmailBodyProps {
  html: string | null;
  text: string | null;
  snippet?: string;
  style?: StyleProp<ViewStyle>;
  /** ADR 0120 — default is to block. True once the reader has asked, or the
   *  sender is on their allow list, or (ADR 0136) they load images by default. */
  showRemoteImages?: boolean;
  /** ADR 0136 — the thread's image-proxy token. Without one nothing remote
   *  loads, whatever `showRemoteImages` says. */
  imageToken?: string | null;
  /** The message this body belongs to — how its inline `cid:` images are
   *  addressed. Needs `imageToken` too. */
  messageId?: string;
  /** How many remote images this body had blocked, so the THREAD can offer to
   *  show them once rather than once per message. */
  onBlockedImages?: (count: number) => void;
  /** ADR 0121 - default is to fold the quoted history behind a control. */
  collapseQuoted?: boolean;
  /** ADR 0260 - HTML the person wrote themselves (their own signature, in Settings):
   *  its images load directly, because they chose them and nobody is being told anything. */
  ownContent?: boolean;
  /** ADR 0294 - show the text only: no formatting, no images, no tappable
   *  links. For mail that may not be from who it says. */
  plainOnly?: boolean;
}

/**
 * Web: the email in a sandboxed frame of its own (no `allow-same-origin`, so
 * an opaque origin that reaches neither Chord's page, storage nor session).
 * The frame tells the app its height and the links clicked in it; nothing
 * else it could say is acted on.
 */
function WebEmailFrame({ html, remoteImages }: { html: string; remoteImages: boolean }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const doc = useMemo(
    () => wrapDocument(html, { scriptNonce: frameNonce(), remoteImages }),
    [html, remoteImages],
  );

  useEffect(() => {
    setHeight(null);
    const onMessage = (e: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = parseEmailFrameMessage(e.data);
      if (!m) return;
      if (m.kind === 'height') setHeight((h) => (h === m.height ? h : m.height));
      else void Linking.openURL(m.url);
    };
    window.addEventListener('message', onMessage);
    // Shown anyway if the probe never answers.
    const t = setTimeout(() => setHeight((h) => h ?? EMAIL_BODY_MIN_HEIGHT), 1500);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(t);
    };
  }, [doc]);

  // createElement avoids JSX intrinsic typing issues in RN tsconfig.
  return createElement('iframe', {
    ref: frameRef,
    srcDoc: doc,
    sandbox: EMAIL_FRAME_SANDBOX,
    referrerPolicy: 'no-referrer',
    title: 'Email message',
    style: {
      display: 'block',
      width: '100%',
      height: height ?? EMAIL_BODY_MIN_HEIGHT,
      border: 0,
      background: 'transparent',
      opacity: height === null ? 0 : 1,
    },
  });
}

export function EmailBody({
  html: rawHtml,
  text: rawText,
  snippet,
  style,
  showRemoteImages,
  imageToken,
  messageId,
  onBlockedImages,
  collapseQuoted,
  ownContent,
  plainOnly,
}: EmailBodyProps) {
  const htmlClip = useMemo(() => clipForReader(rawHtml, EMAIL_READER_HTML_MAX, 'html'), [rawHtml]);
  const textClip = useMemo(() => clipForReader(rawText, EMAIL_READER_TEXT_MAX, 'text'), [rawText]);
  const html = htmlClip.body;
  const text = textClip.body;
  const [showQuoted, setShowQuoted] = useState(false);
  const htmlSplit = useMemo(() => splitQuotedHtml(html), [html]);
  const textSplit = useMemo(() => splitQuotedText(text), [text]);
  const collapse = collapseQuoted !== false && !showQuoted;

  // Split before sanitizing: the class that identifies a client's quote
  // container does not survive the sanitizer.
  const activeHtml = html ? (collapse && htmlSplit.quoted ? htmlSplit.visible : html) : null;
  const proxy = useMemo(
    () =>
      ownContent
        ? (url: string) => url
        : imageToken
          ? (url: string) => emailImageProxyUrl(API_BASE, imageToken, url)
          : undefined,
    [imageToken, ownContent],
  );
  const inline = useMemo(
    () =>
      imageToken && messageId
        ? (cid: string) => emailInlineImageUrl(API_BASE, imageToken, messageId, cid)
        : undefined,
    [imageToken, messageId],
  );
  const sanitized = useMemo(
    () =>
      activeHtml
        ? sanitizeEmailHtml(activeHtml, { blockRemoteImages: !showRemoteImages, proxy, inline })
        : '',
    [activeHtml, showRemoteImages, proxy, inline],
  );
  // Reported upward rather than rendered here: the banner belongs to the
  // thread, not to each message, or a five-message thread shows it five
  // times for one decision.
  useEffect(() => {
    onBlockedImages?.(plainOnly ? 0 : countBlockedImages(sanitized));
  }, [sanitized, onBlockedImages, plainOnly]);

  const plainAll = useMemo(
    () =>
      clipForReader(text?.trim() || stripHtml(html) || snippet?.trim() || '', EMAIL_READER_TEXT_MAX, 'text')
        .body ?? '',
    [text, html, snippet],
  );
  const plain = collapse && text && textSplit.quoted ? textSplit.visible : plainAll;
  const [height, setHeight] = useState(120);
  const [inlineClipped, setInlineClipped] = useState(false);
  // Hidden until the first measurement, so the 120px guess never paints and
  // then jumps. Shown anyway if the probe never answers.
  const [measured, setMeasured] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = useMemo(
    () => ({ html: wrapDocument(sanitized, { remoteImages: !!ownContent }) }),
    [sanitized, ownContent],
  );
  const [fullScreen, setFullScreen] = useState(false);
  const fullSource = useMemo(
    () => ({ html: wrapDocument(sanitized, { zoomable: true, remoteImages: !!ownContent }) }),
    [sanitized, ownContent],
  );
  useEffect(() => {
    setMeasured(false);
    const t = setTimeout(() => setMeasured(true), 1500);
    return () => clearTimeout(t);
  }, [sanitized]);

  const onShouldStart = useCallback((req: { url: string }) => {
    const { url } = req;
    if (
      url === 'about:blank' ||
      url.startsWith('data:') ||
      url.startsWith('about:srcdoc')
    ) {
      return true;
    }
    if (isOpenableEmailLink(url)) {
      void Linking.openURL(url);
    }
    return false;
  }, []);

  const onMessage = useCallback((ev: { nativeEvent: { data: string } }) => {
    const box = emailBodyBox(Number(ev.nativeEvent.data));
    if (box) {
      setHeight(box.height);
      setInlineClipped(box.clipped);
      setMeasured(true);
    }
  }, []);

  const usingHtml = !!sanitized && !failed && !plainOnly;
  // ADR 0282 - email HTML is written for a white page (most never set a
  // background), so in dark mode it keeps one rather than being inverted.
  const paper = activeColorScheme() === 'dark';
  // Whichever half is actually on screen decides whether there is a control.
  const quoted = usingHtml ? htmlSplit.quoted : text ? textSplit.quoted : null;

  let body;
  if (!usingHtml) {
    body = <Text style={styles.plain}>{plain || '(empty message)'}</Text>;
  } else if (Platform.OS === 'web') {
    body = (
      <View style={[styles.webWrap, paper && styles.paper, style]}>
        <WebEmailFrame html={sanitized} remoteImages={!!ownContent} />
      </View>
    );
  } else {
    body = (
      <View
        style={[
          { height: height + (paper ? PAPER_PAD * 2 : 0), opacity: measured ? 1 : 0 },
          styles.webviewWrap,
          paper && styles.paper,
          style,
        ]}
      >
        <WebView
          originWhitelist={['*']}
          // Memoized: a new object per render can make the native side reload the page.
          source={source}
          // Height probe only; email scripts are stripped by sanitizeEmailHtml.
          javaScriptEnabled
          domStorageEnabled={false}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={onShouldStart}
          onMessage={onMessage}
          injectedJavaScript={FIT_PROBE}
          onError={() => setFailed(true)}
          onHttpError={() => setFailed(true)}
          // The page's own process died (out of memory on a huge email): show
          // the text instead of a blank box, and keep the app running.
          onRenderProcessGone={() => setFailed(true)}
          onContentProcessDidTerminate={() => setFailed(true)}
          style={styles.webview}
        />
      </View>
    );
  }

  // Phone only: on web the browser's own zoom already works on the page.
  const canFullScreen = usingHtml && Platform.OS !== 'web';
  const cutShort = htmlClip.clipped || (!usingHtml && textClip.clipped);
  if (!quoted && !canFullScreen && !cutShort) return body;

  return (
    <View>
      {body}
      {canFullScreen && inlineClipped ? (
        <Pressable
          onPress={() => setFullScreen(true)}
          style={styles.readRest}
          accessibilityLabel="Read the rest of this email"
        >
          <Text style={styles.readRestTxt}>{'This email continues — read the rest ⤢'}</Text>
        </Pressable>
      ) : null}
      {cutShort ? (
        <Text style={styles.cutNote}>
          This email is too long to show in full here. Open it in your mail app for the rest.
        </Text>
      ) : null}
      <View style={styles.controls}>
        {quoted ? (
          <Pressable
            onPress={() => setShowQuoted((v) => !v)}
            hitSlop={6}
            style={styles.quoteToggle}
            accessibilityLabel={showQuoted ? 'Hide quoted text' : 'Show quoted text'}
          >
            <Text style={styles.quoteToggleTxt}>
              {showQuoted ? 'Hide quoted text' : '\u00b7\u00b7\u00b7  Show quoted text'}
            </Text>
          </Pressable>
        ) : null}
        {canFullScreen ? (
          <Pressable
            onPress={() => setFullScreen(true)}
            hitSlop={6}
            style={styles.quoteToggle}
            accessibilityLabel="View full screen"
          >
            <Text style={styles.quoteToggleTxt}>{'\u2922  Full screen'}</Text>
          </Pressable>
        ) : null}
      </View>
      {canFullScreen ? (
        <FullScreenEmail
          visible={fullScreen}
          source={fullSource}
          onClose={() => setFullScreen(false)}
          onShouldStart={onShouldStart}
        />
      ) : null}
    </View>
  );
}

/** The email by itself, where pinch-zoom and dragging around work. */
function FullScreenEmail({
  visible,
  source,
  onClose,
  onShouldStart,
}: {
  visible: boolean;
  source: { html: string };
  onClose: () => void;
  onShouldStart: (req: { url: string }) => boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={[styles.fullRoot, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.fullHead}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close full screen">
            <Text style={styles.fullDone}>Done</Text>
          </Pressable>
        </View>
        {visible ? (
          <WebView
            originWhitelist={['*']}
            source={source}
            // Fit probe only, so the email opens fitted to the width; email
            // scripts are stripped by sanitizeEmailHtml.
            javaScriptEnabled
            injectedJavaScript={FIT_PROBE}
            domStorageEnabled={false}
            scrollEnabled
            setBuiltInZoomControls
            setDisplayZoomControls={false}
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={onShouldStart}
            style={[styles.fullWebview, activeColorScheme() === 'dark' && { backgroundColor: paperColors.card }]}
          />
        ) : null}
      </View>
    </Modal>
  );
}

const PAPER_PAD = 10;

const styles = themed((colors) => ({
  paper: { backgroundColor: paperColors.card, borderRadius: 8, padding: PAPER_PAD },
  plain: { color: colors.text, fontSize: 14, lineHeight: 20 },
  webWrap: { width: '100%' },
  webviewWrap: { width: '100%', overflow: 'hidden' },
  webview: { backgroundColor: 'transparent', flex: 1 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  readRest: {
    marginTop: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: colors.bg2,
  },
  readRestTxt: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  cutNote: { marginTop: 8, color: colors.muted, fontSize: 12 },
  quoteToggle: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: colors.bg2,
  },
  quoteToggleTxt: { color: colors.muted, fontSize: 12 },
  fullRoot: { flex: 1, backgroundColor: colors.bg },
  fullHead: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  fullDone: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  fullWebview: { flex: 1, backgroundColor: 'transparent' },
}));
