import type { MailboxScope } from '@lc/core';

/** One queue message = one Gmail message to fetch. Written by gmailPushReceiver, read by emailProcessor. */
export interface GmailMessageIdQueueMessage extends MailboxScope {
  gmailMessageId: string;
}

/** Undefined for anything that is not a well-formed queue message; such a record can never succeed. */
export function parseGmailMessageIdQueueMessage(
  body: string,
): GmailMessageIdQueueMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { tenantId, mailboxId, gmailMessageId } = parsed as Record<string, unknown>;
  if (
    !isNonEmptyString(tenantId) ||
    !isNonEmptyString(mailboxId) ||
    !isNonEmptyString(gmailMessageId)
  )
    return undefined;
  return { tenantId, mailboxId, gmailMessageId };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
