import { describe, expect, it } from 'vitest';

import { isSelfReference } from '../self-reference.js';

describe('isSelfReference', () => {
  it.each([
    '/personal',
    'Personal',
    'personal calendar',
    'my calendar',
    'my own default calendar',
    'just me',
    'only me',
    'me',
    'mine',
    'Primary',
    'my personal calendar',
  ])('%s means the asker', (name) => {
    expect(isSelfReference(name)).toBe(true);
  });

  it.each(['Doe Family', 'my family', 'family calendar', 'Personal Projects', 'work', 'the group', 'calendar', ''])(
    '%s does not',
    (name) => {
      expect(isSelfReference(name)).toBe(false);
    },
  );
});
