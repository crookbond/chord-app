/**
 * Per-group config screen. Reached by tapping the group name in the chat
 * header. Two sections: Messaging (per-platform connectors with BYO
 * support per ADR 0025) and Members (roster). User-level settings live
 * at /settings, not here.
 */
import * as Clipboard from 'expo-clipboard';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { KeyboardModalBody, KeyboardScrollView } from '@/keyboard';

import type {
  ConnectorBinding,
  ConnectorPlatform,
  ConnectorRuntimeStatus,
  GroupConnectorsResponse,
  GroupMember,
  StartPairingResponse,
} from '@chord/kernel';
import { ALIAS_PATTERN } from '@chord/kernel';

import {
  deleteGroup,
  deleteMessages,
  getGroup,
  getGroupConnectors,
  inviteUrl,
  getPairingStatus,
  leaveGroup,
  listGroupMembers,
  openGroupStream,
  regenerateInviteCode,
  renameBinding,
  setGroupMuted,
  updateGroup,
  startPairing,
  cancelPairing,
  unbindConnector,
} from '@/api';
import { clearChatPrompt, deletePrompt, leavePrompt } from '@/group-actions';
import { MainBottomNav } from '@/group-nav';
import { useApp } from '@/store';
import { colors, themed } from '@/theme';
import { confirmDestructive } from '@/confirm';
import { InviteByEmail } from '@/invite-by-email';

const POLL_INTERVAL_MS = 2_500;

const PLATFORM_LABEL: Record<ConnectorPlatform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
};

interface AliasDraft {
  platform: ConnectorPlatform;
  alias: string;
  useByo: boolean;
  botToken: string;
}

