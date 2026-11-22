import { useCallback, useEffect, useState } from 'react';
import { Link, Redirect, router, useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { greetingName, type ChatInvite, type Group } from '@chord/kernel';

import {
  answerChatInvite,
  createGroup,
  deleteGroup,
  deleteMessages,
  getHealth,
  joinGroup,
  leaveGroup,
  listChatInvites,
  listGroups,
  resetDemo,
  runDevProactiveScan,
} from '@/api';
import { clearChatPrompt, deletePrompt, leavePrompt } from '@/group-actions';
import { MainBottomNav } from '@/group-nav';
import { extractInviteCode } from '@/join-code';
import { groupTitle } from '@/names';
import { InviteByEmail } from '@/invite-by-email';
import { useScreenRefresh } from '@/refresh';
import { useApp } from '@/store';
import { loadErrorText } from '@/network';
import { avatarFor, colors, themed } from '@/theme';
import { confirmDestructive } from '@/confirm';
import { useAndroidBottomInset } from '@/system-bars';
import { DISMISS_KEYBOARD_ON_DRAG } from '@/keyboard';

export default function GroupsScreen() {
  const user = useApp((s) => s.user);
  const groups = useApp((s) => s.groups);
  const setGroups = useApp((s) => s.setGroups);
  const upsertGroup = useApp((s) => s.upsertGroup);
  const removeGroupLocal = useApp((s) => s.removeGroupLocal);
  const clearMessagesLocal = useApp((s) => s.clearMessagesLocal);
  // ADR 0259 - the chat whose actions sheet is open.
  const [menuFor, setMenuFor] = useState<Group | null>(null);

  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'idle' | 'create' | 'message' | 'join'>('idle');
  // ADR 0318 - invites waiting for this user's answer.
  const [invites, setInvites] = useState<ChatInvite[]>([]);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setGroups(await listGroups());
    } catch (e) {
      setErr(loadErrorText(e));
    }
    void listChatInvites()
      .then(setInvites)
      .catch(() => {});
  }, [setGroups]);

  const answerInvite = useCallback(
    (id: string, accept: boolean) => {
      setErr(null);
      void answerChatInvite(id, accept)
        .then((res) => {
          setInvites((xs) => xs.filter((x) => x.id !== id));
          void refresh();
          if (accept && res.groupId) router.push(`/groups/${res.groupId}`);
        })
        .catch((e) => setErr((e as Error).message));
    },
    [refresh],
  );

  useEffect(() => {
    void getHealth()
      .then((h) => setDemoMode(h.demoMode))
      .catch(() => {});
  }, []);

  const doReset = useCallback(async () => {
    setResetting(true);
    setErr(null);
    try {
      await resetDemo();
      await refresh();
    } catch (e) {
      setErr(`reset failed: ${(e as Error).message}`);
    } finally {
      setResetting(false);
    }
  }, [refresh]);

  const confirmReset = useCallback(() => {
    confirmDestructive(
      'Reset demo data?',
      'This wipes groups, messages, tasks - and reseeds the Doe corpus.',
      () => void doReset(),
      { confirmLabel: 'Reset' },
    );
  }, [doReset]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const { refreshControl } = useScreenRefresh(refresh);

  const doCreate = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const g = await createGroup({ name: name.trim(), kind: 'group' });
      upsertGroup(g);
      setMode('idle');
      setName('');
      router.push(`/groups/${g.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [name, upsertGroup]);

  const doRunScan = useCallback(async () => {
    setErr(null);
    setScanning(true);
    try {
      await runDevProactiveScan();
      const personal = groups.find((g) => g.kind === 'personal');
      if (personal) router.push(`/groups/${personal.id}`);
    } catch (e) {
      setErr(`scan failed: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  }, [groups]);

  const doJoin = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const g = await joinGroup({ inviteCode: extractInviteCode(code) });
      upsertGroup(g);
      setMode('idle');
      setCode('');
      router.push(`/groups/${g.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [code, upsertGroup]);

  const runAction = useCallback(
    (work: () => Promise<unknown>, after: () => void) => {
      setErr(null);
      void work()
        .then(after)
        .catch((e) => setErr((e as Error).message));
    },
    [],
  );

  const clearChat = useCallback(
    (g: Group) => {
      const p = clearChatPrompt(g.kind);
      confirmDestructive(
        p.title,
        p.message,
        () =>
          runAction(
            () => deleteMessages(g.id, { all: true }),
            () => {
              clearMessagesLocal(g.id);
              void refresh();
            },
          ),
        { confirmLabel: 'Clear' },
      );
    },
    [clearMessagesLocal, refresh, runAction],
  );

  const leaveChat = useCallback(
    (g: Group) => {
      const p = leavePrompt(g.createdBy === user?.id);
      confirmDestructive(
        p.title,
        p.message,
        () =>
          runAction(
            () => leaveGroup(g.id),
            () => {
              removeGroupLocal(g.id);
              void refresh();
            },
          ),
        { confirmLabel: 'Leave' },
      );
    },
    [refresh, removeGroupLocal, runAction, user?.id],
  );

  const deleteChat = useCallback(
    (g: Group) => {
      const p = deletePrompt(groupTitle(g, user));
      confirmDestructive(
        p.title,
        p.message,
        () =>
          runAction(
            () => deleteGroup(g.id),
            () => {
              removeGroupLocal(g.id);
              void refresh();
            },
          ),
      );
    },
    [refresh, removeGroupLocal, runAction, user],
  );

  // A web refresh starts with no user loaded: the root route boots and comes
  // back here, not to the launch tab (Email).
  if (!user) return <Redirect href={{ pathname: '/', params: { next: '/groups' } }} />;

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
      <View style={styles.header}>
        <View>
          <Text style={styles.hello}>Hi, {greetingName(user)}</Text>
          <Text style={styles.sub}>your chats</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={[styles.actionBtn, mode === 'create' && styles.actionBtnActive]}
          onPress={() => setMode(mode === 'create' ? 'idle' : 'create')}
        >
          <Text style={styles.actionText}>+ New group</Text>
        </Pressable>
        <Pressable
          style={[styles.actionBtn, (mode === 'message' || mode === 'join') && styles.actionBtnActive]}
          onPress={() => setMode(mode === 'message' || mode === 'join' ? 'idle' : 'message')}
        >
          <Text style={styles.actionText}>✉️ Message someone</Text>
        </Pressable>
        {demoMode && (
          <Pressable
            style={[styles.actionBtn, scanning && { opacity: 0.6 }]}
            onPress={doRunScan}
            disabled={scanning}
          >
            {scanning ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.actionText}>🌅 Run morning scan</Text>
            )}
          </Pressable>
        )}
      </View>

      {mode === 'create' && (
        <View style={styles.inlineForm}>
          <TextInput
            style={styles.input}
            placeholder="Group name (e.g. Doe Family)"
            value={name}
            onChangeText={setName}
            placeholderTextColor={colors.muted}
            autoFocus
          />
          <Pressable style={styles.submit} disabled={!name.trim() || busy} onPress={doCreate}>
            {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitText}>Create</Text>}
          </Pressable>
        </View>
      )}
      {mode === 'message' && (
        <View>
          <InviteByEmail openChat autoFocus onSent={() => void refresh()} />
          <Pressable onPress={() => setMode('join')} hitSlop={6} style={{ marginBottom: 12 }}>
            <Text style={styles.codeLink}>Got an invite code instead?</Text>
          </Pressable>
        </View>
      )}
      {mode === 'join' && (
        <View style={styles.inlineForm}>
          <TextInput
            style={styles.input}
            placeholder="Invite code or link"
            value={code}
            onChangeText={(t) => setCode(/\/join\//i.test(t) ? t : t.toUpperCase())}
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            autoFocus
          />
          <Pressable style={styles.submit} disabled={!code.trim() || busy} onPress={doJoin}>
            {busy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitText}>Join</Text>}
          </Pressable>
        </View>
      )}

      {err && <Text style={styles.err}>{err}</Text>}

      {invites.map((inv) => (
        <View key={inv.id} style={styles.inviteRow}>
          <Text style={styles.inviteTitle}>
            {inv.groupName ? `${inv.fromName} invited you to ${inv.groupName}` : `${inv.fromName} wants to chat`}
          </Text>
          {inv.message ? <Text style={styles.inviteMsg}>&ldquo;{inv.message}&rdquo;</Text> : null}
          <View style={styles.inviteBtns}>
            <Pressable style={styles.submit} onPress={() => answerInvite(inv.id, true)}>
              <Text style={styles.submitText}>Accept</Text>
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={() => answerInvite(inv.id, false)}>
              <Text style={styles.actionText}>Decline</Text>
            </Pressable>
          </View>
        </View>
      ))}

      <FlatList {...DISMISS_KEYBOARD_ON_DRAG}
        data={groups}
        keyExtractor={(g) => g.id}
        refreshControl={refreshControl}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListEmptyComponent={
          <Text style={styles.empty}>No chats yet. Tap Message someone and type their email.</Text>
        }
        renderItem={({ item }) => <GroupRow group={item} onMenu={setMenuFor} />}
      />

      {demoMode && (
        <Pressable
          onPress={confirmReset}
          disabled={resetting}
          style={[styles.resetBtn, resetting && { opacity: 0.4 }]}
          hitSlop={8}
        >
          <Text style={styles.resetText}>
            {resetting ? 'Resetting demo…' : '↻ Reset demo data'}
          </Text>
        </Pressable>
      )}
      </View>
      <MainBottomNav current="chats" />
      <ChatActionsSheet
        group={menuFor}
        isOwner={!!menuFor && menuFor.createdBy === user.id}
        title={menuFor ? groupTitle(menuFor, user) : ''}
        onClose={() => setMenuFor(null)}
        onClear={(g) => clearChat(g)}
        onLeave={(g) => leaveChat(g)}
        onDelete={(g) => deleteChat(g)}
      />
    </View>
  );
}

// Compact, WhatsApp-style timestamp for the chat list: time today, weekday
// within the past week, otherwise a short date.
function formatChatTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * ADR 0259 - what can be done to a chat from the list: clear it, leave it, and (for its
 * owner) delete it. A personal chat can only be cleared. Each choice still confirms.
 */
function ChatActionsSheet({
  group,
  isOwner,
  title,
  onClose,
  onClear,
  onLeave,
  onDelete,
}: {
  group: Group | null;
  isOwner: boolean;
  title: string;
  onClose: () => void;
  onClear: (g: Group) => void;
  onLeave: (g: Group) => void;
  onDelete: (g: Group) => void;
}) {
  const bottomInset = useAndroidBottomInset();
  if (!group) return null;
  const personal = group.kind === 'personal';
  const pick = (fn: (g: Group) => void) => () => {
    onClose();
    fn(group);
  };
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: 28 + bottomInset }]} onPress={() => {}}>
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable style={styles.sheetItem} onPress={pick(onClear)}>
            <Text style={styles.sheetItemTxt}>Clear chat</Text>
          </Pressable>
          {!personal && (
            <Pressable style={styles.sheetItem} onPress={pick(onLeave)}>
              <Text style={styles.sheetItemTxt}>Leave group</Text>
            </Pressable>
          )}
          {!personal && isOwner && (
            <Pressable style={styles.sheetItem} onPress={pick(onDelete)}>
              <Text style={[styles.sheetItemTxt, styles.sheetDanger]}>Delete group</Text>
            </Pressable>
          )}
          <Pressable style={styles.sheetItem} onPress={onClose}>
            <Text style={[styles.sheetItemTxt, { color: colors.muted }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function GroupRow({ group, onMenu }: { group: Group; onMenu: (g: Group) => void }) {
  const user = useApp((s) => s.user);
  const title = groupTitle(group, user);
  const av = avatarFor(title);
  const unread = group.unreadCount ?? 0;
  const hasUnread = unread > 0;
  const time = formatChatTime(group.lastMessageAt);
  const preview =
    group.lastMessagePreview ??
    (group.kind === 'personal' ? 'Ask Chord anything' : 'No messages yet');
  return (
    <Link href={`/groups/${group.id}`} asChild>
      <Pressable style={styles.row} onLongPress={() => onMenu(group)} delayLongPress={350}>
        <View style={[styles.av, { backgroundColor: av.bg }]}>
          <Text style={[styles.avTxt, { color: av.fg }]}>{av.initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.rowTopLine}>
            <Text
              style={[styles.rowTitle, hasUnread && styles.rowTitleUnread]}
              numberOfLines={1}
            >
              {title}
            </Text>
            {time ? <Text style={styles.rowTime}>{time}</Text> : null}
          </View>
          <Text
            style={[styles.rowPreview, hasUnread && styles.rowPreviewUnread]}
            numberOfLines={1}
          >
            {preview}
          </Text>
          {group.kind === 'personal' && (
            <Text style={styles.rowSub} numberOfLines={1}>
              Private · you + Chord
            </Text>
          )}
        </View>
        {hasUnread && (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadBadgeText}>{unread > 99 ? '99+' : unread}</Text>
          </View>
        )}
        {/* The same actions as a long press, for a mouse and for anyone who never finds the gesture. */}
        <Pressable hitSlop={10} onPress={() => onMenu(group)} accessibilityLabel="Chat options">
          <Text style={styles.menuDots}>⋯</Text>
        </Pressable>
      </Pressable>
    </Link>
  );
}

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: 16 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  hello: { fontSize: 20, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.8 },
  actions: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  actionText: { color: colors.text, fontWeight: '500', fontSize: 13 },
  inlineForm: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    fontSize: 14,
    backgroundColor: colors.card,
  },
  submit: {
    backgroundColor: colors.accent,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitText: { color: colors.onAccent, fontWeight: '600' },
  err: { color: colors.red, marginBottom: 8 },
  codeLink: { color: colors.muted, fontSize: 13, textDecorationLine: 'underline' },
  inviteRow: {
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accent,
    gap: 6,
  },
  inviteTitle: { color: colors.text, fontWeight: '600', fontSize: 15 },
  inviteMsg: { color: colors.muted, fontSize: 14 },
  inviteBtns: { flexDirection: 'row', gap: 8, marginTop: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    backgroundColor: colors.card,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  av: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avTxt: { fontWeight: '700', fontSize: 13 },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: '500', color: colors.text },
  rowTitleUnread: { fontWeight: '700' },
  rowTime: { fontSize: 11, color: colors.muted },
  rowPreview: { fontSize: 13, color: colors.muted, marginTop: 2 },
  rowPreviewUnread: { color: colors.text, fontWeight: '600' },
  rowSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 7,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadBadgeText: { color: colors.onAccent, fontSize: 11, fontWeight: '700' },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 40, fontStyle: 'italic' },
  menuDots: { fontSize: 20, color: colors.muted, paddingHorizontal: 4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 28,
  },
  sheetTitle: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6, textTransform: 'uppercase' },
  sheetItem: { paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border },
  sheetItemTxt: { color: colors.text, fontSize: 16 },
  sheetDanger: { color: colors.red },
  resetBtn: {
    alignSelf: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  resetText: { fontSize: 11, color: colors.muted, textDecorationLine: 'underline' },
}));
