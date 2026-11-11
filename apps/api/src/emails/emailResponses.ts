import type { EmailDetail, EmailSummary } from '@lc/core';
import type { EmailDetailResponse, EmailSummaryResponse } from '@lc/contract';

function toCurrentClassificationResponse(classification: EmailSummary['classification']) {
  return classification
    ? {
        label: classification.label,
        source: classification.source,
        confidence: classification.confidence,
        classifiedAt: classification.classifiedAt.toISOString(),
      }
    : null;
}

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
    classification: toCurrentClassificationResponse(email.classification),
  };
}

export function toEmailDetailResponse(email: EmailDetail): EmailDetailResponse {
  return {
    ...toEmailSummaryResponse(email),
    ccRecipients: email.ccRecipients,
    rfcMessageId: email.rfcMessageId,
    bodyText: email.bodyText,
    bodyHtml: email.bodyHtml,
  };
}
