import type { EmailDetail, EmailSummary } from '@lc/core';
import type { EmailDetailResponse, EmailSummaryResponse } from '@lc/contract';

export function toEmailSummaryResponse(email: EmailSummary): EmailSummaryResponse {
  return {
    id: email.id,
    gmailThreadId: email.gmailThreadId,
    gmailLabel: email.gmailLabel,
    sender: { name: email.senderName, email: email.senderEmail },
    toRecipients: email.toRecipients,
    subject: email.subject,
    snippet: email.snippet,
    receivedAt: email.receivedAt.toISOString(),
  };
}

export function toEmailDetailResponse(email: EmailDetail): EmailDetailResponse {
  return {
    ...toEmailSummaryResponse(email),
    ccRecipients: email.ccRecipients,
    rfcMessageId: email.rfcMessageId,
    bodyText: email.bodyText,
    bodyHtml: email.bodyHtml,
    classification: email.classification
      ? {
          label: email.classification.label,
          source: email.classification.source,
          confidence: email.classification.confidence,
          classifiedAt: email.classification.classifiedAt.toISOString(),
        }
      : null,
  };
}
