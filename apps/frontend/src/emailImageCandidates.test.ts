import { describe, expect, it, vi } from 'vitest';
import { parseEmailImageCandidates, sanitizeEmailImageCandidates } from './emailImageCandidates.js';

describe('email image candidates', () => {
  it('parses density, width, default density, whitespace and trailing delimiters', () => {
    expect(
      parseEmailImageCandidates(
        ' , https://img.example/a, https://img.example/b 2x,\n https://img.example/c .5x,',
      ),
    ).toEqual([
      { url: 'https://img.example/a', descriptor: '1x' },
      { url: 'https://img.example/b', descriptor: '2x' },
      { url: 'https://img.example/c', descriptor: '0.5x' },
    ]);
    expect(parseEmailImageCandidates('cid:small 400w, cid:large 0800w')).toEqual([
      { url: 'cid:small', descriptor: '400w' },
      { url: 'cid:large', descriptor: '800w' },
    ]);
  });
  it('keeps commas and percent encoding inside URL tokens', () => {
    expect(
      parseEmailImageCandidates('https://img.example/a,b?sig=%2F 1x, https://img.example/c 2x')[0]
        ?.url,
    ).toBe('https://img.example/a,b?sig=%2F');
    expect(
      parseEmailImageCandidates('data:image/png;base64,abc 1x, https://img.example/good 2x'),
    ).toHaveLength(2);
  });
  it.each([
    '0x',
    '-1x',
    'Infinityx',
    'NaNx',
    '1e999x',
    '0w',
    '-2w',
    '1.5w',
    '9007199254740993w',
    '1x 2x',
    '300w 1x',
    '(bad, descriptor)',
    '2h',
    '1X',
  ])('drops invalid descriptor %s without losing the next candidate', (descriptor) => {
    expect(
      parseEmailImageCandidates(
        `https://img.example/bad ${descriptor}, https://img.example/good 2x`,
      ),
    ).toEqual([{ url: 'https://img.example/good', descriptor: '2x' }]);
  });
  it('validates and deduplicates descriptors before resolving any URLs', () => {
    const resolve = vi.fn((url: string) => (url.startsWith('cid:') ? undefined : url));
    expect(sanitizeEmailImageCandidates('cid:unused 400w, https://img.example/b 2x', resolve)).toBe(
      '',
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(
      sanitizeEmailImageCandidates(
        'cid:first 1x, https://img.example/duplicate 1x, https://img.example/b 2x',
        resolve,
      ),
    ).toBe('https://img.example/b 2x');
    expect(resolve.mock.calls.map(([url]) => url)).toEqual(['cid:first', 'https://img.example/b']);
  });
  it('removes unsafe URLs per candidate, rejects mixed dimensions and deduplicates density', () => {
    const resolve = (url: string) => (url.startsWith('https://') ? url : undefined);
    expect(
      sanitizeEmailImageCandidates('javascript:alert(1) 1x, https://img.example/good 2x', resolve),
    ).toBe('https://img.example/good 2x');
    expect(
      sanitizeEmailImageCandidates('https://img.example/a 1x, https://img.example/b 1x', resolve),
    ).toBe('https://img.example/a 1x');
    expect(
      sanitizeEmailImageCandidates('https://img.example/a 400w, https://img.example/b 2x', resolve),
    ).toBe('');
    expect(sanitizeEmailImageCandidates('cid:one 1x', () => 'https://img.example/a,')).toBe('');
    expect(sanitizeEmailImageCandidates('cid:one 1x', () => 'https://img.example/a 2x,evil')).toBe(
      '',
    );
  });
});
