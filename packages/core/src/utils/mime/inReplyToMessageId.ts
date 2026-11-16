import type { ParsedEmail } from './parsedEmail.js';

/**
 * The Message-ID an inbound mail says it replies to, as a bracketed `<id@domain>` matching how
 * sent_mails.rfc_message_id is stored; undefined when the header is missing or malformed.
 */
export function inReplyToMessageId(email: Pick<ParsedEmail, 'inReplyTo'>): string | undefined {
  const messageId = email.inReplyTo?.trim();
  if (!messageId || !messageId.startsWith('<') || !messageId.endsWith('>')) return undefined;
  return messageId;
}
