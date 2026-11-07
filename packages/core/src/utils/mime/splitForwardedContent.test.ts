import { describe, expect, it } from 'vitest';
import { readEmailFixture } from './fixtures.test-helper.js';
import { parseRawEmail } from './parseRawEmail.js';
import { splitForwardedContent } from './splitForwardedContent.js';

describe('splitForwardedContent', () => {
  it('Gmail forward: separates the forwarder note from the original message and reads its header', async () => {
    const parsed = await parseRawEmail(readEmailFixture('gmailForwardedMessage.eml'));
    const split = splitForwardedContent(parsed.text, parsed.subject);
    expect(split).toBeDefined();
    expect(split?.forwarderNote).toBe(
      "Please see the customer's request below and advise your best rate by tomorrow.",
    );
    expect(split?.originalMessage.from).toEqual({
      name: 'Priya Nair',
      address: 'priya.nair@suntextiles.example',
    });
    expect(split?.originalMessage.subject).toBe('Rate request - 2 x 40HC Nhava Sheva to Rotterdam');
    expect(split?.originalMessage.date).toBeDefined();
    expect(split?.originalMessage.body).toBe(
      'Hi team,\n\nWe need a quotation for 2 x 40HC from Nhava Sheva to Rotterdam, cargo ready 15 Nov.',
    );
  });

  it('returns undefined for a reply that only quotes history', async () => {
    const parsed = await parseRawEmail(readEmailFixture('gmailReplyChainHtml.eml'));
    expect(splitForwardedContent(parsed.text, parsed.subject)).toBeUndefined();
  });

  it('returns undefined for a plain request and for an empty body', async () => {
    const parsed = await parseRawEmail(readEmailFixture('gmailPlainTextRequest.eml'));
    expect(splitForwardedContent(parsed.text, parsed.subject)).toBeUndefined();
    expect(splitForwardedContent('')).toBeUndefined();
  });
});
