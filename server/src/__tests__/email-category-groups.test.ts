import { describe, expect, it } from 'vitest';

import {
  foldRows,
  groupCategories,
  pinnedAfterRowMove,
  setShowAll,
  toggleFold,
  type FoldState,
} from '@chord/kernel';

interface Cat {
  title: string;
  parent: string | null;
  unread: number;
}

const cat = (title: string, parent: string | null, unread = 0): Cat => ({ title, parent, unread });
const opts = (pinned: string[] = []) => ({
  titleOf: (c: Cat) => c.title,
  parentOf: (c: Cat) => c.parent,
  unreadOf: (c: Cat) => c.unread,
  pinned,
});
const empty: FoldState = { folded: {}, showAll: [] };
const active = (c: Cat) => c.unread > 0;

// The mailbox the design was drawn against.
const mailbox = [
  cat('Ms. Park class', 'School', 3),
  cat('Orders', 'Shopping', 2),
  cat('PTA', 'School', 1),
  cat('Deliveries', 'Shopping', 1),
  cat('Bills', 'Finance', 1),
  cat('Lunch menu', 'School'),
  cat('Sports', 'School'),
  cat('Receipts', 'Shopping'),
  cat('Coupons', 'Shopping'),
  cat('Returns', 'Shopping'),
  cat('Bank', 'Finance'),
  cat('Flights', 'Travel'),
  cat('Hotels', 'Travel'),
];

const keys = (pinned: string[] = []) => groupCategories(mailbox, opts(pinned)).map((g) => g.key);

describe('groupCategories', () => {
  it('groups subcategories under their parent, unread groups first', () => {
    const groups = groupCategories(mailbox, opts());
    expect(groups.map((g) => [g.key, g.unread])).toEqual([
      ['School', 4],
      ['Shopping', 3],
      ['Finance', 1],
      ['Travel', 0],
    ]);
    expect(groups[0].items.map((c) => c.title)).toEqual(['Ms. Park class', 'PTA', 'Lunch menu', 'Sports']);
  });

  it('pins a group by its parent title', () => {
    expect(keys(['Finance'])).toEqual(['Finance', 'School', 'Shopping', 'Travel']);
  });

  it('keeps an order saved before grouping: a pinned subcategory pins its group', () => {
    expect(keys(['Bills', 'Deliveries'])).toEqual(['Finance', 'Shopping', 'School', 'Travel']);
  });

  it('never puts a pinned read group above one with unread mail', () => {
    expect(keys(['Travel'])).toEqual(['School', 'Shopping', 'Finance', 'Travel']);
  });

  it('orders inside a group by the user pins, unread still first', () => {
    const school = groupCategories(mailbox, opts(['Sports', 'PTA']))[0];
    expect(school.items.map((c) => c.title)).toEqual(['PTA', 'Ms. Park class', 'Sports', 'Lunch menu']);
  });

  it('a category with no parent is a group of its own', () => {
    const groups = groupCategories([cat('Unsorted', null, 1), ...mailbox], opts());
    expect(groups.find((g) => g.key === 'Unsorted')?.items).toHaveLength(1);
  });
});

describe('foldRows', () => {
  const rows = (state = empty) =>
    foldRows(groupCategories(mailbox, opts()), active, state).map((r) => {
      if (r.kind === 'head') return `${r.folded ? '>' : 'v'} ${r.key}`;
      if (r.kind === 'more') return `+${r.hidden} ${r.key}`;
      if (r.kind === 'fewer') return `- ${r.key}`;
      return `  ${r.item.title}`;
    });

  it('shows what needs the user and folds the rest', () => {
    expect(rows()).toEqual([
      'v School',
      '  Ms. Park class',
      '  PTA',
      '+2 School',
      'v Shopping',
      '  Orders',
      '  Deliveries',
      '+3 Shopping',
      'v Finance',
      '  Bills',
      '+1 Finance',
      '> Travel',
    ]);
  });

  it('opens a group by hand and lists everything in it', () => {
    const groups = groupCategories(mailbox, opts());
    const base = foldRows(groups, active, empty);
    const state = toggleFold(empty, base, 'Travel');
    expect(rows(state).slice(-3)).toEqual(['v Travel', '  Flights', '  Hotels']);
    expect(rows(toggleFold(state, foldRows(groups, active, state), 'Travel')).at(-1)).toBe('> Travel');
  });

  it('opens and closes the "+ N more" row', () => {
    const state = setShowAll(empty, 'Finance', true);
    expect(rows(state).slice(8, 12)).toEqual(['v Finance', '  Bills', '  Bank', '- Finance']);
    expect(rows(setShowAll(state, 'Finance', false))).toEqual(rows());
  });

  it('a group of one is the card alone, with no header', () => {
    const r = foldRows(groupCategories([cat('Unsorted', null, 1)], opts()), active, empty);
    expect(r.map((x) => x.kind)).toEqual(['solo']);
  });
});

describe('pinnedAfterRowMove', () => {
  const groups = groupCategories(mailbox, opts());
  const rows = foldRows(groups, active, empty);
  const at = (label: string) =>
    rows.findIndex((r) => (r.kind === 'head' ? r.key : r.kind === 'item' ? r.item.title : '') === label);
  const move = (label: string, to: number) =>
    pinnedAfterRowMove(rows, groups, (c) => c.title, at(label), to, []);

  it('dragging a header to the top moves the whole group there', () => {
    const pinned = move('Finance', 0)!;
    expect(pinned).toEqual(['Finance']);
    expect(groupCategories(mailbox, opts(pinned)).map((g) => g.key)).toEqual([
      'Finance',
      'School',
      'Shopping',
      'Travel',
    ]);
  });

  it('dropping a header inside another group puts it after that group', () => {
    // School's header dropped among Shopping's rows.
    expect(move('School', at('Deliveries') - 1)).toEqual(['Shopping', 'School']);
  });

  it('dragging a subcategory reorders only inside its group', () => {
    const pinned = move('Deliveries', at('Orders') - 1)!;
    const after = groupCategories(mailbox, opts(pinned));
    expect(after.map((g) => g.key)).toEqual(['School', 'Shopping', 'Finance', 'Travel']);
    expect(after[1].items.slice(0, 2).map((c) => c.title)).toEqual(['Deliveries', 'Orders']);
  });

  it('a subcategory dropped outside its group stays at that end of it', () => {
    const pinned = move('PTA', 0)!;
    expect(groupCategories(mailbox, opts(pinned))[0].items.slice(0, 2).map((c) => c.title)).toEqual([
      'PTA',
      'Ms. Park class',
    ]);
  });

  it('a drop that changes nothing saves nothing', () => {
    expect(move('Finance', at('Finance'))).toBeNull();
    expect(pinnedAfterRowMove(rows, groups, (c) => c.title, rows.findIndex((r) => r.kind === 'more'), 0, [])).toBeNull();
  });
});
