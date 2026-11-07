import EmailForwardParser from 'email-forward-parser';
import type { EmailForwardMailbox } from 'email-forward-parser';
import { collapseWhitespace } from './htmlToPlainText.js';
import type { EmailAddress } from './parsedEmail.js';

/** The message being forwarded, as far as the client's forward header states it. */
export interface OriginalMessage {
  /** The original sender: who wrote the forwarded message, not who forwarded it (that is ParsedEmail.from). */
  from: EmailAddress | undefined;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | undefined;
  /** The Date line of the forward header as written; clients format it freely, so it is not parsed. */
  date: string | undefined;
  body: string;
}

export interface ForwardedEmail {
  /** What the forwarder typed above the original; empty when they added nothing. */
  forwarderNote: string;
  originalMessage: OriginalMessage;
}

/**
 * Detects a forwarded message (Gmail, Outlook, Apple Mail, Thunderbird, Yahoo, many languages)
 * and separates the forwarder's note from the original message. Undefined when the text is not a
 * forward. Thin wrapper over Crisp's email-forward-parser. The original is new to us (we were not
 * on it), so callers pass it to classification and extraction alongside the note; the UI shows
 * the note and collapses the original. The forwarder (ParsedEmail.from) stays the party we deal
 * with; the original sender is context only.
 */
export function splitForwardedContent(
  bodyText: string,
  subject?: string,
): ForwardedEmail | undefined {
  const result = new EmailForwardParser().read(collapseWhitespace(bodyText), subject ?? null);
  if (!result.forwarded) return undefined;
  return {
    forwarderNote: collapseWhitespace(result.message ?? ''),
    originalMessage: {
      from: toEmailAddresses(result.email.from)[0],
      to: toEmailAddresses(result.email.to),
      cc: toEmailAddresses(result.email.cc),
      subject: result.email.subject?.trim() || undefined,
      date: result.email.date?.trim() || undefined,
      body: collapseWhitespace(result.email.body ?? ''),
    },
  };
}

function toEmailAddresses(
  mailboxes: EmailForwardMailbox | EmailForwardMailbox[] | null | undefined,
): EmailAddress[] {
  const list = Array.isArray(mailboxes) ? mailboxes : mailboxes ? [mailboxes] : [];
  return list
    .filter((mailbox) => mailbox.address)
    .map((mailbox) => ({
      name: mailbox.name?.trim() ?? '',
      address: mailbox.address!.toLowerCase(),
    }));
}
