import { Prisma } from '../db/generated/client.js';
import type { PrismaClient } from '../db/prismaClient.js';
import type { ClassificationLabel } from '../classification/classificationLabel.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { EmailListPosition } from './emailListCursor.js';
import {
  CURRENT_CLASSIFICATION_SELECT,
  EMAIL_DETAIL_SELECT,
  PRISMA_ENUM_BY_SNAKE_CASE_LABEL,
  SNAKE_CASE_LABEL_BY_PRISMA_ENUM,
  fromJsonAddresses,
  toCurrentClassification,
  toEmailDetail,
} from './emailModels.js';
import type { EmailDetail, EmailSummary, GmailLabel } from './emailModels.js';

export interface ListEmailsQuery {
  /** How many rows to return; the caller asks for one more than the page to learn whether a next page exists. */
  limit: number;
  gmailLabel?: GmailLabel;
  /** Only mail whose current classification (its newest classifications row) carries this label. */
  classification?: ClassificationLabel;
  /** Rows strictly older than this position in (received_at desc, id desc) order. */
  before?: EmailListPosition;
}

/** What the API reads: the inbox list, one mail, one thread. Every method is scoped to the session's mailbox and tenant. */
export interface EmailReadRepository {
  /** The mailbox's mail, newest first. The tenant in the scope is the isolation check, the mailbox the display scope. */
  listEmails(scope: MailboxScope, query: ListEmailsQuery): Promise<EmailSummary[]>;
  /** The mail with its bodies and current label; undefined outside the scope's mailbox and tenant. */
  findEmail(scope: MailboxScope, emailId: string): Promise<EmailDetail | undefined>;
  /** Every stored message of the thread in this mailbox, inbox and sent, oldest first. Empty when none. */
  listThreadEmails(scope: MailboxScope, gmailThreadId: string): Promise<EmailDetail[]>;
  /**
   * The mailbox's stored copies of these Gmail messages, in no particular order; ids the mailbox
   * never stored are simply absent. How the copilot's citations become mails the operator can open.
   */
  listEmailsByGmailMessageIds(
    scope: MailboxScope,
    gmailMessageIds: string[],
  ): Promise<EmailDetail[]>;
}

/**
 * The ids of the page's mails whose newest classification carries `classification`, in list order.
 * Prisma's relation filters cannot say "the newest row has this label" (a corrected mail still has
 * its old label in history), so DISTINCT ON picks the newest row per mail first and the label is
 * compared on that row only.
 */
async function listEmailIdsWithCurrentClassification(
  prismaClient: PrismaClient,
  { mailboxId, tenantId }: MailboxScope,
  {
    limit,
    gmailLabel,
    classification,
    before,
  }: ListEmailsQuery & { classification: ClassificationLabel },
): Promise<string[]> {
  const rows = await prismaClient.$queryRaw<{ id: string }[]>`
    SELECT email.id
    FROM emails AS email
    JOIN (
      SELECT DISTINCT ON (classification.email_id) classification.email_id, classification.label
      FROM classifications AS classification
      WHERE classification.tenant_id = ${tenantId}::uuid
      ORDER BY classification.email_id, classification.classified_at DESC, classification.id DESC
    ) AS current_classification ON current_classification.email_id = email.id
    WHERE email.mailbox_id = ${mailboxId}::uuid
      AND email.tenant_id = ${tenantId}::uuid
      AND current_classification.label = ${classification}::classification_label
      ${gmailLabel ? Prisma.sql`AND email.gmail_label = ${gmailLabel}::gmail_label` : Prisma.empty}
      ${
        before
          ? Prisma.sql`AND (email.received_at, email.id) < (${before.receivedAt}, ${before.id}::uuid)`
          : Prisma.empty
      }
    ORDER BY email.received_at DESC, email.id DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

export function createPrismaEmailReadRepository(prismaClient: PrismaClient): EmailReadRepository {
  return {
    async listEmails(scope, query) {
      const { mailboxId, tenantId } = scope;
      const { limit, gmailLabel, classification, before } = query;
      const pageIds = classification
        ? await listEmailIdsWithCurrentClassification(prismaClient, scope, {
            ...query,
            classification,
          })
        : undefined;
      if (pageIds && pageIds.length === 0) return [];
      const emails = await prismaClient.email.findMany({
        where: {
          mailboxId,
          tenantId,
          ...(pageIds ? { id: { in: pageIds } } : {}),
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
          classifications: CURRENT_CLASSIFICATION_SELECT,
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
        classification: toCurrentClassification(email.classifications),
      }));
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

    async listEmailsByGmailMessageIds({ mailboxId, tenantId }, gmailMessageIds) {
      if (gmailMessageIds.length === 0) return [];
      const emails = await prismaClient.email.findMany({
        where: { mailboxId, tenantId, gmailMessageId: { in: gmailMessageIds } },
        select: EMAIL_DETAIL_SELECT,
      });
      return emails.map(toEmailDetail);
    },
  };
}
