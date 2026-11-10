import type { PrismaClient } from '../db/prismaClient.js';
import type { GmailLabel as PrismaGmailLabel } from '../db/generated/client.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';
import type { EmailListPosition } from './emailListCursor.js';
import type { StoredAttachment } from './attachmentRepository.js';
import {
  CLASSIFICATION_LABEL_BY_PRISMA_LABEL,
  CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE,
  PRISMA_LABEL_BY_CLASSIFICATION_LABEL,
  PRISMA_SOURCE_BY_CLASSIFICATION_SOURCE,
} from '../classification/classificationLabel.js';
import type {
  ClassificationLabel,
  ClassificationSource,
} from '../classification/classificationLabel.js';
import type { EmailClassification } from '../classification/emailClassification.js';

/** Which Gmail folder the message arrived in; snake_case like every other enum the API speaks. */
export type GmailLabel = 'inbox' | 'sent';

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

/** One row of the inbox list: everything the list view shows, no bodies. */
export interface EmailSummary {
  id: string;
  gmailThreadId: string;
  gmailLabel: GmailLabel;
  senderName: string;
  senderEmail: string | null;
  toRecipients: EmailAddress[];
  subject: string;
  snippet: string;
  receivedAt: Date;
}

/** The newest classifications row of an email: what the desk currently calls it and who said so. */
export interface CurrentClassification {
  label: ClassificationLabel;
  source: ClassificationSource;
  confidence: number | null;
  classifiedAt: Date;
}

/** One mail in full, for the detail and thread views. */
export interface EmailDetail extends EmailSummary {
  ccRecipients: EmailAddress[];
  rfcMessageId: string | null;
  bodyText: string;
  bodyHtml: string | null;
  classification: CurrentClassification | null;
}

/** What the processor learns about a Gmail thread before storing a new message of it. */
export interface ThreadContext {
  /** The mailbox already holds a message of the thread (any age), so quoted history is ours. */
  hasStoredEmail: boolean;
  /** Current label of every stored message of the thread received before the new one; later ones do not decide its label. */
  currentLabels: ClassificationLabel[];
}

export interface ListEmailsQuery {
  /** How many rows to return; the caller asks for one more than the page to learn whether a next page exists. */
  limit: number;
  gmailLabel?: GmailLabel;
  /** Rows strictly older than this position in (received_at desc, id desc) order. */
  before?: EmailListPosition;
}

export interface EmailRepository {
  /** The mailbox's mail, newest first. The tenant in the scope is the isolation check, the mailbox the display scope. */
  listEmails(scope: MailboxScope, query: ListEmailsQuery): Promise<EmailSummary[]>;
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
  /** The mail with its bodies and current label; undefined outside the scope's mailbox and tenant. */
  findEmail(scope: MailboxScope, emailId: string): Promise<EmailDetail | undefined>;
  /** Every stored message of the thread in this mailbox, inbox and sent, oldest first. Empty when none. */
  listThreadEmails(scope: MailboxScope, gmailThreadId: string): Promise<EmailDetail[]>;
  /**
   * Inserts the email, its attachment rows and (when a rule or the model decided) its
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

// Prisma generates UPPER_CASE enum members; the API and the column speak snake_case.
const PRISMA_ENUM_BY_SNAKE_CASE_LABEL: Record<GmailLabel, PrismaGmailLabel> = {
  inbox: 'INBOX',
  sent: 'SENT',
};
const SNAKE_CASE_LABEL_BY_PRISMA_ENUM: Record<PrismaGmailLabel, GmailLabel> = {
  INBOX: 'inbox',
  SENT: 'sent',
};

/** The jsonb column holds what toJsonAddresses wrote; anything else is treated as no recipients. */
function fromJsonAddresses(value: unknown): EmailAddress[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, address } = entry as Record<string, unknown>;
    return typeof name === 'string' && typeof address === 'string' ? [{ name, address }] : [];
  });
}

/**
 * Postgres refuses the NUL character in text and jsonb columns; malformed mail (a mislabelled
 * UTF-16 part, say) can carry one. Dropping it keeps the row insertable; the raw .eml is intact.
 */
function withoutNulCharacters(text: string): string {
  return text.replaceAll('\u0000', '');
}

/** Prisma's Json input wants plain object literals; an interface type without an index signature is refused. */
function toJsonAddresses(addresses: EmailAddress[]): { name: string; address: string }[] {
  return addresses.map(({ name, address }) => ({
    name: withoutNulCharacters(name),
    address: withoutNulCharacters(address),
  }));
}

