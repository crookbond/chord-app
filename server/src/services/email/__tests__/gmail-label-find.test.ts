import { describe, expect, it } from 'vitest';

import { findLabel } from '@/services/email/gmail-label-find.js';

describe('findLabel', () => {
  const labels = [
    { id: 'Label_1', name: 'Chord/Kids & School' },
    { id: 'Label_2', name: 'Chord/kids & school' },
  ];

  it('prefers the exact name', () => {
    expect(findLabel(labels, 'Chord/kids & school')?.id).toBe('Label_2');
  });

  it('finds a label differing only in case or spacing, as Gmail does', () => {
    expect(findLabel([labels[0]!], 'chord/kids  &  school')?.id).toBe('Label_1');
    expect(findLabel([labels[0]!], ' Chord/KIDS & SCHOOL ')?.id).toBe('Label_1');
  });

  it('does not match a different name', () => {
    expect(findLabel(labels, 'Chord/Kids')).toBeUndefined();
  });
});
