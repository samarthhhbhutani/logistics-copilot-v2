import type { SentMail } from '@lc/core';
import type { SentMailResponse } from '@lc/contract';

export function toSentMailResponse(sentMail: SentMail): SentMailResponse {
  return {
    id: sentMail.id,
    kind: sentMail.kind,
    status: sentMail.status,
    inReplyToEmailId: sentMail.inReplyToEmailId,
    gmailThreadId: sentMail.gmailThreadId,
    rfcMessageId: sentMail.rfcMessageId,
    toRecipients: sentMail.toRecipients,
    ccRecipients: sentMail.ccRecipients,
    subject: sentMail.subject,
    bodyText: sentMail.bodyText,
    gmailMessageId: sentMail.gmailMessageId,
    errorCode: sentMail.errorCode,
    createdAt: sentMail.createdAt.toISOString(),
    updatedAt: sentMail.updatedAt.toISOString(),
  };
}
