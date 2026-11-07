import PostalMime from 'postal-mime';
import type { Address as PostalMimeAddress, Attachment as PostalMimeAttachment } from 'postal-mime';
import { htmlToPlainText } from './htmlToPlainText.js';
import type { EmailAddress, ParsedAttachment, ParsedEmail } from './parsedEmail.js';

/** Gmail `messages.get?format=raw` returns the RFC 822 bytes base64url-encoded in `raw`. */
export function decodeGmailRawMessage(rawBase64Url: string): Uint8Array {
  return new Uint8Array(Buffer.from(rawBase64Url, 'base64url'));
}

/**
 * Parses one RFC 822 message (the bytes Gmail returns for format=raw) into the shape the rest of
 * the pipeline works with. Never throws on odd mail: a missing Date or an unparseable address
 * becomes undefined or an empty list, because the mail still has to be stored and shown.
 */
export async function parseRawEmail(rawEmail: Uint8Array | string): Promise<ParsedEmail> {
  const parsedMessage = await PostalMime.parse(rawEmail, { attachmentEncoding: 'arraybuffer' });
  const html = parsedMessage.html?.trim() || undefined;
  const text = parsedMessage.text?.trim() || (html ? htmlToPlainText(html) : '');
  return {
    messageId: parsedMessage.messageId?.trim() || undefined,
    inReplyTo: parsedMessage.inReplyTo?.trim() || undefined,
    from: flattenAddresses(parsedMessage.from ? [parsedMessage.from] : [])[0],
    replyTo: flattenAddresses(parsedMessage.replyTo),
    to: flattenAddresses(parsedMessage.to),
    cc: flattenAddresses(parsedMessage.cc),
    subject: parsedMessage.subject?.trim() ?? '',
    date: parseDate(parsedMessage.date),
    text,
    html,
    attachments: parsedMessage.attachments.map(toParsedAttachment),
    headers: Object.fromEntries(
      // Headers arrive in reverse order of appearance; keep the first occurrence as written.
      [...parsedMessage.headers]
        .reverse()
        .map((header) => [header.key.toLowerCase(), header.value]),
    ),
  };
}

function flattenAddresses(addresses: PostalMimeAddress[] | undefined): EmailAddress[] {
  const flattened: EmailAddress[] = [];
  for (const address of addresses ?? []) {
    if (address.group) {
      flattened.push(...flattenAddresses(address.group));
    } else if (address.address) {
      flattened.push({ name: address.name?.trim() ?? '', address: address.address.toLowerCase() });
    }
  }
  return flattened;
}

function parseDate(dateHeader: string | undefined): Date | undefined {
  if (!dateHeader) return undefined;
  const date = new Date(dateHeader);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toParsedAttachment(attachment: PostalMimeAttachment): ParsedAttachment {
  const content = toUint8Array(attachment.content);
  return {
    fileName: attachment.filename?.trim() || defaultFileName(attachment.mimeType),
    contentType: attachment.mimeType,
    sizeBytes: content.byteLength,
    content,
    contentId: attachment.contentId?.replace(/^<|>$/g, ''),
    isInline: attachment.disposition === 'inline' || attachment.related === true,
  };
}

function toUint8Array(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new Uint8Array(Buffer.from(content, 'utf8'));
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** Inline images and calendar parts often come without a filename; give them a stable one. */
function defaultFileName(contentType: string): string {
  const subtype = contentType.split('/')[1]?.split(';')[0]?.trim() || 'bin';
  return `attachment.${subtype}`;
}
