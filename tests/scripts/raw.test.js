import { describe, it, expect } from 'vitest';

import { rawCandidates } from '../../scripts/raw.js';

/**
 * findRaw()/listRaw() touch the filesystem; what is worth pinning down in a
 * test is the candidate ordering the numeric fallback depends on.
 */
describe('rawCandidates', () => {
  it('prefers zero-padded names and jpg over jpeg', () => {
    expect(rawCandidates(7)).toEqual([
      '07.jpg',
      '07.jpeg',
      '07.JPG',
      '07.JPEG',
      '7.jpg',
      '7.jpeg',
      '7.JPG',
      '7.JPEG',
    ]);
  });

  it('collapses the padding for single-digit-agnostic numbers', () => {
    // Two-digit nodes spell the same both ways; no duplicates in the list.
    const candidates = rawCandidates(43);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates[0]).toBe('43.jpg');
  });
});
