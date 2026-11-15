import { describe, expect, it } from 'vitest';
import { sentCopySearchQuery } from './gmailMessages.js';

describe('sentCopySearchQuery', () => {
  it('strips the angle brackets of the Message-ID and leaves the rest alone', () => {
    expect(sentCopySearchQuery('<11111111-1111-4111-8111-111111111111@acme.com>')).toBe(
      'rfc822msgid:11111111-1111-4111-8111-111111111111@acme.com',
    );
    expect(sentCopySearchQuery('bare@acme.com')).toBe('rfc822msgid:bare@acme.com');
  });
});
