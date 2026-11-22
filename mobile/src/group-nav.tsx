import { router } from 'expo-router';
import { Image, Pressable, Text, View } from 'react-native';
import { emitTabReselect } from '@/tab-reselect';
import { useAndroidBottomInset } from '@/system-bars';

import { Icon, type IconName } from '@/email-reader-bar';
import { colors, themed } from '@/theme';

// Gender-neutral family (two adults, two kids) in the MCI silhouette style -
// the font has no four-figure glyph, so it ships as a pair of PNGs (one per
// tab state) like the sign-in logos; scripts can regenerate them.
// Metro resolves image assets only through require().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FAMILY_TAB = require('../assets/family-tab.png');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FAMILY_TAB_ACTIVE = require('../assets/family-tab-active.png');

// ─── Top-level 4-tab nav ──────────────────────────────────────────────
//
// Single bottom bar across every top-level screen: Action Items, Email,
// Messages (the centre tab), Calendar, Settings. Email is where a
// launch lands (ADR 0254). The per-group "resources" tabs (tasks / lists /
// saves / trips / events) are gone - those views are strictly per-user
// merged across groups and live under Catchup or Calendar now.
//
// The `chats` key and the /groups/* routes keep their names - only the label
// moved, so deep links and ADR 0059 search hrefs are unaffected.

export type MainTab = 'email' | 'chats' | 'catchup' | 'calendar' | 'settings';

/**
 * Where a signed-in launch lands (ADR 0254 addendum 2026-10-27): Email on
 * every platform.
 */
export function launchTab(): '/email' {
  return '/email';
}

