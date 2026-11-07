import { describe, expect, it } from 'vitest';
import { readEmailFixture } from './fixtures.test-helper.js';
import { decodeGmailRawMessage, parseRawEmail } from './parseRawEmail.js';

describe('parseRawEmail', () => {
  it('reads a plain Gmail customer request: addresses, subject, date, text, no attachments', async () => {
    const email = await parseRawEmail(readEmailFixture('gmailPlainTextRequest.eml'));
    expect(email.messageId).toBe('<CAF+1a2b3c4d5e6f@mail.gmail.com>');
    expect(email.from).toEqual({ name: 'Priya Nair', address: 'priya.nair@suntextiles.example' });
    expect(email.to).toEqual([{ name: '', address: 'ops@bhatiashipping.example' }]);
    expect(email.subject).toBe('Rate request - 2 x 40HC Nhava Sheva to Rotterdam');
    expect(email.date?.toISOString()).toBe('2025-11-03T12:11:52.000Z');
    expect(email.text).toContain('2 x 40HC from Nhava Sheva to Rotterdam');
    expect(email.html).toBeUndefined();
    expect(email.attachments).toEqual([]);
    expect(email.headers['delivered-to']).toBe('ops@bhatiashipping.example');
  });

  it('decodes a quoted-printable Gmail reply with both parts and threading headers', async () => {
    const email = await parseRawEmail(readEmailFixture('gmailReplyChainHtml.eml'));
    expect(email.inReplyTo).toBe('<CAF+1a2b3c4d5e6f@mail.gmail.com>');
    expect(email.cc).toEqual([{ name: '', address: 'accounts@suntextiles.example' }]);
    expect(email.text).toContain('palletised and the exact pickup address in Bhiwandi');
    expect(email.html).toContain('class="gmail_quote"');
  });

  it('decodes windows-1252 quoted-printable from Outlook desktop (en dash survives)', async () => {
    const email = await parseRawEmail(readEmailFixture('outlookOriginalMessageQuote.eml'));
    expect(email.text).toContain('Nhava Sheva \u2013 Rotterdam, 40HC: USD 1,850 all-in');
    expect(email.inReplyTo).toBe('<rfq-2025-0142.1@bhatiashipping.example>');
  });

  it('decodes base64 text parts from Outlook web', async () => {
    const email = await parseRawEmail(readEmailFixture('outlookWebHeaderRunQuote.eml'));
    expect(email.text).toContain('Plot 14, Sonale MIDC, Bhiwandi 421302');
    expect(email.inReplyTo).toBe('<CAFreply0001@mail.gmail.com>');
  });

  it('extracts a PDF attachment with its bytes, name, type and size', async () => {
    const email = await parseRawEmail(readEmailFixture('pdfAttachmentPackingList.eml'));
    expect(email.attachments).toHaveLength(1);
    const [packingList] = email.attachments;
    expect(packingList?.fileName).toBe('Packing_List_GE-4471.pdf');
    expect(packingList?.contentType).toBe('application/pdf');
    expect(packingList?.isInline).toBe(false);
    expect(packingList?.sizeBytes).toBe(packingList?.content.byteLength);
    expect(Buffer.from(packingList!.content.subarray(0, 5)).toString()).toBe('%PDF-');
    expect(email.text).toContain('12 pallets, 1,500 kg');
  });

  it('marks a cid-referenced logo as inline and strips the angle brackets from its Content-ID', async () => {
    const email = await parseRawEmail(readEmailFixture('inlineLogoSignature.eml'));
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({
      fileName: 'logo.png',
      contentType: 'image/png',
      contentId: 'logo@swiftcha',
      isInline: true,
    });
    expect(email.text).toContain('INR 8,500 per BL');
  });

  it('derives text from an HTML-only mail: table cells spaced, entities decoded, head dropped', async () => {
    const email = await parseRawEmail(readEmailFixture('htmlOnlyShippingLineRates.eml'));
    expect(email.html).toBeDefined();
    expect(email.text).not.toContain('Rate card\n'); // <title> is not body text
    expect(email.text).toContain('West Coast India \u2192 North Europe');
    expect(email.text).toContain('Nhava Sheva Rotterdam USD 1,100 USD 1,750');
    expect(email.text).toContain('Subject to space & equipment.');
    expect(email.from).toEqual({
      name: 'MSC India - Pricing',
      address: 'pricing.in@mscline.example',
    });
  });

  it('decodes encoded-word names and subjects, 8bit UTF-8 bodies, and flattens recipient groups', async () => {
    const email = await parseRawEmail(readEmailFixture('utf8EncodedSubjectGroupRecipients.eml'));
    expect(email.subject).toBe('दर अनुरोध – Mundra → Jebel Ali (₹ quote)');
    expect(email.from).toEqual({ name: 'राजेश पटेल', address: 'rajesh@gujaratceramics.example' });
    expect(email.to).toEqual([]); // undisclosed-recipients:; is an empty group
    expect(email.cc).toEqual([
      { name: 'Bhatia Ops', address: 'ops@bhatiashipping.example' },
      { name: 'Patel, Meera', address: 'meera@gujaratceramics.example' },
    ]);
    expect(email.text).toContain('Budget around ₹ 85,000');
  });

  it('tolerates a missing Date, a folded To header and an empty body', async () => {
    const email = await parseRawEmail(readEmailFixture('noDateFoldedHeadersEmptyBody.eml'));
    expect(email.date).toBeUndefined();
    expect(email.to.map((recipient) => recipient.address)).toEqual([
      'ops@bhatiashipping.example',
      'accounts@bhatiashipping.example',
    ]);
    expect(email.text).toBe('');
    expect(email.html).toBeUndefined();
  });

  it('accepts the base64url string Gmail returns for format=raw', async () => {
    const rawBytes = readEmailFixture('gmailPlainTextRequest.eml');
    const gmailRaw = Buffer.from(rawBytes).toString('base64url');
    const email = await parseRawEmail(decodeGmailRawMessage(gmailRaw));
    expect(email.messageId).toBe('<CAF+1a2b3c4d5e6f@mail.gmail.com>');
  });
});
