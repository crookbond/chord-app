import { greetingName, type Group, type User } from '@chord/kernel';

type GroupLike = Pick<Group, 'name' | 'kind'> & Pick<Partial<Group>, 'counterpartName'>;

/**
 * Display title for a group in chat headers and the chat list.
 *
 * A personal group derives its label from the current user's preferred name so
 * it tracks name changes instantly, rather than the name frozen at
 * group-creation time.
 *
 * A two-person chat nobody has named shows the other person, because that is
 * how you think of the conversation — the server sends `counterpartName` only
 * when that applies (two members, shared, never renamed), so the rule lives
 * next to the membership it needs rather than being re-derived here. Naming
 * the chat wins from then on.
 */
export function groupTitle(group: GroupLike, user: User | null | undefined): string {
  if (group.kind === 'personal' && user) return `${greetingName(user)} · My Chord`;
  return group.counterpartName || group.name;
}

/**
 * Short group label for compact chips (catchup tasks/lists/saves). Same
 * source as {@link groupTitle} but without the "· My Chord" suffix.
 */
export function groupChipName(group: GroupLike, user: User | null | undefined): string {
  if (group.kind === 'personal' && user) return greetingName(user);
  return group.counterpartName || group.name;
}
