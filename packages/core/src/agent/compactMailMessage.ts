import type { GmailRawMessage } from '../connectors/gmail/gmailMessages.js';
import { extractNewContent } from '../utils/mime/extractNewContent.js';
import { parseRawEmail } from '../utils/mime/parseRawEmail.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';

/** A full message as a tool returns it: about a page of text at most. */
export const COMPACT_MESSAGE_MAX_CHARS = 4000;
/** A search hit: enough to decide whether to open the message. */
export const COMPACT_PREVIEW_MAX_CHARS = 300;

/**
 * One mail as the agent sees it: headers it can reason and search with, the text the sender
 * typed (no signature, no quoted history when the quoted mail is already in view), attachment
 * names rather than bytes, no HTML. Kept flat and small so a thread fits in the model context.
 */
export interface CompactMailMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  /** ISO 8601; the Date header, else Gmail's internalDate. */
  date: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** Gmail labels (INBOX, SENT, UNREAD, ...): tells the agent which side wrote the mail. */
  labels: string[];
  text: string;
  /** True when `text` was cut at the character cap; the agent can ask for the full message. */
  truncated: boolean;
  attachments: { fileName: string; contentType: string; sizeBytes: number }[];
}

export interface CompactMailMessageOptions {
  maxChars: number;
  /**
   * Drop the quoted history: safe when the mail it quotes is already part of what the agent sees
   * (every message of a thread after the first). Otherwise the quoted text may be all we have.
   */
  quotedMessageKnown: boolean;
}

export async function toCompactMailMessage(
  gmailMessageId: string,
  message: GmailRawMessage,
  { maxChars, quotedMessageKnown }: CompactMailMessageOptions,
): Promise<CompactMailMessage> {
  const parsed = await parseRawEmail(message.raw);
  const text = extractNewContent(parsed.text, { quotedMessageKnown });
  const cut = truncateAtWord(text, maxChars);
  return {
    gmailMessageId,
    gmailThreadId: message.threadId,
    date: (parsed.date ?? message.internalDate).toISOString(),
    from: parsed.from ? formatAddress(parsed.from) : '',
    to: parsed.to.map(formatAddress),
    cc: parsed.cc.map(formatAddress),
    subject: parsed.subject,
    labels: message.labelIds,
    text: cut.text,
    truncated: cut.truncated,
    attachments: parsed.attachments
      .filter((attachment) => !attachment.isInline)
      .map(({ fileName, contentType, sizeBytes }) => ({ fileName, contentType, sizeBytes })),
  };
}

export function formatAddress(address: EmailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

/** Cuts at the last whitespace before the cap so the model never sees half a word or number. */
export function truncateAtWord(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = text.slice(0, maxChars);
  const lastBreak = head.search(/\s\S*$/);
  return {
    text: (lastBreak > maxChars / 2 ? head.slice(0, lastBreak) : head).trimEnd(),
    truncated: true,
  };
}
