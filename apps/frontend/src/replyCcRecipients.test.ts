import { describe, expect, it } from 'vitest';
import { parseReplyCc } from './replyCcRecipients.js';

describe('parseReplyCc', () => {
  it('reads bare and named addresses split by commas, semicolons or line breaks, once each', () => {
    expect(
      parseReplyCc(
        ' priya@example.com, Vikram Joshi <vikram@example.com>;\n"Ops" <ops@example.com>, PRIYA@example.com,, ',
      ),
    ).toEqual({
      recipients: [
        { name: '', address: 'priya@example.com' },
        { name: 'Vikram Joshi', address: 'vikram@example.com' },
        { name: 'Ops', address: 'ops@example.com' },
      ],
    });
    expect(parseReplyCc('')).toEqual({ recipients: [] });
  });

  it('names the entry that is not an address, and refuses more than the API accepts', () => {
    expect(parseReplyCc('priya@example.com, vikram.example.com')).toEqual({
      problem: '"vikram.example.com" is not an email address.',
    });
    expect(parseReplyCc('Vikram <not an address>')).toEqual({
      problem: '"not an address" is not an email address.',
    });
    const eleven = Array.from({ length: 11 }, (_, index) => `cc${index}@example.com`).join(', ');
    expect(parseReplyCc(eleven)).toEqual({ problem: 'Cc can take at most 10 addresses.' });
  });
});
