import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import {
  extractNewContent,
  matchClassificationRule,
  parseRawEmail,
  toGmailApiError,
} from '@lc/core';
import type {
  ClassificationRuleRepository,
  EmailClassification,
  EmailClassifier,
  EmailRepository,
  EncryptionUtil,
  GmailLabel,
  GmailMessages,
  GmailRawMessage,
  MailboxConnectionRepository,
  MailboxScope,
  MailboxSyncRepository,
  ParsedEmail,
  StoredAttachment,
  TenantRepository,
} from '@lc/core';
import { parseGmailMessageIdQueueMessage } from '../gmailMessageIdQueueMessage.js';
import type { GmailMessageIdQueueMessage } from '../gmailMessageIdQueueMessage.js';
import { log } from '../structuredLog.js';
import type { AttachmentStore } from './attachmentStore.js';
import type { RawMailStore } from './rawMailStore.js';

export interface GmailMessageProcessorDependencies {
  mailboxSyncRepository: MailboxSyncRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  tenantRepository: TenantRepository;
  encryptionUtil: EncryptionUtil;
  gmailMessages: GmailMessages;
  rawMailStore: RawMailStore;
  attachmentStore: AttachmentStore;
  emailRepository: EmailRepository;
  classificationRuleRepository: ClassificationRuleRepository;
  /** Undefined when no OPENAI_API_KEY is configured: mail no rule matches is stored unclassified. */
  emailClassifier: EmailClassifier | undefined;
}

export type GmailMessageProcessor = (event: SQSEvent) => Promise<SQSBatchResponse>;

/**
 * done: the record must leave the queue, whether a row was written or the message can never be
 * ingested (dead token, deleted mail, mailbox gone). retry: something transient failed; SQS
 * redelivers and the dead-letter queue keeps it after the third attempt.
 */
type RecordOutcome = 'done' | 'retry';

const GMAIL_SENT_LABEL_ID = 'SENT';
/** infra: the queue's deadLetterQueue.maxReceiveCount. On the last delivery a mail is stored rather than lost. */
const QUEUE_MAX_RECEIVE_COUNT = 3;

/**
 * One SQS record = one Gmail message to ingest: check it is not already stored, fetch it raw,
 * keep the bytes in S3, parse, store each attachment, classify (tenant rule first, then the
 * model), insert. The unique (mailbox_id, gmail_message_id) index makes a duplicate or a racing
 * twin a no-op, and attachment objects are content-addressed, so every step before the insert may
 * safely run twice; the model call is the costly one, so it comes last.
 */
