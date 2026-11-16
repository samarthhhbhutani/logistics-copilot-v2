import { describe, expect, it } from 'vitest';
import { inReplyToMessageId } from './inReplyToMessageId.js';

describe('inReplyToMessageId', () => {
  it('returns the bracketed Message-ID of the mail replied to', () => {
    expect(inReplyToMessageId({ inReplyTo: ' <a@desk.com> ' })).toBe('<a@desk.com>');
  });

  it('is undefined when the header is missing or not a bracketed Message-ID', () => {
    expect(inReplyToMessageId({ inReplyTo: undefined })).toBeUndefined();
    expect(inReplyToMessageId({ inReplyTo: 'a@desk.com' })).toBeUndefined();
  });
});
