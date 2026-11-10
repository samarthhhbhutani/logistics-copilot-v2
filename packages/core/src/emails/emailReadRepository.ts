import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { EmailListPosition } from './emailListCursor.js';
import {
  EMAIL_DETAIL_SELECT,
  PRISMA_ENUM_BY_SNAKE_CASE_LABEL,
  SNAKE_CASE_LABEL_BY_PRISMA_ENUM,
  fromJsonAddresses,
  toEmailDetail,
} from './emailModels.js';
import type { EmailDetail, EmailSummary, GmailLabel } from './emailModels.js';

export interface ListEmailsQuery {
  /** How many rows to return; the caller asks for one more than the page to learn whether a next page exists. */
  limit: number;
  gmailLabel?: GmailLabel;
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
}

export function createPrismaEmailReadRepository(prismaClient: PrismaClient): EmailReadRepository {
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
  };
}