export function createGmailMessageProcessor(
  dependencies: GmailMessageProcessorDependencies,
): GmailMessageProcessor {
  const {
    mailboxSyncRepository,
    mailboxConnectionRepository,
    tenantRepository,
    encryptionUtil,
    gmailMessages,
    rawMailStore,
    attachmentStore,
    emailRepository,
    classificationRuleRepository,
    emailClassifier,
  } = dependencies;

  /** Undefined when this mailbox cannot be fetched from now; the reason is logged and the record is done. */
  async function findRefreshToken(
    scope: MailboxScope,
    context: Record<string, string>,
  ): Promise<string | undefined> {
    const mailbox = await mailboxSyncRepository.findMailboxForProcessing(scope);
    if (!mailbox) {
      log('warn', 'message skipped: mailbox not found in tenant', context);
      return undefined;
    }
    if (mailbox.gmailConnectionStatus !== 'connected' || !mailbox.encryptedRefreshToken) {
      log('info', 'message skipped: mailbox not connected', {
        ...context,
        status: mailbox.gmailConnectionStatus,
      });
      return undefined;
    }
    return encryptionUtil.decryptSecret(mailbox.encryptedRefreshToken);
  }

  /** Fetches, or decides the record's fate when Gmail refuses. */
  async function fetchRawMessage(
    queueMessage: GmailMessageIdQueueMessage,
    refreshToken: string,
    context: Record<string, string>,
  ): Promise<GmailRawMessage | RecordOutcome> {
    const tenantClient = await tenantRepository.findTenantGoogleClient(queueMessage.tenantId);
    if (!tenantClient) {
      log('error', 'message skipped: tenant has no Google client', context);
      return 'done';
    }
    const credentials = {
      clientId: tenantClient.clientId,
      clientSecret: encryptionUtil.decryptSecret(tenantClient.encryptedClientSecret),
    };
    try {
      return await gmailMessages.getRawMessage({
        credentials,
        refreshToken,
        gmailMessageId: queueMessage.gmailMessageId,
      });
    } catch (error) {
      const gmailError = toGmailApiError(error);
      switch (gmailError.code) {
        case 'invalid_grant':
          await mailboxConnectionRepository.markGmailNeedsReconnect(queueMessage);
          log('warn', 'refresh token dead: mailbox marked needs_reconnect', context);
          return 'done';
        case 'not_found':
          // Deleted (or spam-filtered away) between the push and now; nothing to ingest.
          log('info', 'message skipped: no longer in Gmail', context);
          return 'done';
        default:
          log('error', 'messages.get failed, record returned to the queue', {
            ...context,
            code: gmailError.code,
            detail: gmailError.message,
          });
          return 'retry';
      }
    }
  }

  async function processRecord(record: SQSRecord): Promise<RecordOutcome> {
    const queueMessage = parseGmailMessageIdQueueMessage(record.body);
    if (!queueMessage) {
      log('error', 'record dropped: body is not a Gmail message-id queue message', {
        sqsMessageId: record.messageId,
      });
      return 'done';
    }
    const { tenantId, mailboxId, gmailMessageId } = queueMessage;
    const scope: MailboxScope = { tenantId, mailboxId };
    const context = { tenantId, mailboxId, gmailMessageId };

    if (await emailRepository.emailExists(scope, gmailMessageId)) {
      log('info', 'message skipped: already stored', context);
      return 'done';
    }
    const refreshToken = await findRefreshToken(scope, context);
    if (!refreshToken) return 'done';

    const fetched = await fetchRawMessage(queueMessage, refreshToken, context);
    if (fetched === 'done' || fetched === 'retry') return fetched;

    const rawEmailS3Key = await rawMailStore.putRawEmail(scope, gmailMessageId, fetched.raw);
    const parsedEmail = await parseRawEmail(fetched.raw);
    const gmailLabel = toGmailLabel(fetched.labelIds);
    // What the sender typed is what we store and classify. The signature goes always; the quoted
    // history goes when the mailbox already holds a message of this Gmail thread, because then it
    // duplicates rows the thread view shows anyway. A thread new to us (started before the
    // mailbox was connected, a reply-all pulling us in) and a forward keep their quoted text: it
    // is the only copy we have. The raw .eml in S3 stays complete either way.
    const quotedMessageKnown = await emailRepository.threadHasStoredEmail(scope, fetched.threadId);
    const email: ParsedEmail = {
      ...parsedEmail,
      text: extractNewContent(parsedEmail.text, { quotedMessageKnown }),
    };
    // Sequential: the parts are already in memory (postal-mime buffers them); this only bounds in-flight uploads.
    const storedAttachments: StoredAttachment[] = [];
    for (const attachment of email.attachments) {
      storedAttachments.push(await attachmentStore.uploadAttachmentToS3(scope, attachment));
    }
    const classification =
      gmailLabel === 'inbox'
        ? await classifyInboundEmail(email, tenantId, isLastDelivery(record), context)
        : undefined;
    if (classification === 'retry') return 'retry';
    const inserted = await emailRepository.insertEmailIfAbsent(
      {
        tenantId,
        mailboxId,
        gmailMessageId,
        gmailThreadId: fetched.threadId,
        gmailLabel,
        rfcMessageId: email.messageId,
        senderName: email.from?.name ?? '',
        senderEmail: email.from?.address,
        toRecipients: email.to,
        ccRecipients: email.cc,
        subject: email.subject,
        snippet: fetched.snippet,
        bodyText: email.text,
        bodyHtml: email.html,
        rawEmailS3Key,
        receivedAt: email.date ?? fetched.internalDate,
      },
      storedAttachments,
      classification,
    );
    log('info', inserted ? 'message stored' : 'message skipped: stored by a concurrent run', {
      ...context,
      rawEmailS3Key,
      sizeBytes: fetched.raw.byteLength,
      attachmentCount: storedAttachments.length,
      ...(inserted && classification ? toClassificationLogFields(classification) : {}),
    });
    return 'done';
  }

  /**
   * Inbound mail only; what the desk sent is never a customer request. A tenant rule wins; the
   * model is asked only when no rule matched and a key is configured. retry: the provider was
   * unavailable, so the record goes back to the queue, except on its last delivery, when the mail
   * is stored unclassified rather than dead-lettered. Undefined: stored unclassified, which a
   * rejected request also ends in, because a broken prompt must never lose mail.
   */
  async function classifyInboundEmail(
    email: ParsedEmail,
    tenantId: string,
    lastDelivery: boolean,
    context: Record<string, string>,
  ): Promise<EmailClassification | 'retry' | undefined> {
    const senderEmail = email.from?.address;
    const ruleMatch = matchClassificationRule(
      await classificationRuleRepository.listEnabledRules(tenantId),
      senderEmail,
    );
    if (ruleMatch) return { source: 'rule', label: ruleMatch.label, ruleId: ruleMatch.ruleId };
    if (!emailClassifier) return undefined;
    const result = await emailClassifier.classify({
      senderName: email.from?.name ?? '',
      senderEmail,
      subject: email.subject,
      bodyText: email.text,
      attachments: email.attachments,
    });
    switch (result.outcome) {
      case 'classified':
        return result.classification;
      case 'retry':
        if (lastDelivery) {
          log('error', 'classifier unavailable on the last delivery, message stored unclassified', {
            ...context,
            detail: result.detail,
          });
          return undefined;
        }
        log('warn', 'classifier unavailable, record returned to the queue', {
          ...context,
          detail: result.detail,
        });
        return 'retry';
      case 'failed':
        log('error', 'classification failed, message stored unclassified', {
          ...context,
          detail: result.detail,
        });
        return undefined;
    }
  }

  return async (event) => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      let outcome: RecordOutcome;
      try {
        outcome = await processRecord(record);
      } catch (error) {
        log('error', 'record failed, returned to the queue', {
          sqsMessageId: record.messageId,
          detail: error instanceof Error ? error.message : String(error),
        });
        outcome = 'retry';
      }
      if (outcome === 'retry') batchItemFailures.push({ itemIdentifier: record.messageId });
    }
    return { batchItemFailures };
  };
}

function toClassificationLogFields(classification: EmailClassification): Record<string, string> {
  return classification.source === 'rule'
    ? {
        classificationLabel: classification.label,
        classificationSource: classification.source,
        classificationRuleId: classification.ruleId,
      }
    : {
        classificationLabel: classification.label,
        classificationSource: classification.source,
        classificationModel: classification.llmModel,
        classificationConfidence: classification.confidence.toFixed(2),
      };
}

/** True when returning this record would send it to the dead-letter queue instead of back to us. */
function isLastDelivery(record: SQSRecord): boolean {
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount);
  return Number.isFinite(receiveCount) && receiveCount >= QUEUE_MAX_RECEIVE_COUNT;
}

/** The watch covers INBOX and SENT only, so anything without SENT arrived in the inbox. */
function toGmailLabel(labelIds: string[]): GmailLabel {
  return labelIds.includes(GMAIL_SENT_LABEL_ID) ? 'sent' : 'inbox';
}