export default function GroupConfigScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const currentUserId = useApp((s) => s.user?.id);
  const removeGroupLocal = useApp((s) => s.removeGroupLocal);
  const clearMessagesLocal = useApp((s) => s.clearMessagesLocal);
  const [clearBusy, setClearBusy] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [groupName, setGroupName] = useState<string>('Group');
  const [groupKind, setGroupKind] = useState<'group' | 'personal'>('group');
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);
  const [mirrorInbound, setMirrorInbound] = useState(false);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [data, setData] = useState<GroupConnectorsResponse | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  const isOwner = useMemo(
    () => members.some((m) => m.userId === currentUserId && m.role === 'owner'),
    [members, currentUserId],
  );

  const [pairing, setPairing] = useState<StartPairingResponse | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingExpired, setPairingExpired] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [aliasDraft, setAliasDraft] = useState<AliasDraft | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [aliasSubmitting, setAliasSubmitting] = useState(false);

  const [renameTarget, setRenameTarget] = useState<ConnectorBinding | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSubmitting, setRenameSubmitting] = useState(false);

  const copy = useCallback(async (key: string, value: string) => {
    try {
      await Clipboard.setStringAsync(value);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1_500);
      // Copy = close for the pair code itself. The pending code shows on
      // the connector card so the user can come back to it, and the SSE
      // `connector-bound` event still triggers refresh() when the user
      // pastes it on the platform side. Bot-handle copy stays open
      // because the user usually copies it on the way to copying the
      // code next.
      if (key === 'code') {
        setPairing(null);
        setPairingError(null);
        setPairingExpired(false);
      }
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!groupId) return;
    try {
      setError(null);
      const [conn, mem] = await Promise.all([
        getGroupConnectors(groupId),
        listGroupMembers(groupId).catch(() => [] as GroupMember[]),
      ]);
      setData(conn);
      setMembers(mem);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    if (!groupId) return;
    void getGroup(groupId).then((g) => {
      setGroupName(g.name);
      setGroupKind(g.kind);
      setInviteCode(g.inviteCode);
      setMuted(!!g.muted);
      setMirrorInbound(!!g.mirrorInbound);
    });
  }, [groupId]);

  const toggleMute = useCallback(async () => {
    if (!groupId) return;
    const next = !muted;
    setMuted(next); // optimistic
    setMuteBusy(true);
    try {
      await setGroupMuted(groupId, next);
    } catch (err) {
      setMuted(!next);
      setError(err instanceof Error ? err.message : 'failed to update');
    } finally {
      setMuteBusy(false);
    }
  }, [groupId, muted]);

  const toggleMirror = useCallback(async () => {
    if (!groupId) return;
    const next = !mirrorInbound;
    setMirrorInbound(next); // optimistic
    setMirrorBusy(true);
    try {
      await updateGroup(groupId, { mirrorInbound: next });
    } catch (err) {
      setMirrorInbound(!next);
      setError(err instanceof Error ? err.message : 'failed to update');
    } finally {
      setMirrorBusy(false);
    }
  }, [groupId, mirrorInbound]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  // Focus, not mount: a settings screen pushed under another holds no socket (ADR 0082).
  useFocusEffect(
    useCallback(() => {
      if (!groupId) return;
      let cancelled = false;
      let close: (() => void) | null = null;
      void openGroupStream(groupId, {
        onConnectorBound: () => {
          if (!cancelled) void refresh();
        },
        onConnectorUnbound: () => {
          if (!cancelled) void refresh();
        },
        onConnectorRenamed: () => {
          if (!cancelled) void refresh();
        },
      })
        .then((handle) => {
          if (cancelled) handle.close();
          else close = handle.close;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
        close?.();
      };
    }, [groupId, refresh]),
  );

  useEffect(() => {
    // Stop polling once the code is spent: `bound` clears `pairing`, `expired`
    // flips `pairingExpired` - either re-runs this effect, whose cleanup clears
    // the interval, and this guard keeps a new one from starting.
    if (!pairing || pairingExpired) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const status = await getPairingStatus(groupId, pairing.code);
        if (cancelled) return;
        if (status.status === 'bound') {
          setPairing(null);
          setPairingError(null);
          setPairingExpired(false);
          await refresh();
          return;
        }
        if (status.status === 'expired') {
          setPairingExpired(true);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setPairingError(err instanceof Error ? err.message : String(err));
      }
    };
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [pairing, pairingExpired, groupId, refresh]);

  const openAliasPrompt = (platform: ConnectorPlatform) => {
    setAliasError(null);
    const platformStatus = data?.platforms[platform];
    // Default to BYO when the deploy-wide bot isn't configured but BYO is
    // supported, so the user lands on the field they need to fill.
    const useByo = !platformStatus?.enabled && !!platformStatus?.byoSupported;
    setAliasDraft({ platform, alias: platform, useByo, botToken: '' });
  };

  const submitAliasAndStartPair = async () => {
    if (!aliasDraft) return;
    const alias = aliasDraft.alias.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(alias)) {
      setAliasError('Use 1-24 chars: a-z, 0-9, dashes. Must start with a letter or digit.');
      return;
    }
    if (aliasDraft.useByo && aliasDraft.botToken.trim().length === 0) {
      setAliasError('Paste your bot token from the platform.');
      return;
    }
    setAliasError(null);
    setAliasSubmitting(true);
    try {
      const res = await startPairing(groupId, {
        // WhatsApp onboards via the app + personal-binding, never a pair
        // code (ADR 0053); the pairing UI only ever opens for pairable
        // platforms, so narrow away 'whatsapp' here.
        platform: aliasDraft.platform as Exclude<ConnectorPlatform, 'whatsapp'>,
        alias,
        botToken: aliasDraft.useByo ? aliasDraft.botToken.trim() : undefined,
      });
      setAliasDraft(null);
      setPairingError(null);
      setPairingExpired(false);
      setPairing(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('alias_already_in_use')) {
        setAliasError(`"${alias}" is already used by another bridge in this group.`);
      } else if (msg.includes('invalid_bot_token')) {
        setAliasError('That bot token didn’t pass validation. Double-check you copied it correctly.');
      } else {
        setAliasError(msg);
      }
    } finally {
      setAliasSubmitting(false);
    }
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const alias = renameDraft.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(alias)) {
      setRenameError('Use 1-24 chars: a-z, 0-9, dashes. Must start with a letter or digit.');
      return;
    }
    setRenameError(null);
    setRenameSubmitting(true);
    try {
      await renameBinding(groupId, {
        platform: renameTarget.platform,
        externalChannelId: renameTarget.externalChannelId,
      }, alias);
      setRenameTarget(null);
      setRenameDraft('');
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('alias_already_in_use')) {
        setRenameError(`"${alias}" is already used by another bridge in this group.`);
      } else {
        setRenameError(msg);
      }
    } finally {
      setRenameSubmitting(false);
    }
  };

  const closeModal = () => {
    setPairing(null);
    setPairingError(null);
    setPairingExpired(false);
    setCopiedKey(null);
  };

  const disconnect = (binding: ConnectorBinding) => {
    const human = binding.externalDisplay ?? `${binding.platform} ${binding.externalChannelId}`;
    const doIt = async () => {
      try {
        await unbindConnector(groupId, {
          platform: binding.platform,
          externalChannelId: binding.externalChannelId,
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    confirmDestructive(
      'Disconnect',
      `Disconnect ${human}?`,
      () => void doIt(),
      { confirmLabel: 'Disconnect' },
    );
  };

  const cancelPending = (code: string) => {
    const doIt = async () => {
      try {
        await cancelPairing(groupId, code);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    confirmDestructive(
      'Cancel pairing',
      `Cancel pairing code ${code}?`,
      () => void doIt(),
      { confirmLabel: 'Cancel', cancelLabel: 'Keep' },
    );
  };

  const regenerate = () => {
    confirmDestructive(
      'Reset invite code',
      'The current code stops working immediately. Anyone with the old code can no longer join.',
      () => {
        setLifecycleBusy(true);
        void regenerateInviteCode(groupId)
          .then((res) => setInviteCode(res.inviteCode))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setLifecycleBusy(false));
      },
      { confirmLabel: 'Reset' },
    );
  };

  const copyInvite = () => {
    if (!inviteCode) return;
    void copy('invite', inviteCode);
  };

  const copyInviteLink = () => {
    if (!inviteCode) return;
    void copy('inviteLink', inviteUrl(inviteCode));
  };

  const clearChat = () => {
    const prompt = clearChatPrompt(groupKind);
    confirmDestructive(
      prompt.title,
      prompt.message,
      () => {
        setClearBusy(true);
        setCleared(false);
        void deleteMessages(groupId, { all: true })
          .then(() => {
            clearMessagesLocal(groupId);
            setCleared(true);
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setClearBusy(false));
      },
      { confirmLabel: 'Clear' },
    );
  };

  const leave = () => {
    const prompt = leavePrompt(isOwner);
    confirmDestructive(
      prompt.title,
      prompt.message,
      () => {
        setLifecycleBusy(true);
        void leaveGroup(groupId)
          .then(() => {
            removeGroupLocal(groupId);
            router.replace('/groups');
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
            setLifecycleBusy(false);
          });
      },
      { confirmLabel: 'Leave' },
    );
  };

  const remove = () => {
    const prompt = deletePrompt(groupName);
    confirmDestructive(
      prompt.title,
      prompt.message,
      () => {
        setLifecycleBusy(true);
        void deleteGroup(groupId)
          .then(() => {
            removeGroupLocal(groupId);
            router.replace('/groups');
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
            setLifecycleBusy(false);
          });
      },
    );
  };

  // Telegram is the only bridge you can add. Slack / Discord are not coming;
  // a legacy binding for either still gets a card so it can be disconnected.
  const platformList = useMemo<ConnectorPlatform[]>(() => {
    const bound = new Set((data?.bindings ?? []).map((b) => b.platform));
    return (['telegram', 'discord', 'slack'] as ConnectorPlatform[]).filter(
      (p) => p === 'telegram' || bound.has(p),
    );
  }, [data]);

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: groupName,
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace(`/groups/${groupId}`);
              }}
              hitSlop={8}
              style={styles.headerBack}
              accessibilityLabel="Back to chat"
            >
              <Text style={styles.headerBackTxt}>‹ Chat</Text>
            </Pressable>
          ),
        }}
      />
      <KeyboardScrollView style={styles.root} contentContainerStyle={styles.scrollContent}>
        {loading && (
          <View style={styles.loading}><ActivityIndicator /></View>
        )}
        {error && <Text style={styles.err}>{error}</Text>}

        {!loading && data && (
          <>
            <Text style={styles.sectionTitle}>Messaging</Text>
            <Text style={styles.sectionSub}>
              Bridge an external IM group into this Chord group. The bot replies wherever it&rsquo;s
              @-mentioned; whether every other message mirrors here is the switch below.
            </Text>

            {platformList.map((p) => (
              <PlatformCard
                key={p}
                platform={p}
                data={data}
                onAdd={() => openAliasPrompt(p)}
                onRename={(b) => {
                  setRenameError(null);
                  setRenameDraft(b.alias);
                  setRenameTarget(b);
                }}
                onDisconnect={disconnect}
                onCancelPending={cancelPending}
              />
            ))}

            {data.bindings.length > 0 && (
              <View style={styles.card}>
                <View style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.toggleLabel}>Mirror all messages</Text>
                    <Text style={styles.muted}>
                      {mirrorInbound
                        ? 'Every bridged message shows in this chat.'
                        : 'Only replies to @Chord come through.'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void toggleMirror()}
                    disabled={mirrorBusy}
                    style={[
                      styles.switchTrack,
                      mirrorInbound && styles.switchTrackOn,
                      mirrorBusy && { opacity: 0.4 },
                    ]}
                  >
                    <View style={[styles.switchThumb, mirrorInbound && styles.switchThumbOn]} />
                  </Pressable>
                </View>
              </View>
            )}

            <Text style={styles.sectionTitle}>Notifications</Text>
            <Text style={styles.sectionSub}>
              Mute push notifications for this group. You stay a member and can still open it
              anytime - you just won&rsquo;t be pinged.
            </Text>
            <View style={styles.card}>
              <View style={styles.toggleRow}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={styles.toggleLabel}>Mute this group</Text>
                  <Text style={styles.muted}>{muted ? 'Muted' : 'Notifications on'}</Text>
                </View>
                <Pressable
                  onPress={() => void toggleMute()}
                  disabled={muteBusy}
                  style={[
                    styles.switchTrack,
                    muted && styles.switchTrackOn,
                    muteBusy && { opacity: 0.4 },
                  ]}
                >
                  <View style={[styles.switchThumb, muted && styles.switchThumbOn]} />
                </Pressable>
              </View>
            </View>

            <Text style={styles.sectionTitle}>Messages</Text>
            <Text style={styles.sectionSub}>
              {groupKind === 'personal'
                ? 'Delete every message in this chat. Tasks, events, lists and files stay.'
                : 'Remove every message from your view of this chat. Other members keep theirs, and new messages show as usual.'}
            </Text>
            <View style={styles.card}>
              <Pressable
                style={[styles.dangerWideBtn, clearBusy && styles.btnDisabled]}
                onPress={clearChat}
                disabled={clearBusy}
                accessibilityRole="button"
              >
                <Text style={styles.dangerBtnTxt}>Clear chat</Text>
              </Pressable>
              {cleared && <Text style={styles.muted}>Chat cleared.</Text>}
            </View>

            {groupKind !== 'personal' && (
              <>
                <Text style={styles.sectionTitle}>Family</Text>
                <Pressable
                  style={styles.card}
                  onPress={() => router.push(`/groups/${groupId}/about` as never)}
                >
                  <Text style={styles.cardTitle}>About this family</Text>
                  <Text style={styles.muted}>
                    The roster, birthdays, allergies, schools, the household — everything Chord
                    knows about this group.
                  </Text>
                </Pressable>
              </>
            )}

            <Text style={styles.sectionTitle}>Members</Text>
            <Text style={styles.sectionSub}>
              {groupKind === 'personal'
                ? 'Just you and Chord. Personal groups stay 1:1.'
                : `${members.length} member${members.length === 1 ? '' : 's'} in this group.`}
            </Text>

            <View style={styles.card}>
              {members.length === 0 && (
                <Text style={styles.muted}>No members loaded.</Text>
              )}
              {members.map((m) => (
                <View key={m.userId} style={styles.memberRow}>
                  <Text style={styles.memberName}>
                    {m.displayName || m.username}
                  </Text>
                  <Text style={styles.memberMeta}>
                    @{m.username} · {m.role}
                    {m.tier ? ` · ${m.tier}` : ''}
                    {m.shadow ? ' · 📥 imported' : ''}
                  </Text>
                </View>
              ))}
            </View>

            {groupKind !== 'personal' && (
              <>
                <Text style={styles.sectionTitle}>Invite</Text>
                <Text style={styles.sectionSub}>
                  Type their email. Someone already on Chord gets an invite to
                  accept; anyone else gets an email with a link that brings them
                  straight in.
                </Text>
                <View style={styles.card}>
                  <InviteByEmail groupId={groupId} />
                  <Text style={[styles.fieldLabel, { marginTop: 6 }]}>Or share the link</Text>
                  <View style={styles.copyRow}>
                    <Text selectable numberOfLines={1} style={[styles.inviteLink, { flex: 1 }]}>
                      {inviteCode ? inviteUrl(inviteCode) : '-'}
                    </Text>
                    <Pressable
                      style={styles.copyBtn}
                      onPress={copyInviteLink}
                      disabled={!inviteCode}
                    >
                      <Text style={styles.copyBtnTxt}>
                        {copiedKey === 'inviteLink' ? 'Copied' : 'Copy link'}
                      </Text>
                    </Pressable>
                  </View>

                  <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Or share the code</Text>
                  <View style={styles.copyRow}>
                    <Text selectable style={[styles.inviteCode, { flex: 1 }]}>
                      {inviteCode ?? '-'}
                    </Text>
                    <Pressable
                      style={styles.copyBtn}
                      onPress={copyInvite}
                      disabled={!inviteCode}
                    >
                      <Text style={styles.copyBtnTxt}>
                        {copiedKey === 'invite' ? 'Copied' : 'Copy'}
                      </Text>
                    </Pressable>
                  </View>
                  {isOwner && (
                    <Pressable
                      style={[styles.secondaryBtn, lifecycleBusy && styles.btnDisabled]}
                      onPress={regenerate}
                      disabled={lifecycleBusy}
                    >
                      <Text style={styles.secondaryBtnTxt}>Reset invite code</Text>
                    </Pressable>
                  )}
                </View>

                <Text style={styles.sectionTitle}>Danger zone</Text>
                <View style={styles.card}>
                  <Pressable
                    style={[styles.dangerWideBtn, lifecycleBusy && styles.btnDisabled]}
                    onPress={leave}
                    disabled={lifecycleBusy}
                  >
                    <Text style={styles.dangerBtnTxt}>Leave group</Text>
                  </Pressable>
                  {isOwner && (
                    <Pressable
                      style={[styles.dangerWideBtn, lifecycleBusy && styles.btnDisabled]}
                      onPress={remove}
                      disabled={lifecycleBusy}
                    >
                      <Text style={styles.dangerBtnTxt}>Delete group</Text>
                    </Pressable>
                  )}
                </View>
              </>
            )}
          </>
        )}
      </KeyboardScrollView>

      <Modal visible={!!pairing} animationType="fade" transparent onRequestClose={closeModal}>
        <View style={styles.modalScrim}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>
              Pair a {pairing ? PLATFORM_LABEL[pairing.platform] : ''} group
            </Text>
            {pairing && !pairingExpired && (
              <PairingInstructions
                pairing={pairing}
                copiedKey={copiedKey}
                onCopy={copy}
              />
            )}
            {pairingExpired && (
              <Text style={styles.err}>Pairing code expired. Tap “Add bridge” to retry.</Text>
            )}
            {pairingError && <Text style={styles.err}>{pairingError}</Text>}
            <Pressable style={styles.secondaryBtn} onPress={closeModal}>
              <Text style={styles.secondaryBtnTxt}>{pairingExpired ? 'Close' : 'Cancel'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!aliasDraft}
        animationType="fade"
        transparent
        onRequestClose={() => setAliasDraft(null)}
      >
        <View style={styles.modalScrim}>
          <ScrollView contentContainerStyle={styles.modalScrollContent}>
            <View style={styles.modal}>
              <Text style={styles.modalTitle}>
                Add {aliasDraft ? PLATFORM_LABEL[aliasDraft.platform] : ''} bridge
              </Text>
              {aliasDraft && (
                <AddBridgeForm
                  draft={aliasDraft}
                  status={data?.platforms[aliasDraft.platform]}
                  onChange={setAliasDraft}
                />
              )}
              {aliasError && <Text style={styles.err}>{aliasError}</Text>}
              <View style={styles.modalActions}>
                <Pressable
                  style={[styles.secondaryBtn, styles.modalAction]}
                  onPress={() => setAliasDraft(null)}
                  disabled={aliasSubmitting}
                >
                  <Text style={styles.secondaryBtnTxt}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[styles.primaryBtn, styles.modalAction, aliasSubmitting && styles.btnDisabled]}
                  onPress={() => void submitAliasAndStartPair()}
                  disabled={aliasSubmitting}
                >
                  <Text style={styles.primaryBtnTxt}>
                    {aliasSubmitting ? 'Generating…' : 'Generate code'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={!!renameTarget} animationType="fade" transparent onRequestClose={() => setRenameTarget(null)}>
        <KeyboardModalBody>
        <View style={styles.modalScrim}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Rename bridge</Text>
            <Text style={styles.modalLead}>
              New name for{' '}
              <Text style={styles.modalInline}>{renameTarget?.alias ?? ''}</Text>.
            </Text>
            <TextInput
              value={renameDraft}
              onChangeText={(t) => setRenameDraft(t.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={renameTarget?.alias ?? ''}
              placeholderTextColor={colors.muted}
              style={styles.aliasInput}
            />
            {renameError && <Text style={styles.err}>{renameError}</Text>}
            <View style={styles.modalActions}>
              <Pressable
                style={[styles.secondaryBtn, styles.modalAction]}
                onPress={() => setRenameTarget(null)}
                disabled={renameSubmitting}
              >
                <Text style={styles.secondaryBtnTxt}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, styles.modalAction, renameSubmitting && styles.btnDisabled]}
                onPress={() => void submitRename()}
                disabled={renameSubmitting}
              >
                <Text style={styles.primaryBtnTxt}>
                  {renameSubmitting ? 'Saving…' : 'Rename'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
        </KeyboardModalBody>
      </Modal>
      <MainBottomNav current="chats" belowRoot />
    </View>
  );
}

