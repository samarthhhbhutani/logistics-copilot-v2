import type { CurrentClassification, EmailDetail, EmailSummary } from '@lc/core';
import type {
  CurrentClassificationResponse,
  EmailDetailResponse,
  EmailSummaryResponse,
} from '@lc/contract';

export function toCurrentClassificationResponse(
  classification: CurrentClassification,
): CurrentClassificationResponse {
  return {
    label: classification.label,
    source: classification.source,
    confidence: classification.confidence,
    classifiedAt: classification.classifiedAt.toISOString(),
  };
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
    classification: email.classification
      ? toCurrentClassificationResponse(email.classification)
      : null,
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
