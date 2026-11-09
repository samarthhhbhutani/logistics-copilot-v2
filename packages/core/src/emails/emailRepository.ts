import type { PrismaClient } from '../db/prismaClient.js';
import type { GmailLabel as PrismaGmailLabel } from '../db/generated/client.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';
import type { EmailListPosition } from './emailListCursor.js';

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

    async insertEmailIfAbsent(newEmail) {
      const result = await prismaClient.email.createMany({
        data: {
          tenantId: newEmail.tenantId,
          mailboxId: newEmail.mailboxId,
          gmailMessageId: newEmail.gmailMessageId,
          gmailThreadId: newEmail.gmailThreadId,
          gmailLabel: PRISMA_ENUM_BY_SNAKE_CASE_LABEL[newEmail.gmailLabel],
          rfcMessageId: newEmail.rfcMessageId ? withoutNulCharacters(newEmail.rfcMessageId) : null,
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
      });
      return result.count === 1;
    },
  };
}
