import { describe, expect, it } from 'vitest';
import {
  appendSignature,
  composeOutboundMime,
  isWellFormedMessageId,
} from './composeOutboundMime.js';
import { parseRawEmail } from './parseRawEmail.js';

const baseMessage = {
  from: { name: 'Ops Desk', address: 'ops@tenant.example' },
  to: [{ name: 'Vendor One', address: 'quotes@vendor-one.example' }],
  subject: 'RFQ 123: 40ft HC Mumbai to Rotterdam',
  text: 'Hello,\n\nPlease quote for 2 x 40ft HC.\n\nThanks',
  messageId: '<rfq-123.1@tenant.example>',
};

function headersOf(rawMessage: Uint8Array): string {
  const text = Buffer.from(rawMessage).toString('utf8');
  return text.slice(0, text.indexOf('\r\n\r\n'));
}

describe('composeOutboundMime', () => {
  it('writes the headers we asked for and keeps our Message-ID instead of generating one', async () => {
    const rawMessage = await composeOutboundMime(baseMessage);
    const headers = headersOf(rawMessage);
    expect(headers).toContain('From: Ops Desk <ops@tenant.example>');
    expect(headers).toContain('To: Vendor One <quotes@vendor-one.example>');
    expect(headers).toContain('Subject: RFQ 123: 40ft HC Mumbai to Rotterdam');
    expect(headers).toContain('Message-ID: <rfq-123.1@tenant.example>');
    expect(headers).toMatch(/^Date: /m);
    expect(headers).toContain('Content-Type: text/plain');
    expect(headers).not.toContain('In-Reply-To');
    expect(headers).not.toContain('Cc:');
  });

  it('round-trips through our own parser, with threading headers on a reply', async () => {
    const rawMessage = await composeOutboundMime({
      ...baseMessage,
      cc: [{ name: '', address: 'desk@tenant.example' }],
      subject: 'Re: RFQ 123: 40ft HC Mumbai to Rotterdam',
      messageId: '<rfq-123.2@tenant.example>',
      inReplyTo: '<vendor-reply-1@vendor-one.example>',
      references: ['<rfq-123.1@tenant.example>', '<vendor-reply-1@vendor-one.example>'],
      extraHeaders: { 'X-Lc-Rfq-Id': 'rfq-123' },
    });
    const parsed = await parseRawEmail(rawMessage);
    expect(parsed.messageId).toBe('<rfq-123.2@tenant.example>');
    expect(parsed.inReplyTo).toBe('<vendor-reply-1@vendor-one.example>');
    expect(parsed.from).toEqual({ name: 'Ops Desk', address: 'ops@tenant.example' });
    expect(parsed.to).toEqual([{ name: 'Vendor One', address: 'quotes@vendor-one.example' }]);
    expect(parsed.cc).toEqual([{ name: '', address: 'desk@tenant.example' }]);
    expect(parsed.subject).toBe('Re: RFQ 123: 40ft HC Mumbai to Rotterdam');
    const headers = headersOf(rawMessage);
    expect(headers).toContain(
      'References: <rfq-123.1@tenant.example> <vendor-reply-1@vendor-one.example>',
    );
    expect(headers).toMatch(/^X-Lc-Rfq-Id: rfq-123\r?$/im);
  });

  it('encodes non-ASCII subject and body so the bytes stay 7-bit clean', async () => {
    const rawMessage = await composeOutboundMime({
      ...baseMessage,
      subject: 'Angebot für Zürich',
      text: 'Grüße aus Mumbai',
    });
    const bytes = Buffer.from(rawMessage);
    expect(bytes.every((byte) => byte < 0x80)).toBe(true);
    const parsed = await parseRawEmail(rawMessage);
    expect(parsed.subject).toBe('Angebot für Zürich');
    expect(parsed.text).toContain('Grüße aus Mumbai');
  });

  it('cannot be used to smuggle extra headers: nodemailer folds CR/LF in header values to spaces', async () => {
    const rawMessage = await composeOutboundMime({
      ...baseMessage,
      subject: 'RFQ 123\r\nBcc: leak@attacker.example',
      extraHeaders: { 'X-Lc-Rfq-Id': 'rfq-123\nBcc: leak2@attacker.example' },
    });
    const headers = headersOf(rawMessage);
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(headers).toContain('Subject: RFQ 123 Bcc: leak@attacker.example');
    expect(headers).toMatch(/^X-Lc-Rfq-Id: rfq-123 Bcc: leak2@attacker.example\r?$/im);
  });

  it('appends the mailbox signature after an RFC 3676 separator, and nothing when there is none', async () => {
    expect(appendSignature('Hello\n\nThanks\n\n', 'Ops Desk\nBhatia Logistics\n')).toBe(
      'Hello\n\nThanks\n\n-- \nOps Desk\nBhatia Logistics',
    );
    expect(appendSignature('Hello', undefined)).toBe('Hello');
    expect(appendSignature('Hello', '   \n')).toBe('Hello');

    const parsed = await parseRawEmail(
      await composeOutboundMime({ ...baseMessage, signature: 'Ops Desk\n+91 98765 43210' }),
    );
    expect(parsed.text.replace(/\r\n/g, '\n')).toBe(
      'Hello,\n\nPlease quote for 2 x 40ft HC.\n\nThanks\n\n-- \nOps Desk\n+91 98765 43210',
    );
  });

  it('rejects a Message-ID that is not <left@right>', async () => {
    expect(isWellFormedMessageId('<a.1@b.example>')).toBe(true);
    expect(isWellFormedMessageId('a.1@b.example')).toBe(false);
    expect(isWellFormedMessageId('<a 1@b.example>')).toBe(false);
    expect(isWellFormedMessageId('<a.1@>')).toBe(false);
    await expect(composeOutboundMime({ ...baseMessage, messageId: 'rfq-123.1' })).rejects.toThrow(
      /Malformed Message-ID/,
    );
  });
});
