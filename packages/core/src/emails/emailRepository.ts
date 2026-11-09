import type { PrismaClient } from '../db/prismaClient.js';
import type { GmailLabel as PrismaGmailLabel } from '../db/generated/client.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';

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

export interface EmailRepository {
  /** Cheap check before fetching from Gmail: SQS redelivers, and a push can list an id twice. */
  emailExists(scope: MailboxScope, gmailMessageId: string): Promise<boolean>;
  /**
   * Inserts unless (mailbox_id, gmail_message_id) already exists; two processors racing on the
   * same id both succeed and exactly one row results. Returns false when the row was already there.
   */
  insertEmailIfAbsent(newEmail: NewEmail): Promise<boolean>;
}

// Prisma generates UPPER_CASE enum members; the API and the column speak snake_case.
const PRISMA_ENUM_BY_SNAKE_CASE_LABEL: Record<GmailLabel, PrismaGmailLabel> = {
  inbox: 'INBOX',
  sent: 'SENT',
};

/** Prisma's Json input wants plain object literals; an interface type without an index signature is refused. */
function toJsonAddresses(addresses: EmailAddress[]): { name: string; address: string }[] {
  return addresses.map(({ name, address }) => ({ name, address }));
}

export function createPrismaEmailRepository(prismaClient: PrismaClient): EmailRepository {
  return {
    async emailExists({ mailboxId, tenantId }, gmailMessageId) {
      const email = await prismaClient.email.findFirst({
        where: { mailboxId, tenantId, gmailMessageId },
        select: { id: true },
      });
      return email !== null;
    },

    async insertEmailIfAbsent(newEmail) {
      const result = await prismaClient.email.createMany({
        data: {
          tenantId: newEmail.tenantId,
          mailboxId: newEmail.mailboxId,
          gmailMessageId: newEmail.gmailMessageId,
          gmailThreadId: newEmail.gmailThreadId,
          gmailLabel: PRISMA_ENUM_BY_SNAKE_CASE_LABEL[newEmail.gmailLabel],
          rfcMessageId: newEmail.rfcMessageId ?? null,
          senderName: newEmail.senderName,
          senderEmail: newEmail.senderEmail ?? null,
          toRecipients: toJsonAddresses(newEmail.toRecipients),
          ccRecipients: toJsonAddresses(newEmail.ccRecipients),
          subject: newEmail.subject,
          snippet: newEmail.snippet,
          bodyText: newEmail.bodyText,
          bodyHtml: newEmail.bodyHtml ?? null,
          rawEmailS3Key: newEmail.rawEmailS3Key,
          receivedAt: newEmail.receivedAt,
        },
        skipDuplicates: true,
      });
      return result.count === 1;
    },
  };
}
