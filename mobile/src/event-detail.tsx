/**
 * The read view of a calendar event (ADR 0331): what tapping an event shows
 * before anything is editable. Join buttons for its video call, the place as
 * a map link, and the description formatted with its links tappable.
 *
 * The description is drawn from `eventDescriptionBlocks` (kernel) as ordinary
 * text, never as HTML, so a description can carry links but cannot run
 * anything or load anything.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import {
  eventDescriptionBlocks,
  eventJoinLinks,
  eventPlaceLink,
  type GroupEvent,
} from '@chord/kernel';

import { getEventGuests } from '@/api';
import { openExternal } from '@/link-chip';
import { colors, themed } from '@/theme';

/** Paragraphs shown before "Show more": invites paste whole pages of boilerplate. */
const FOLDED_BLOCKS = 6;

export function EventDetail({
  event,
  guests,
}: {
  event: GroupEvent;
  /** The guest box (list, answers, the viewer's own invitation), shown above the description. */
  guests?: ReactNode | ((ctx: { hasVideoCall: boolean }) => ReactNode);
}) {
  const [videoCallLink, setVideoCallLink] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    setVideoCallLink(null);
    setExpanded(false);
    void getEventGuests(event.id)
      .then((r) => {
        if (live) setVideoCallLink(r.videoCallLink ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [event.id]);

  const joins = useMemo(
    () => eventJoinLinks({ videoCallLink, location: event.location, description: event.description }),
    [videoCallLink, event.location, event.description],
  );
  const place = useMemo(() => eventPlaceLink(event.location), [event.location]);
  const blocks = useMemo(
    () => eventDescriptionBlocks(event.description, { title: event.title }),
    [event.description, event.title],
  );
  const shown = expanded ? blocks : blocks.slice(0, FOLDED_BLOCKS);
  const guestBox = typeof guests === 'function' ? guests({ hasVideoCall: joins.length > 0 }) : guests;

  return (
    <View>
      {joins.length > 0 ? (
        <View style={styles.joinRow}>
          {joins.map((j) => (
            <Pressable
              key={j.url}
              style={styles.joinBtn}
              accessibilityRole="link"
              accessibilityLabel={j.label}
              onPress={() => openExternal(j.url)}
            >
              <MaterialCommunityIcons name="video" size={16} color={colors.onAccent} />
              <Text style={styles.joinTxt}>{j.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {place ? (
        <View style={styles.row}>
          <MaterialCommunityIcons
            name={place.isMap ? 'map-marker-outline' : 'link-variant'}
            size={18}
            color={colors.muted}
            style={styles.icon}
          />
          <Text
            style={[styles.body, styles.link]}
            accessibilityRole="link"
            onPress={() => openExternal(place.url)}
          >
            {place.label}
          </Text>
        </View>
      ) : null}

      {event.meetingContext ? (
        <View style={styles.row}>
          <MaterialCommunityIcons name="text-box-outline" size={18} color={colors.muted} style={styles.icon} />
          <Text style={[styles.body, styles.muted]}>{event.meetingContext}</Text>
        </View>
      ) : null}

      {guestBox}

      {blocks.length > 0 ? (
        <View style={styles.description}>
          <Text style={styles.sectionLabel}>NOTES</Text>
          {shown.map((b, i) => (
            <View key={i} style={b.kind === 'li' ? styles.li : styles.p}>
              {b.kind === 'li' ? <Text style={styles.body}>•  </Text> : null}
              <Text style={[styles.body, { flex: 1 }]} selectable>
                {b.runs.map((r, j) =>
                  r.href ? (
                    <Text
                      key={j}
                      style={[styles.link, r.bold && styles.bold]}
                      accessibilityRole="link"
                      onPress={() => openExternal(r.href!)}
                    >
                      {r.text}
                    </Text>
                  ) : (
                    <Text key={j} style={r.bold ? styles.bold : undefined}>
                      {r.text}
                    </Text>
                  ),
                )}
              </Text>
            </View>
          ))}
          {blocks.length > FOLDED_BLOCKS ? (
            <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={8}>
              <Text style={styles.more}>{expanded ? 'Show less' : `Show more (${blocks.length - FOLDED_BLOCKS})`}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = themed((colors) => ({
  joinRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  joinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.accent,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  joinTxt: { color: colors.onAccent, fontWeight: '600', fontSize: 14 },
  row: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'flex-start' },
  icon: { width: 20, marginTop: 1 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  muted: { color: colors.muted },
  link: { color: colors.accent, textDecorationLine: 'underline' },
  bold: { fontWeight: '700' },
  sectionLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 8 },
  description: {
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  p: { marginBottom: 8 },
  li: { flexDirection: 'row', marginBottom: 4, paddingLeft: 4 },
  more: { color: colors.accent, fontWeight: '600', fontSize: 13, marginTop: 2 },
}));
