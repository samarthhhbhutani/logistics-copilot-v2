import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { parseRawEmail, toGmailApiError } from '@lc/core';
import type {
  EmailRepository,
  EncryptionUtil,
  GmailLabel,
  GmailMessages,
  GmailRawMessage,
  MailboxConnectionRepository,
  MailboxScope,
  MailboxSyncRepository,
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
}

export type GmailMessageProcessor = (event: SQSEvent) => Promise<SQSBatchResponse>;

/**
 * done: the record must leave the queue, whether a row was written or the message can never be
 * ingested (dead token, deleted mail, mailbox gone). retry: something transient failed; SQS
 * redelivers and the dead-letter queue keeps it after the third attempt.
 */
type RecordOutcome = 'done' | 'retry';

const GMAIL_SENT_LABEL_ID = 'SENT';

/**
 * One SQS record = one Gmail message to ingest: check it is not already stored, fetch it raw,
 * keep the bytes in S3, parse, store each attachment, insert. The unique (mailbox_id,
 * gmail_message_id) index makes a duplicate or a racing twin a no-op, and attachment objects are
 * content-addressed, so every step before the insert may safely run twice.
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
    // Sequential: the parts are already in memory (postal-mime buffers them); this only bounds in-flight uploads.
    const storedAttachments: StoredAttachment[] = [];
    for (const attachment of parsedEmail.attachments) {
      storedAttachments.push(await attachmentStore.uploadAttachmentToS3(scope, attachment));
    }
    const inserted = await emailRepository.insertEmailIfAbsent(
      {
        tenantId,
        mailboxId,
        gmailMessageId,
        gmailThreadId: fetched.threadId,
        gmailLabel: toGmailLabel(fetched.labelIds),
        rfcMessageId: parsedEmail.messageId,
        senderName: parsedEmail.from?.name ?? '',
        senderEmail: parsedEmail.from?.address,
        toRecipients: parsedEmail.to,
        ccRecipients: parsedEmail.cc,
        subject: parsedEmail.subject,
        snippet: fetched.snippet,
        bodyText: parsedEmail.text,
        bodyHtml: parsedEmail.html,
        rawEmailS3Key,
        receivedAt: parsedEmail.date ?? fetched.internalDate,
      },
      storedAttachments,
    );
    log('info', inserted ? 'message stored' : 'message skipped: stored by a concurrent run', {
      ...context,
      rawEmailS3Key,
      sizeBytes: fetched.raw.byteLength,
      attachmentCount: storedAttachments.length,
    });
    return 'done';
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

/** The watch covers INBOX and SENT only, so anything without SENT arrived in the inbox. */
function toGmailLabel(labelIds: string[]): GmailLabel {
  return labelIds.includes(GMAIL_SENT_LABEL_ID) ? 'sent' : 'inbox';
}
