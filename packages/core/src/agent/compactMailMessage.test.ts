import { describe, expect, it } from 'vitest';
import { truncateAtWord } from './compactMailMessage.js';

describe('truncateAtWord', () => {
  it('leaves short text alone', () => {
    expect(truncateAtWord('Rate USD 1,850 per 40HC', 100)).toEqual({
      text: 'Rate USD 1,850 per 40HC',
      truncated: false,
    });
  });
  it('cuts before the word that straddles the cap so a figure is never halved', () => {
    expect(truncateAtWord('Rate USD 1,850 per 40HC to Rotterdam', 16)).toEqual({
      text: 'Rate USD 1,850',
      truncated: true,
    });
  });
  it('falls back to a hard cut when there is no usable break in the second half', () => {
    expect(truncateAtWord('x'.repeat(50), 20)).toEqual({ text: 'x'.repeat(20), truncated: true });
  });
});