/**
 * The newest classifications row of the parent email; Prisma scopes the nested select to that email, and the
 * parent query already carries the tenant filter. The id tie-breaker only makes the pick deterministic when
 * two rows share a classified_at; it carries no ordering meaning.
 */
const CURRENT_CLASSIFICATION_SELECT = {
  orderBy: [{ classifiedAt: 'desc' as const }, { id: 'desc' as const }],
  take: 1,
  select: { label: true, source: true, confidence: true, classifiedAt: true },
};

const EMAIL_DETAIL_SELECT = {
  id: true,
  gmailThreadId: true,
  gmailLabel: true,
  senderName: true,
  senderEmail: true,
  toRecipients: true,
  ccRecipients: true,
  subject: true,
  snippet: true,
  receivedAt: true,
  rfcMessageId: true,
  bodyText: true,
  bodyHtml: true,
  classifications: CURRENT_CLASSIFICATION_SELECT,
};

type CurrentClassificationRow = {
  label: keyof typeof CLASSIFICATION_LABEL_BY_PRISMA_LABEL;
  source: keyof typeof CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE;
  confidence: number | null;
  classifiedAt: Date;
};

type EmailDetailRow = {
  id: string;
  gmailThreadId: string;
  gmailLabel: PrismaGmailLabel;
  senderName: string;
  senderEmail: string | null;
  toRecipients: unknown;
  ccRecipients: unknown;
  subject: string;
  snippet: string;
  receivedAt: Date;
  rfcMessageId: string | null;
  bodyText: string;
  bodyHtml: string | null;
  classifications: CurrentClassificationRow[];
};

function toCurrentClassification(rows: CurrentClassificationRow[]): CurrentClassification | null {
  const row = rows[0];
  if (!row) return null;
  return {
    label: CLASSIFICATION_LABEL_BY_PRISMA_LABEL[row.label],
    source: CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE[row.source],
    confidence: row.confidence,
    classifiedAt: row.classifiedAt,
  };
}

function toEmailDetail(row: EmailDetailRow): EmailDetail {
  return {
    id: row.id,
    gmailThreadId: row.gmailThreadId,
    gmailLabel: SNAKE_CASE_LABEL_BY_PRISMA_ENUM[row.gmailLabel],
    senderName: row.senderName,
    senderEmail: row.senderEmail,
    toRecipients: fromJsonAddresses(row.toRecipients),
    ccRecipients: fromJsonAddresses(row.ccRecipients),
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.receivedAt,
    rfcMessageId: row.rfcMessageId,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    classification: toCurrentClassification(row.classifications),
  };
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

export function createPrismaEmailRepository(prismaClient: PrismaClient): EmailRepository {
  return {
    async listEmails({ mailboxId, tenantId }, { limit, gmailLabel, before }) {
      const emails = await prismaClient.email.findMany({
        where: {
          mailboxId,
          tenantId,
          ...(gmailLabel ? { gmailLabel: PRISMA_ENUM_BY_SNAKE_CASE_LABEL[gmailLabel] } : {}),
          // (received_at, id) < (before.receivedAt, before.id), spelled out for Prisma.
          ...(before
            ? {
                OR: [
                  { receivedAt: { lt: before.receivedAt } },
                  { receivedAt: before.receivedAt, id: { lt: before.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: {
          id: true,
          gmailThreadId: true,
          gmailLabel: true,
          senderName: true,
          senderEmail: true,
          toRecipients: true,
          subject: true,
          snippet: true,
          receivedAt: true,
        },
      });
      return emails.map((email) => ({
        id: email.id,
        gmailThreadId: email.gmailThreadId,
        gmailLabel: SNAKE_CASE_LABEL_BY_PRISMA_ENUM[email.gmailLabel],
        senderName: email.senderName,
        senderEmail: email.senderEmail,
        toRecipients: fromJsonAddresses(email.toRecipients),
        subject: email.subject,
        snippet: email.snippet,
        receivedAt: email.receivedAt,
      }));
    },

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

    async findEmail({ mailboxId, tenantId }, emailId) {
      const email = await prismaClient.email.findFirst({
        where: { id: emailId, mailboxId, tenantId },
        select: EMAIL_DETAIL_SELECT,
      });
      return email ? toEmailDetail(email) : undefined;
    },

    async listThreadEmails({ mailboxId, tenantId }, gmailThreadId) {
      const emails = await prismaClient.email.findMany({
        where: { mailboxId, tenantId, gmailThreadId },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        select: EMAIL_DETAIL_SELECT,
      });
      return emails.map(toEmailDetail);
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
