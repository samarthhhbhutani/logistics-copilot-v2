import { Prisma } from '../db/generated/client.js';
import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import { fromJsonAddresses, toJsonAddresses } from '../emails/emailModels.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';
import {
  PRISMA_ENUM_BY_SENT_MAIL_KIND,
  PRISMA_ENUM_BY_SENT_MAIL_STATUS,
  SENT_MAIL_KIND_BY_PRISMA_ENUM,
  SENT_MAIL_STATUS_BY_PRISMA_ENUM,
} from './sentMailModels.js';
import type { SentMail, SentMailKind, SentMailStatus } from './sentMailModels.js';

/** Everything known before messages.send; the row is written with status pending. */
export interface SentMailToCreate {
  /** Client-generated UUID; the idempotency key. */
  id: string;
  kind: SentMailKind;
  inReplyToEmailId: string | null;
  gmailThreadId: string | null;
  rfcMessageId: string;
  toRecipients: EmailAddress[];
  ccRecipients: EmailAddress[];
  subject: string;
  bodyText: string;
}

export type CreatePendingSentMailResult =
  | { outcome: 'created'; sentMail: SentMail }
  /** The same id was already written by this mailbox: an idempotent replay, nothing to send again. */
  | { outcome: 'already_exists'; sentMail: SentMail }
  /** The id exists but belongs to another mailbox or tenant; the client must pick a new one. */
  | { outcome: 'id_taken' };

/** The write-ahead log of outbound mail. Every method is scoped to the session's mailbox and tenant. */
export interface SentMailRepository {
  createPending(
    scope: MailboxScope,
    sentMail: SentMailToCreate,
  ): Promise<CreatePendingSentMailResult>;
  findSentMail(scope: MailboxScope, sentMailId: string): Promise<SentMail | undefined>;
  /**
   * Status writes move the row only from the one status that precedes the target
   * (pending -> sending -> sent | failed) and report whether it did, so a stale or duplicate request
   * finds `moved: false` instead of rewriting history.
   */
  markSending(scope: MailboxScope, sentMailId: string): Promise<{ moved: boolean }>;
  markSent(
    scope: MailboxScope,
    sentMailId: string,
    gmailIds: { gmailMessageId: string; gmailThreadId: string },
  ): Promise<{ moved: boolean }>;
  markFailed(
    scope: MailboxScope,
    sentMailId: string,
    errorCode: string,
  ): Promise<{ moved: boolean }>;
}

const SENT_MAIL_SELECT = {
  id: true,
  kind: true,
  status: true,
  inReplyToEmailId: true,
  gmailThreadId: true,
  rfcMessageId: true,
  toRecipients: true,
  ccRecipients: true,
  subject: true,
  bodyText: true,
  gmailMessageId: true,
  sentEmailId: true,
  errorCode: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SentMailSelect;

type SentMailRow = Prisma.SentMailGetPayload<{ select: typeof SENT_MAIL_SELECT }>;

export function toSentMail(row: SentMailRow): SentMail {
  return {
    id: row.id,
    kind: SENT_MAIL_KIND_BY_PRISMA_ENUM[row.kind],
    status: SENT_MAIL_STATUS_BY_PRISMA_ENUM[row.status],
    inReplyToEmailId: row.inReplyToEmailId,
    gmailThreadId: row.gmailThreadId,
    rfcMessageId: row.rfcMessageId,
    toRecipients: fromJsonAddresses(row.toRecipients),
    ccRecipients: fromJsonAddresses(row.ccRecipients),
    subject: row.subject,
    bodyText: row.bodyText,
    gmailMessageId: row.gmailMessageId,
    sentEmailId: row.sentEmailId,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPrismaSentMailRepository(prismaClient: PrismaClient): SentMailRepository {
  async function findInScope({ mailboxId, tenantId }: MailboxScope, sentMailId: string) {
    const row = await prismaClient.sentMail.findFirst({
      where: { id: sentMailId, mailboxId, tenantId },
      select: SENT_MAIL_SELECT,
    });
    return row ? toSentMail(row) : undefined;
  }

  /** One conditional UPDATE: the row moves only if it is currently in `from`. */
  async function moveTo(
    { mailboxId, tenantId }: MailboxScope,
    sentMailId: string,
    transition: { from: SentMailStatus; to: SentMailStatus },
    data: Omit<Prisma.SentMailUpdateManyMutationInput, 'status'>,
  ): Promise<{ moved: boolean }> {
    const result = await prismaClient.sentMail.updateMany({
      where: {
        id: sentMailId,
        mailboxId,
        tenantId,
        status: PRISMA_ENUM_BY_SENT_MAIL_STATUS[transition.from],
      },
      data: { ...data, status: PRISMA_ENUM_BY_SENT_MAIL_STATUS[transition.to] },
    });
    return { moved: result.count === 1 };
  }

  return {
    async createPending(scope, sentMail) {
      try {
        const row = await prismaClient.sentMail.create({
          data: {
            id: sentMail.id,
            tenantId: scope.tenantId,
            mailboxId: scope.mailboxId,
            kind: PRISMA_ENUM_BY_SENT_MAIL_KIND[sentMail.kind],
            inReplyToEmailId: sentMail.inReplyToEmailId,
            gmailThreadId: sentMail.gmailThreadId,
            rfcMessageId: sentMail.rfcMessageId,
            toRecipients: toJsonAddresses(sentMail.toRecipients),
            ccRecipients: toJsonAddresses(sentMail.ccRecipients),
            subject: sentMail.subject,
            bodyText: sentMail.bodyText,
          },
          select: SENT_MAIL_SELECT,
        });
        return { outcome: 'created', sentMail: toSentMail(row) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Insert first, look up on conflict: two concurrent requests with the same id cannot both create.
        const existing = await findInScope(scope, sentMail.id);
        return existing
          ? { outcome: 'already_exists', sentMail: existing }
          : { outcome: 'id_taken' };
      }
    },

    findSentMail: findInScope,

    markSending(scope, sentMailId) {
      return moveTo(scope, sentMailId, { from: 'pending', to: 'sending' }, {});
    },

    markSent(scope, sentMailId, { gmailMessageId, gmailThreadId }) {
      return moveTo(
        scope,
        sentMailId,
        { from: 'sending', to: 'sent' },
        { gmailMessageId, gmailThreadId, errorCode: null },
      );
    },

    markFailed(scope, sentMailId, errorCode) {
      return moveTo(scope, sentMailId, { from: 'sending', to: 'failed' }, { errorCode });
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
