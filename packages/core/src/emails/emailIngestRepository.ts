import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';
import type { StoredAttachment } from './attachmentRepository.js';
import {
  PRISMA_LABEL_BY_CLASSIFICATION_LABEL,
  PRISMA_SOURCE_BY_CLASSIFICATION_SOURCE,
} from '../classification/classificationLabel.js';
import type { ClassificationLabel } from '../classification/classificationLabel.js';
import type { EmailClassification } from '../classification/emailClassification.js';
import {
  CURRENT_CLASSIFICATION_SELECT,
  PRISMA_ENUM_BY_SNAKE_CASE_LABEL,
  toCurrentClassification,
  toJsonAddresses,
  withoutNulCharacters,
} from './emailModels.js';
import type { GmailLabel } from './emailModels.js';

/** Everything the processor knows about one message once fetched, stored in S3 and parsed. */
export interface NewEmail extends MailboxScope {
  gmailMessageId: string;
  gmailThreadId: string;
  gmailLabel: GmailLabel;
  rfcMessageId: string | undefined;
  /** From header; name is '' when only an address was given, address undefined when From was missing. */
  senderName: string;
  senderEmail: string | undefined;
  toRecipients: EmailAddress[];
  ccRecipients: EmailAddress[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string | undefined;
  rawEmailS3Key: string;
  receivedAt: Date;
}

/** What the processor learns about a Gmail thread before storing a new message of it. */
export interface ThreadContext {
  /** The mailbox already holds a message of the thread (any age), so quoted history is ours. */
  hasStoredEmail: boolean;
  /** Current label of every stored message of the thread received before the new one; later ones do not decide its label. */
  currentLabels: ClassificationLabel[];
}

/** What emailProcessor needs from the emails table: a duplicate check, the thread's state, and the insert. */
export interface EmailIngestRepository {
  /** Cheap check before fetching from Gmail: SQS redelivers, and a push can list an id twice. */
  emailExists(scope: MailboxScope, gmailMessageId: string): Promise<boolean>;
  /**
   * One query per ingested message: whether the thread is known (quoted history is ours) and what the messages
   * received before `receivedBefore` are labelled. Two mails of one thread can be delivered out of order; the
   * earlier one must not inherit a label from the later one.
   */
  findThreadContext(
    scope: MailboxScope,
    gmailThreadId: string,
    receivedBefore: Date,
  ): Promise<ThreadContext>;
  /**
   * Inserts the email, its attachment rows and (when the thread, a rule or the model decided) its
   * classification in one transaction, unless (mailbox_id, gmail_message_id) already exists; two processors racing on
   * the same id both succeed and exactly one email with one set of rows results. Returns false
   * when the row was there.
   */
  insertEmailIfAbsent(
    newEmail: NewEmail,
    attachments: StoredAttachment[],
    classification?: EmailClassification,
  ): Promise<boolean>;
}

/** The columns that say how a label was decided; which ones are set depends on the source. */
function classificationProvenance(classification: EmailClassification): {
  ruleId?: string;
  llmModel?: string;
  promptVersion?: string;
  confidence?: number;
} {
  switch (classification.source) {
    case 'thread':
      return {};
    case 'rule':
      return { ruleId: classification.ruleId };
    case 'llm':
      return {
        llmModel: classification.llmModel,
        promptVersion: classification.promptVersion,
        confidence: classification.confidence,
      };
  }
}

export function createPrismaEmailIngestRepository(
  prismaClient: PrismaClient,
): EmailIngestRepository {
  return {
    async emailExists({ mailboxId, tenantId }, gmailMessageId) {
      const email = await prismaClient.email.findFirst({
        where: { mailboxId, tenantId, gmailMessageId },
        select: { id: true },
      });
      return email !== null;
    },

    async findThreadContext({ mailboxId, tenantId }, gmailThreadId, receivedBefore) {
      const emails = await prismaClient.email.findMany({
        where: { mailboxId, tenantId, gmailThreadId },
        select: { receivedAt: true, classifications: CURRENT_CLASSIFICATION_SELECT },
      });
      return {
        hasStoredEmail: emails.length > 0,
        currentLabels: emails.flatMap((email) => {
          if (email.receivedAt >= receivedBefore) return [];
          const current = toCurrentClassification(email.classifications);
          return current ? [current.label] : [];
        }),
      };
    },

    async insertEmailIfAbsent(newEmail, attachments, classification) {
      return prismaClient.$transaction(async (transaction) => {
        // ON CONFLICT DO NOTHING RETURNING id: an empty result means the row was already there.
        const inserted = await transaction.email.createManyAndReturn({
          data: {
            tenantId: newEmail.tenantId,
            mailboxId: newEmail.mailboxId,
            gmailMessageId: newEmail.gmailMessageId,
            gmailThreadId: newEmail.gmailThreadId,
            gmailLabel: PRISMA_ENUM_BY_SNAKE_CASE_LABEL[newEmail.gmailLabel],
            rfcMessageId: newEmail.rfcMessageId
              ? withoutNulCharacters(newEmail.rfcMessageId)
              : null,
            senderName: withoutNulCharacters(newEmail.senderName),
            senderEmail: newEmail.senderEmail ? withoutNulCharacters(newEmail.senderEmail) : null,
            toRecipients: toJsonAddresses(newEmail.toRecipients),
            ccRecipients: toJsonAddresses(newEmail.ccRecipients),
            subject: withoutNulCharacters(newEmail.subject),
            snippet: withoutNulCharacters(newEmail.snippet),
            bodyText: withoutNulCharacters(newEmail.bodyText),
            bodyHtml: newEmail.bodyHtml ? withoutNulCharacters(newEmail.bodyHtml) : null,
            rawEmailS3Key: newEmail.rawEmailS3Key,
            receivedAt: newEmail.receivedAt,
          },
          skipDuplicates: true,
          select: { id: true },
        });
        const insertedEmail = inserted[0];
        if (inserted.length !== 1 || !insertedEmail) return false;
        const emailId = insertedEmail.id;
        if (attachments.length > 0) {
          await transaction.attachment.createMany({
            data: attachments.map((attachment) => ({
              tenantId: newEmail.tenantId,
              emailId,
              fileName: withoutNulCharacters(attachment.fileName),
              contentType: withoutNulCharacters(attachment.contentType),
              sizeBytes: attachment.sizeBytes,
              sha256: attachment.sha256,
              s3Key: attachment.s3Key,
              contentId: attachment.contentId ? withoutNulCharacters(attachment.contentId) : null,
              isInline: attachment.isInline,
            })),
          });
        }
        if (classification) {
          await transaction.classification.create({
            data: {
              tenantId: newEmail.tenantId,
              emailId,
              label: PRISMA_LABEL_BY_CLASSIFICATION_LABEL[classification.label],
              source: PRISMA_SOURCE_BY_CLASSIFICATION_SOURCE[classification.source],
              ...classificationProvenance(classification),
            },
          });
        }
        return true;
      });
    },
  };
}