const MAIN_TABS: Array<{
  key: MainTab;
  label: string;
  icon?: string;
  iconName?: IconName;
  family?: boolean;
}> = [
  { key: 'catchup', label: 'Action Items', icon: '⚡' },
  { key: 'email', label: 'Email', icon: '✉' },
  { key: 'chats', label: 'Messages', family: true },
  { key: 'calendar', label: 'Calendar', icon: '📅' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
];

export function MainBottomNav({
  current,
  onEmailLongPress,
  belowRoot = false,
}: {
  current: MainTab;
  /**
   * The screen is a drill-down inside its tab (a chat, its settings). Tapping
   * the tab again then goes back to the tab's own first screen instead of
   * being a reselect on the screen in front.
   */
  belowRoot?: boolean;
  /** ADR 0083 - long-press Email opens the folder sheet. */
  onEmailLongPress?: () => void;
}) {
  const bottomInset = useAndroidBottomInset();
  const goTo = (tab: MainTab) => {
    // Action Items has no chip in the sub-tab strip, so its bottom tab is the
    // way back to it from Tasks / Lists / etc.
    if (tab === current && belowRoot && tab === 'chats') {
      if (router.canGoBack()) router.dismissTo('/groups');
      else router.replace('/groups');
      return;
    }
    if (tab === current) {
      emitTabReselect(tab);
      if (tab !== 'catchup') return;
    }
    // A tab is the whole stack. Tapped while a screen above it is still
    // sliding away (back from an email), a bare replace swapped that leaving
    // screen for the new tab, and the native pop that was already under way
    // then removed the new tab too - Messages showed for a moment, then
    // Email. Emptying the stack first leaves nothing for that pop to take.
    if (router.canDismiss()) router.dismissAll();
    switch (tab) {
      case 'email':
        router.replace('/email');
        return;
      case 'chats':
        router.replace('/groups');
        return;
      case 'catchup':
        router.replace({ pathname: '/catchup/[tab]', params: { tab: 'actions' } });
        return;
      case 'calendar':
        router.replace('/calendar');
        return;
      case 'settings':
        router.replace('/settings');
        return;
    }
  };

  return (
    <View
      style={[
        styles.wrap,
        // Android draws edge-to-edge, so its system navigation bar sits on top
        // of the app; without this the back/home buttons cover the tabs.
        { paddingBottom: 10 + bottomInset },
      ]}
    >
      <View style={styles.row}>
        {MAIN_TABS.map((item) => {
          const active = current === item.key;
          return (
            <Pressable
              key={item.key}
              onPress={() => goTo(item.key)}
              onLongPress={
                item.key === 'email' && onEmailLongPress
                  ? onEmailLongPress
                  : undefined
              }
              delayLongPress={350}
              style={[styles.item, active && styles.itemActive]}
            >
              {item.family ? (
                <Image
                  source={active ? FAMILY_TAB_ACTIVE : FAMILY_TAB}
                  style={styles.familyIcon}
                  resizeMode="contain"
                />
              ) : item.iconName ? (
                <Icon
                  name={item.iconName}
                  size={22}
                  color={active ? colors.accent : colors.muted}
                />
              ) : (
                <Text style={[styles.icon, active && styles.iconActive]}>{item.icon}</Text>
              )}
              <Text
                numberOfLines={2}
                allowFontScaling={false}
                style={[styles.label, active && styles.labelActive]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ─── To Do's sub-tabs ─────────────────────────────────────────────────
//
// Top chip strip inside /catchup/[tab] (the route segment keeps the historic
// `catchup` name so search-card hrefs like /catchup/files stay valid -
// ADR 0059/0070). Events are not here - they live in /calendar. Action Items
// (pending email-magic suggestions) is what the bottom tab opens, so it has no
// chip of its own. Findings (ADR 0249; the key stays `finance` so old links
// resolve) holds questions to ask about your mail and the receipts read from it.

export type CatchupTab =
  | 'actions'
  | 'tasks'
  | 'lists'
  | 'saves'
  | 'trips'
  | 'finance'
  | 'files';

const CATCHUP_TABS: Array<{
  key: CatchupTab;
  label: string;
  icon: string;
  hidden?: boolean;
}> = [
  { key: 'actions', label: 'Action Items', icon: '⚡', hidden: true },
  { key: 'tasks', label: 'Tasks', icon: '✓' },
  { key: 'lists', label: 'Lists', icon: '☰' },
  { key: 'saves', label: 'Saves', icon: '🔖' },
  { key: 'trips', label: 'Trips', icon: '✈' },
  { key: 'finance', label: 'Findings', icon: '💡' },
  { key: 'files', label: 'Attachments', icon: '📎' },
];

export function defaultCatchupTab(): CatchupTab {
  return 'actions';
}

export function normalizeCatchupTab(raw: string | string[] | undefined): CatchupTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && CATCHUP_TABS.some((t) => t.key === value)) return value as CatchupTab;
  return defaultCatchupTab();
}

export function catchupTabLabel(tab: CatchupTab): string {
  return CATCHUP_TABS.find((t) => t.key === tab)?.label ?? 'Action Items';
}

export function CatchupTopTabs({ current }: { current: CatchupTab }) {
  return (
    <View style={styles.chipsRow}>
      {CATCHUP_TABS.filter((item) => !item.hidden).map((item) => {
        const active = current === item.key;
        return (
          <Pressable
            key={item.key}
            onPress={() => {
              if (item.key === current) return;
              router.replace({ pathname: '/catchup/[tab]', params: { tab: item.key } });
            }}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>
              {item.icon}  {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = themed((colors) => ({
  wrap: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    paddingTop: 6,
    paddingBottom: 10,
  },
  row: {
    flexDirection: 'row',
    paddingHorizontal: 6,
    gap: 2,
  },
  item: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 6,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 2,
  },
  itemActive: {
    backgroundColor: colors.accentLight,
  },
  icon: {
    fontSize: 16,
    color: colors.muted,
  },
  familyIcon: {
    width: 21,
    height: 22,
  },
  iconActive: {
    color: colors.accent,
  },
  label: {
    fontSize: 11,
    color: colors.muted,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.2,
    textAlign: 'center',
  },
  labelActive: {
    color: colors.accent,
  },

  chipsRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 6,
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: {
    backgroundColor: colors.accentLight,
    borderColor: colors.accent,
  },
  chipTxt: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: '600',
  },
  chipTxtActive: {
    color: colors.accent,
  },
}));
