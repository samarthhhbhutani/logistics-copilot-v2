import { describe, expect, it } from 'vitest';
import { isEmailMediaHeightIndependent } from './emailMedia.js';

describe('email media height independence', () => {
  it.each([
    '(max-height: 400px)',
    '(orientation: portrait)',
    '(min-aspect-ratio: 1/1)',
    '(min-width: 100vh)',
    '(min-width: 100dvh)',
    '(min-width: 100cqh)',
    String.raw`(max-h\65 ight: 400px)`,
    String.raw`(min-width: 100v\68)`,
  ])('rejects height-dependent or escaped conditions: %s', (condition) => {
    expect(isEmailMediaHeightIndependent(condition)).toBe(false);
  });

  it.each(['', '(max-width: 600px)', '(min-width: 1px)', '(min-resolution: 2dppx)', '100vw'])(
    'preserves height-independent conditions and sizes: %s',
    (condition) => {
      expect(isEmailMediaHeightIndependent(condition)).toBe(true);
    },
  );
});
