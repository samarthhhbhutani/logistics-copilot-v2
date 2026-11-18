import escapeHtml from 'escape-html';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { EmailAddress } from './parsedEmail.js';

/** An image the HTML part references as `cid:<contentId>`, carried inline rather than as a file. */
export interface InlineImage {
  /** The bare Content-ID, without angle brackets or the `cid:` prefix. */
  contentId: string;
  content: Uint8Array;
  contentType: string;
  fileName: string;
}

/**
 * One message we send. The body is plain text; a mailbox with an HTML signature gets a
 * multipart/alternative with the same text and an HTML part (escaped body + signature HTML +
 * its inline images). `messageId` is chosen by the caller so the reply we get back can be
 * matched to the thing we sent without a lookup: Gmail keeps a caller-supplied Message-ID as is.
 */
export interface OutboundMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  text: string;
  /**
   * The sending mailbox's stored signature, appended after an RFC 3676 `-- ` separator so mail
   * clients collapse it and reply parsers drop it from quotes. Unset or blank: no signature.
   */
  signature?: string;
  /**
   * The mailbox's sanitised HTML signature. When set the mail also carries an HTML part; its
   * `cid:` images come from `inlineImages`. Unset or blank: text-only mail.
   */
  signatureHtml?: string;
  inlineImages?: InlineImage[];
  /** Full RFC 5322 form, angle brackets included: `<rfq-123.1@tenant.example>`. */
  messageId: string;
  /** Message-ID of the mail being answered; set together with `references` on every reply. */
  inReplyTo?: string;
  /** The thread's Message-IDs so far, oldest first, ending with `inReplyTo`. */
  references?: string[];
  /** Extra headers, X-* only; standard headers above win on a clash. */
  extraHeaders?: Record<string, string>;
}

/** Message-ID as RFC 5322 wants it: `<left@right>` with no whitespace or further brackets. */
const MESSAGE_ID_SHAPE = /^<[^\s<>@]+@[^\s<>@]+>$/;

export function isWellFormedMessageId(messageId: string): boolean {
  return MESSAGE_ID_SHAPE.test(messageId);
}

/** RFC 3676 signature separator: dash, dash, space, on its own line. */
const SIGNATURE_SEPARATOR = '-- ';

/** Body text with the signature block appended, or the body alone when there is no signature. */
export function appendSignature(text: string, signature: string | undefined): string {
  const trimmedSignature = signature?.trim();
  if (!trimmedSignature) return text;
  return `${text.replace(/\s+$/, '')}\n\n${SIGNATURE_SEPARATOR}\n${trimmedSignature}`;
}

/** The body text as HTML: escaped, line breaks kept, so it reads exactly like the text part. */
export function textBodyAsHtml(text: string): string {
  return `<div style="white-space:pre-wrap">${escapeHtml(text.trimEnd()).replace(/\r?\n/g, '<br>')}</div>`;
}

/** The HTML part: the body, a blank line, then the signature block; undefined when there is no HTML signature. */
export function buildHtmlBody(text: string, signatureHtml: string | undefined): string | undefined {
  const trimmedSignature = signatureHtml?.trim();
  if (!trimmedSignature) return undefined;
  return `${textBodyAsHtml(text)}<br><div class="signature">${trimmedSignature}</div>`;
}

/**
 * Build the RFC 822 bytes for an outbound message with nodemailer's MailComposer (header
 * encoding, folding, quoted-printable, Date). Only the composer is used, never a transport:
 * the bytes go to Gmail's messages.send as base64url.
 */
export async function composeOutboundMime(message: OutboundMessage): Promise<Uint8Array> {
  if (!isWellFormedMessageId(message.messageId)) {
    throw new Error(`Malformed Message-ID: ${message.messageId}`);
  }
  const composer = new MailComposer({
    from: toComposerAddress(message.from),
    to: message.to.map(toComposerAddress),
    cc: message.cc?.map(toComposerAddress),
    subject: message.subject,
    text: appendSignature(message.text, message.signature),
    html: buildHtmlBody(message.text, message.signatureHtml),
    attachments: message.inlineImages?.map((image) => ({
      cid: image.contentId,
      content: Buffer.from(image.content),
      contentType: image.contentType,
      filename: image.fileName,
      contentDisposition: 'inline' as const,
    })),
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    headers: message.extraHeaders,
  });
  const bytes = await composer.compile().build();
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function toComposerAddress(address: EmailAddress): { name: string; address: string } {
  return { name: address.name, address: address.address };
}
