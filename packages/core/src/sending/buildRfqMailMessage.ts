import type { MailboxConnection } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { OutboundMessage } from '../utils/mime/composeOutboundMime.js';
import type { SentMail } from './sentMailModels.js';

/**
 * An RFQ mail as composeOutboundMime wants it: a fresh thread to one vendor contact, so no
 * In-Reply-To or References. The mailbox signature is added at compose time, as for replies.
 */
export function buildRfqMailMessage(
  sentMail: SentMail,
  connection: MailboxConnection,
): OutboundMessage {
  return {
    from: { name: '', address: connection.emailAddress },
    to: sentMail.toRecipients,
    subject: sentMail.subject,
    text: sentMail.bodyText,
    signature: connection.signature ?? undefined,
    messageId: sentMail.rfcMessageId,
  };
}