function RuntimePill({ runtime }: { runtime: ConnectorRuntimeStatus | null }) {
  if (!runtime) {
    return <Text style={[styles.runtimePill, styles.runtimePillUnknown]}>● offline</Text>;
  }
  if (runtime.state === 'ok') {
    return <Text style={[styles.runtimePill, styles.runtimePillOk]}>● connected</Text>;
  }
  if (runtime.state === 'warn') {
    return <Text style={[styles.runtimePill, styles.runtimePillWarn]}>⚠ recovered</Text>;
  }
  if (runtime.state === 'starting') {
    return <Text style={[styles.runtimePill, styles.runtimePillStarting]}>● starting…</Text>;
  }
  return <Text style={[styles.runtimePill, styles.runtimePillError]}>● error</Text>;
}

function PlatformCard({
  platform,
  data,
  onAdd,
  onRename,
  onDisconnect,
  onCancelPending,
}: {
  platform: ConnectorPlatform;
  data: GroupConnectorsResponse;
  onAdd: () => void;
  onRename: (b: ConnectorBinding) => void;
  onDisconnect: (b: ConnectorBinding) => void;
  onCancelPending: (code: string) => void;
}) {
  const status = data.platforms[platform];
  const bindings = data.bindings.filter((b) => b.platform === platform);
  const pending = data.pending.filter((p) => p.platform === platform);
  const canAdd = status.enabled || status.byoSupported;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{PLATFORM_LABEL[platform]}</Text>
        {status.byoSupported || status.enabled ? (
          <Text style={styles.statusOn}>● available</Text>
        ) : (
          <Text style={styles.statusOff}>○ coming soon</Text>
        )}
      </View>

      {!status.byoSupported && !status.enabled && (
        <Text style={styles.muted}>
          {platform === 'slack'
            ? 'Slack needs Socket Mode for self-service bridging - coming soon.'
            : `${PLATFORM_LABEL[platform]} support hasn’t shipped yet.`}
        </Text>
      )}

      {canAdd &&
        bindings.map((binding) => (
          <View
            key={`${binding.platform}:${binding.externalChannelId}`}
            style={styles.boundRow}
          >
            <View style={{ flex: 1 }}>
              <View style={styles.aliasRow}>
                <Text style={styles.aliasPill}>{binding.alias}</Text>
                {binding.byo && <Text style={styles.byoPill}>your bot</Text>}
                <RuntimePill runtime={binding.runtime} />
                <Pressable onPress={() => onRename(binding)} hitSlop={6}>
                  <Text style={styles.linkBtn}>Rename</Text>
                </Pressable>
              </View>
              <Text style={styles.boundLabel}>Connected to</Text>
              <Text style={styles.boundValue}>
                {binding.externalDisplay ?? `chat ${binding.externalChannelId}`}
              </Text>
              <Text style={styles.boundMeta}>
                {binding.externalChannelId}
                {binding.botUsername ? ` · @${binding.botUsername}` : ''}
              </Text>
              {(binding.runtime?.state === 'error' || binding.runtime?.state === 'warn') &&
                binding.runtime.lastErrorMessage && (
                  <Text
                    style={
                      binding.runtime.state === 'error' ? styles.errMeta : styles.warnMeta
                    }
                    numberOfLines={2}
                  >
                    {binding.runtime.state === 'error' ? 'Last error: ' : 'Recent error: '}
                    {binding.runtime.lastErrorMessage}
                  </Text>
                )}
              {binding.runtime?.state === 'ok' && binding.runtime.lastSuccessAt && (
                <Text style={styles.boundMeta}>
                  Last activity: {new Date(binding.runtime.lastSuccessAt).toLocaleTimeString()}
                </Text>
              )}
            </View>
            <Pressable style={styles.dangerBtn} onPress={() => onDisconnect(binding)}>
              <Text style={styles.dangerBtnTxt}>Disconnect</Text>
            </Pressable>
          </View>
        ))}

      {pending.map((p) => (
        <View key={p.code} style={styles.boundRow}>
          <View style={{ flex: 1 }}>
            <View style={styles.aliasRow}>
              <Text style={styles.aliasPill}>pending</Text>
              <Text style={styles.boundMeta}>code {p.code}</Text>
            </View>
            <Text style={styles.boundMeta}>
              Send <Text style={{ fontFamily: 'monospace' }}>/chord pair {p.code}</Text>
              {p.botUsername ? ` to @${p.botUsername}` : ''} - expires {formatExpiry(p.expiresAt)}
            </Text>
          </View>
          <Pressable
            style={styles.dangerBtn}
            onPress={() => onCancelPending(p.code)}
            accessibilityLabel="Cancel pending pairing"
          >
            <Text style={styles.dangerBtnTxt}>✕</Text>
          </Pressable>
        </View>
      ))}

      {canAdd && (
        <Pressable style={styles.primaryBtn} onPress={onAdd}>
          <Text style={styles.primaryBtnTxt}>
            {bindings.length === 0
              ? `+ Add ${PLATFORM_LABEL[platform]} bridge`
              : `+ Add another ${PLATFORM_LABEL[platform]} bridge`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'in <1m';
  return `in ${min}m`;
}

function AddBridgeForm({
  draft,
  status,
  onChange,
}: {
  draft: AliasDraft;
  status: GroupConnectorsResponse['platforms'][ConnectorPlatform] | undefined;
  onChange: (draft: AliasDraft) => void;
}) {
  const deployWideOk = !!status?.enabled;
  const byoOk = !!status?.byoSupported;

  return (
    <>
      <Text style={styles.modalLead}>
        Short name the bot uses when relaying (&ldquo;send X to{' '}
        <Text style={styles.modalInline}>{draft.alias || draft.platform}</Text>&rdquo;). Lowercase
        letters, digits, dashes - up to 24 chars.
      </Text>
      <Text style={styles.fieldLabel}>Bridge alias</Text>
      <TextInput
        value={draft.alias}
        onChangeText={(t) =>
          onChange({ ...draft, alias: t.toLowerCase().replace(/[^a-z0-9-]/g, '') })
        }
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={draft.platform}
        placeholderTextColor={colors.muted}
        style={styles.aliasInput}
      />

      {byoOk && (
        <>
          <Text style={styles.fieldLabel}>Bot</Text>
          {deployWideOk && (
            <Pressable
              style={[styles.modeRow, !draft.useByo && styles.modeRowActive]}
              onPress={() => onChange({ ...draft, useByo: false, botToken: '' })}
            >
              <Text style={styles.modeRadio}>{!draft.useByo ? '●' : '○'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.modeLabel}>Use Chord&rsquo;s default bot</Text>
                <Text style={styles.muted}>
                  This deploy is configured with a shared {PLATFORM_LABEL[draft.platform]} bot.
                </Text>
              </View>
            </Pressable>
          )}
          <Pressable
            style={[styles.modeRow, draft.useByo && styles.modeRowActive]}
            onPress={() => onChange({ ...draft, useByo: true })}
          >
            <Text style={styles.modeRadio}>{draft.useByo ? '●' : '○'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.modeLabel}>Bring my own bot token</Text>
              <Text style={styles.muted}>
                Paste a token from a bot you own. Stored encrypted on the server.
              </Text>
            </View>
          </Pressable>

          {draft.useByo && (
            <>
              <Text style={styles.fieldLabel}>Bot token</Text>
              <TextInput
                value={draft.botToken}
                onChangeText={(t) => onChange({ ...draft, botToken: t })}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                placeholder={
                  draft.platform === 'telegram'
                    ? '123456:ABC-DEF…'
                    : draft.platform === 'discord'
                      ? 'OTk1Mzgw…'
                      : 'xoxb-…'
                }
                placeholderTextColor={colors.muted}
                style={styles.aliasInput}
              />
              <ByoInstructions platform={draft.platform} />
            </>
          )}
        </>
      )}

      {!byoOk && !deployWideOk && (
        <Text style={styles.muted}>
          {PLATFORM_LABEL[draft.platform]} isn&rsquo;t available yet on this server.
        </Text>
      )}
    </>
  );
}

function ByoInstructions({ platform }: { platform: ConnectorPlatform }) {
  if (platform === 'telegram') {
    return (
      <View style={styles.instructionsBox}>
        <Text style={styles.instructionsTitle}>Get a Telegram bot token</Text>
        <Text style={styles.instructionsStep}>
          1. Open <Text style={styles.modalInline}>@BotFather</Text> in Telegram.
        </Text>
        <Text style={styles.instructionsStep}>
          2. <Text style={styles.modalInline}>/newbot</Text> → pick a name → save the token shown.
        </Text>
        <Text style={styles.instructionsStep}>
          3. <Text style={styles.modalInline}>/setprivacy</Text> → choose your bot →{' '}
          <Text style={styles.modalInline}>Disable</Text>. (Required so the bot reads group
          messages, not just commands.)
        </Text>
        <Text style={styles.instructionsStep}>
          4. Add the bot to the Telegram group you want to bridge.
        </Text>
        <Text style={styles.instructionsStep}>
          5. Paste the token above and tap <Text style={styles.modalInline}>Generate code</Text>.
        </Text>
      </View>
    );
  }
  if (platform === 'discord') {
    return (
      <View style={styles.instructionsBox}>
        <Text style={styles.instructionsTitle}>Get a Discord bot token</Text>
        <Text style={styles.instructionsStep}>
          1. Go to{' '}
          <Text style={styles.modalInline}>discord.com/developers/applications</Text> → New
          Application → Bot.
        </Text>
        <Text style={styles.instructionsStep}>
          2. Under <Text style={styles.modalInline}>Bot</Text> → reset/copy the token.
        </Text>
        <Text style={styles.instructionsStep}>
          3. Enable Privileged Gateway Intents:{' '}
          <Text style={styles.modalInline}>Server Members</Text> +{' '}
          <Text style={styles.modalInline}>Message Content</Text>.
        </Text>
        <Text style={styles.instructionsStep}>
          4. <Text style={styles.modalInline}>OAuth2</Text> → URL Generator →{' '}
          <Text style={styles.modalInline}>bot</Text> scope, then{' '}
          <Text style={styles.modalInline}>Read Messages</Text> +{' '}
          <Text style={styles.modalInline}>Send Messages</Text>. Open the URL and invite the bot
          to your server.
        </Text>
        <Text style={styles.instructionsStep}>
          5. Paste the token above and tap <Text style={styles.modalInline}>Generate code</Text>.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.instructionsBox}>
      <Text style={styles.muted}>BYO instructions for this platform aren&rsquo;t available yet.</Text>
    </View>
  );
}

function PairingInstructions({
  pairing,
  copiedKey,
  onCopy,
}: {
  pairing: StartPairingResponse;
  copiedKey: string | null;
  onCopy: (key: string, value: string) => void;
}) {
  const platform = pairing.platform;
  const handle = pairing.botUsername;
  const stepLabel =
    platform === 'discord'
      ? 'In a Discord channel where the bot is a member, send'
      : 'In that Telegram group, send';
  const inviteHint =
    platform === 'discord'
      ? pairing.byo
        ? 'Invite your bot to the Discord server (using the OAuth URL you generated).'
        : `Invite ${handle ? `@${handle}` : 'the Chord bot'} to your Discord server.`
      : pairing.byo
        ? 'Add your bot to the Telegram group.'
        : `Add ${handle ? `@${handle}` : 'the Chord bot'} to your Telegram group.`;

  return (
    <>
      <Text style={styles.modalLead}>
        {pairing.byo ? 'Using your bot' : 'Using the default bot'} - bridge alias{' '}
        <Text style={styles.modalInline}>{pairing.alias}</Text>.
      </Text>
      <Text style={styles.modalStep}>1. {inviteHint}</Text>
      {handle && (
        <View style={styles.copyRow}>
          <Text selectable style={styles.modalBotHandle}>@{handle}</Text>
          <Pressable style={styles.copyBtn} onPress={() => onCopy('bot', `@${handle}`)}>
            <Text style={styles.copyBtnTxt}>{copiedKey === 'bot' ? 'Copied' : 'Copy'}</Text>
          </Pressable>
        </View>
      )}
      <Text style={styles.modalStep}>2. {stepLabel}</Text>
      <View style={styles.copyRow}>
        <Text selectable style={[styles.modalCode, { flex: 1 }]}>
          /chord pair {pairing.code}
        </Text>
        <Pressable
          style={styles.copyBtn}
          onPress={() => onCopy('code', `/chord pair ${pairing.code}`)}
        >
          <Text style={styles.copyBtnTxt}>{copiedKey === 'code' ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>
        Code expires {new Date(pairing.expiresAt).toLocaleTimeString()}. This screen
        updates automatically.
      </Text>
    </>
  );
}

const styles = themed((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bg },
  root: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24 },
  headerBack: { paddingHorizontal: 8, paddingVertical: 4 },
  headerBackTxt: { color: colors.accent, fontSize: 16 },
  loading: { padding: 24, alignItems: 'center' },
  err: { color: colors.red, marginVertical: 8 },
  muted: { color: colors.muted, fontSize: 13, marginTop: 4 },

  sectionTitle: { fontSize: 20, fontWeight: '700', color: colors.text, marginTop: 8 },
  sectionSub: { color: colors.muted, marginTop: 4, marginBottom: 12 },

  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center' },
  toggleLabel: { color: colors.text, fontSize: 16, fontWeight: '600' },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.border,
    padding: 2,
    justifyContent: 'center',
  },
  switchTrackOn: { backgroundColor: colors.accent },
  switchThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },
  switchThumbOn: { transform: [{ translateX: 18 }] },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  statusOn: { color: colors.green, fontSize: 12, fontWeight: '600' },
  statusOff: { color: colors.muted, fontSize: 12 },

  boundRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  boundLabel: { color: colors.muted, fontSize: 12 },
  boundValue: { color: colors.text, fontSize: 16, fontWeight: '600' },
  boundMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  aliasRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' },
  aliasPill: {
    color: colors.accent,
    backgroundColor: colors.accentLight,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontWeight: '600',
  },
  byoPill: {
    color: colors.muted,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: '600',
  },
  runtimePill: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 11,
    fontWeight: '600',
  },
  runtimePillOk: { color: colors.green, borderColor: colors.green, backgroundColor: colors.bg },
  runtimePillWarn: { color: colors.warn, borderColor: colors.warn, backgroundColor: colors.bg },
  runtimePillStarting: { color: colors.muted, borderColor: colors.border, backgroundColor: colors.bg },
  runtimePillError: { color: colors.red, borderColor: colors.red, backgroundColor: colors.bg },
  runtimePillUnknown: { color: colors.muted, borderColor: colors.border, backgroundColor: colors.bg },
  errMeta: { color: colors.red, fontSize: 12, marginTop: 4 },
  warnMeta: { color: colors.warn, fontSize: 12, marginTop: 4 },
  linkBtn: { color: colors.accent, fontSize: 12, fontWeight: '600' },
  fieldLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  aliasInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 16,
    backgroundColor: colors.bg,
  },
  modalActions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  modalAction: { flex: 1, marginTop: 0 },
  btnDisabled: { opacity: 0.5 },

  modeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginTop: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modeRowActive: {
    backgroundColor: colors.accentLight,
    borderColor: colors.accent,
  },
  modeRadio: { color: colors.accent, fontSize: 16, marginTop: 1 },
  modeLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },

  instructionsBox: {
    marginTop: 12,
    padding: 12,
    backgroundColor: colors.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  instructionsTitle: { color: colors.text, fontWeight: '700', marginBottom: 6 },
  instructionsStep: { color: colors.text, marginTop: 6, lineHeight: 19, fontSize: 13 },

  primaryBtn: {
    marginTop: 8,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryBtnTxt: { color: colors.onAccent, fontWeight: '600' },
  secondaryBtn: {
    marginTop: 12,
    backgroundColor: 'transparent',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryBtnTxt: { color: colors.text, fontWeight: '600' },
  dangerBtn: {
    marginLeft: 12,
    backgroundColor: 'transparent',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.red,
  },
  dangerBtnTxt: { color: colors.red, fontWeight: '600', fontSize: 13 },
  dangerWideBtn: {
    marginTop: 8,
    backgroundColor: 'transparent',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.red,
  },
  inviteCode: {
    color: colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 2,
  },
  inviteLink: {
    color: colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
  },

  modalScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  modalScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  modal: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    width: '100%',
    maxWidth: 480,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8 },
  modalLead: { color: colors.text, marginBottom: 12, lineHeight: 20 },
  modalStep: { color: colors.text, marginTop: 12, fontWeight: '600' },
  modalInline: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontWeight: '600',
  },
  modalBotHandle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  modalCode: {
    color: colors.text,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 14,
    paddingVertical: 4,
  },
  copyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  copyBtn: {
    backgroundColor: colors.bg,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  copyBtnTxt: { color: colors.accent, fontSize: 12, fontWeight: '600' },

  memberRow: {
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  memberName: { color: colors.text, fontWeight: '600' },
  memberMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
}));
