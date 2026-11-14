import type { MailboxConnection } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { EmailDetail } from '../emails/emailModels.js';
import type { OutboundMessage } from '../utils/mime/composeOutboundMime.js';
import type { SentMail } from './sentMailModels.js';

/** `<sentMailId@domain-of-the-sending-mailbox>`: unique per attempt, and ours to recognise later. */
export function buildOutboundMessageId(sentMailId: string, mailboxEmailAddress: string): string {
  const domain = mailboxEmailAddress.slice(mailboxEmailAddress.lastIndexOf('@') + 1);
  return `<${sentMailId}@${domain}>`;
}

/**
 * The reply as composeOutboundMime wants it. References lists the thread's known Message-IDs oldest
 * first and ends with the mail being answered, which is what threading clients expect.
 */
export function buildReplyMessage(
  sentMail: SentMail,
  answeredEmail: EmailDetail,
  threadEmails: EmailDetail[],
  connection: MailboxConnection,
): OutboundMessage {
  // References = every Message-ID we hold for the thread, oldest first, with the answered mail
  // moved to the end (RFC 5322: it must be last, and equal to In-Reply-To). Mails without a
  // Message-ID header are skipped; if the answeredEmail itself has none, In-Reply-To is omitted too.
  const otherThreadMessageIds = threadEmails
    .map((email) => email.rfcMessageId)
    .filter((messageId): messageId is string => messageId !== null)
    .filter((messageId) => messageId !== answeredEmail.rfcMessageId);
  const references = answeredEmail.rfcMessageId
    ? [...otherThreadMessageIds, answeredEmail.rfcMessageId]
    : otherThreadMessageIds;
  return {
    from: { name: '', address: connection.emailAddress },
    to: sentMail.toRecipients,
    cc: sentMail.ccRecipients.length > 0 ? sentMail.ccRecipients : undefined,
    subject: sentMail.subject,
    text: sentMail.bodyText,
    signature: connection.signature ?? undefined,
    messageId: sentMail.rfcMessageId,
    inReplyTo: answeredEmail.rfcMessageId ?? undefined,
    references: references.length > 0 ? references : undefined,
  };
}
