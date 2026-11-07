import { describe, expect, it } from 'vitest';
import { extractNewContent } from './extractNewContent.js';
import { readEmailFixture } from './fixtures.test-helper.js';
import { parseRawEmail } from './parseRawEmail.js';

async function bodyTextOf(fixture: string): Promise<string> {
  return (await parseRawEmail(readEmailFixture(fixture))).text;
}

describe('extractNewContent when the quoted message is known', () => {
  const options = { quotedMessageKnown: true };

  it('Gmail reply: drops the "On ... wrote:" history, keeps the bare-name sign-off', async () => {
    expect(extractNewContent(await bodyTextOf('gmailReplyChainHtml.eml'), options)).toBe(
      'Thanks Priya, noted.\n\nCan you confirm whether the cargo is palletised and the exact pickup address in Bhiwandi?\n\nRahul',
    );
  });

  it('Outlook desktop: drops "-----Original Message-----" and the "Best regards," signature', async () => {
    expect(extractNewContent(await bodyTextOf('outlookOriginalMessageQuote.eml'), options)).toBe(
      'Dear Rahul,\n\nPlease find our rates below \u2013 valid till 30 Nov:\n\nNhava Sheva \u2013 Rotterdam, 40HC: USD 1,850 all-in, 24 days via Colombo.',
    );
  });

  it('Outlook web: drops the underscore rule and the From/Sent/To/Subject run', async () => {
    expect(extractNewContent(await bodyTextOf('outlookWebHeaderRunQuote.eml'), options)).toBe(
      'Rahul,\n\nYes the cargo is palletised, 20 pallets. Pickup from Plot 14, Sonale MIDC, Bhiwandi 421302.\n\nPriya',
    );
  });

  it('iPhone: drops "Sent from my iPhone" and the ">" quoted lines', async () => {
    expect(extractNewContent(await bodyTextOf('iphoneReplyQuotedLines.eml'), options)).toBe(
      'Is the 18,000 kg gross or net? And do you need door delivery in Rotterdam or CY only?',
    );
  });

  it('two-line "On <date>, <name>\\n<address> wrote:" header and the "-- " delimiter', async () => {
    expect(
      extractNewContent(await bodyTextOf('twoLineOnWroteSignatureDelimiter.eml'), options),
    ).toBe(
      'Hi Rahul,\n\nUSD 1,790 per 40HC all-in to Rotterdam, 26 days via Jebel Ali, valid till 20 Nov.\nIncludes THC origin; destination charges at actuals.',
    );
  });

  it('never cuts a forwarded message: the original is new to us', async () => {
    const newContent = extractNewContent(await bodyTextOf('gmailForwardedMessage.eml'), options);
    expect(newContent).toContain('---------- Forwarded message ---------');
    expect(newContent).toContain('We need a quotation for 2 x 40HC from Nhava Sheva to Rotterdam');
  });
});

describe('extractNewContent when the quoted message is unknown (default)', () => {
  it('keeps the "On ... wrote:" history of a Gmail reply', async () => {
    const newContent = extractNewContent(await bodyTextOf('gmailReplyChainHtml.eml'));
    expect(newContent).toContain('Thanks Priya, noted.');
    expect(newContent).toMatch(/^On .* wrote:$/m);
    expect(newContent).toMatch(/^> /m);
  });

  it('keeps the "-----Original Message-----" block of an Outlook reply', async () => {
    const newContent = extractNewContent(await bodyTextOf('outlookOriginalMessageQuote.eml'));
    expect(newContent).toContain('-----Original Message-----');
  });

  it('keeps the ">" quoted lines of an iPhone reply', async () => {
    expect(extractNewContent(await bodyTextOf('iphoneReplyQuotedLines.eml'))).toMatch(/^> /m);
  });

  it('still drops the signature', async () => {
    const newContent = extractNewContent(await bodyTextOf('gmailPlainTextRequest.eml'));
    expect(newContent.endsWith('Please share your best rates and transit time.')).toBe(true);
    expect(newContent).not.toContain('Priya Nair');
  });
});

describe('extractNewContent edge cases', () => {
  it('returns an empty string for an empty body', async () => {
    expect(extractNewContent(await bodyTextOf('noDateFoldedHeadersEmptyBody.eml'))).toBe('');
    expect(extractNewContent('')).toBe('');
  });

  it('collapses runs of blank lines and trailing whitespace', () => {
    expect(extractNewContent('Hello  \n\n\n\nWorld\n\n\n')).toBe('Hello\n\nWorld');
  });
});
