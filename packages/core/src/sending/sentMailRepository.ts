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
  rfqId: string | null;
  vendorId: string | null;
  vendorContactId: string | null;
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
  /**
   * The vendor mails of an RFQ, one per contact, written pending in one statement. A row whose
   * (rfqId, vendorContactId) already exists is left as it is, so a retried or widened send request
   * adds only the contacts that are new. Returns every mail of the RFQ, the existing ones included.
   */
  createPendingRfqMails(scope: MailboxScope, sentMails: SentMailToCreate[]): Promise<SentMail[]>;
  findSentMail(scope: MailboxScope, sentMailId: string): Promise<SentMail | undefined>;
  /** Every mail sent or queued for the RFQ, oldest first. */
  listRfqMails(scope: MailboxScope, rfqId: string): Promise<SentMail[]>;
  /**
   * Status writes move the row only from the one status that precedes the target
   * (pending -> sending -> sent | failed) and report whether it did, so a stale or duplicate request
   * finds `moved: false` instead of rewriting history.
   */
  markSending(scope: MailboxScope, sentMailId: string): Promise<{ moved: boolean }>;
  /** failed -> sending: a retry of a mail Gmail definitively refused; the same row and Message-ID go out again. */
  markSendingAfterFailure(scope: MailboxScope, sentMailId: string): Promise<{ moved: boolean }>;
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
  /**
   * Heals a row the API left in `sending` (crash or timeout after Gmail accepted the mail): when the
   * SENT copy is ingested, its Message-ID is our `<sentMailId@domain>`, so the row is found by
   * (mailbox, rfcMessageId) and moved to `sent`. Only `sending` qualifies: `pending` never reached
   * Gmail and `failed` has no SENT copy. Indexed by @@unique([mailboxId, rfcMessageId]).
   */
  markSentByRfcMessageId(
    scope: MailboxScope,
    rfcMessageId: string,
    gmailIds: { gmailMessageId: string; gmailThreadId: string },
  ): Promise<{ moved: boolean }>;
}

const SENT_MAIL_SELECT = {
  id: true,
  kind: true,
  status: true,
  inReplyToEmailId: true,
  rfqId: true,
  vendorId: true,
  vendorContactId: true,
  gmailThreadId: true,
  rfcMessageId: true,
  toRecipients: true,
  ccRecipients: true,
  subject: true,
  bodyText: true,
  gmailMessageId: true,
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
    rfqId: row.rfqId,
    vendorId: row.vendorId,
    vendorContactId: row.vendorContactId,
    gmailThreadId: row.gmailThreadId,
    rfcMessageId: row.rfcMessageId,
    toRecipients: fromJsonAddresses(row.toRecipients),
    ccRecipients: fromJsonAddresses(row.ccRecipients),
    subject: row.subject,
    bodyText: row.bodyText,
    gmailMessageId: row.gmailMessageId,
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

  /** One conditional UPDATE: the row matching `rowKey` moves only if it is currently in `from`. */
  async function moveTo(
    { mailboxId, tenantId }: MailboxScope,
    rowKey: { id: string } | { rfcMessageId: string },
    transition: { from: SentMailStatus; to: SentMailStatus },
    data: Omit<Prisma.SentMailUpdateManyMutationInput, 'status'>,
  ): Promise<{ moved: boolean }> {
    const result = await prismaClient.sentMail.updateMany({
      where: {
        ...rowKey,
        mailboxId,
        tenantId,
        status: PRISMA_ENUM_BY_SENT_MAIL_STATUS[transition.from],
      },
      data: { ...data, status: PRISMA_ENUM_BY_SENT_MAIL_STATUS[transition.to] },
    });
    return { moved: result.count === 1 };
  }

  function toCreateData(
    scope: MailboxScope,
    sentMail: SentMailToCreate,
  ): Prisma.SentMailUncheckedCreateInput {
    return {
      id: sentMail.id,
      tenantId: scope.tenantId,
      mailboxId: scope.mailboxId,
      kind: PRISMA_ENUM_BY_SENT_MAIL_KIND[sentMail.kind],
      inReplyToEmailId: sentMail.inReplyToEmailId,
      rfqId: sentMail.rfqId,
      vendorId: sentMail.vendorId,
      vendorContactId: sentMail.vendorContactId,
      gmailThreadId: sentMail.gmailThreadId,
      rfcMessageId: sentMail.rfcMessageId,
      toRecipients: toJsonAddresses(sentMail.toRecipients),
      ccRecipients: toJsonAddresses(sentMail.ccRecipients),
      subject: sentMail.subject,
      bodyText: sentMail.bodyText,
    };
  }

  async function listRfqMailsInScope({ mailboxId, tenantId }: MailboxScope, rfqId: string) {
    const rows = await prismaClient.sentMail.findMany({
      where: { rfqId, mailboxId, tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: SENT_MAIL_SELECT,
    });
    return rows.map(toSentMail);
  }

  return {
    async createPending(scope, sentMail) {
      try {
        const row = await prismaClient.sentMail.create({
          data: toCreateData(scope, sentMail),
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

    async createPendingRfqMails(scope, sentMails) {
      const rfqId = sentMails[0]?.rfqId;
      const everyMailBelongs = sentMails.every(
        (sentMail) => sentMail.rfqId === rfqId && sentMail.vendorContactId !== null,
      );
      if (!rfqId || !everyMailBelongs) {
        throw new Error('createPendingRfqMails needs one rfqId and a contact on every mail');
      }
      // skipDuplicates: the unique (rfq_id, vendor_contact_id) keeps a contact's existing row.
      await prismaClient.sentMail.createMany({
        data: sentMails.map((sentMail) => toCreateData(scope, sentMail)),
        skipDuplicates: true,
      });
      return listRfqMailsInScope(scope, rfqId);
    },

    findSentMail: findInScope,

    listRfqMails: listRfqMailsInScope,

    markSending(scope, sentMailId) {
      return moveTo(scope, { id: sentMailId }, { from: 'pending', to: 'sending' }, {});
    },

    markSendingAfterFailure(scope, sentMailId) {
      return moveTo(
        scope,
        { id: sentMailId },
        { from: 'failed', to: 'sending' },
        { errorCode: null },
      );
    },

    markSent(scope, sentMailId, { gmailMessageId, gmailThreadId }) {
      return moveTo(
        scope,
        { id: sentMailId },
        { from: 'sending', to: 'sent' },
        { gmailMessageId, gmailThreadId, errorCode: null },
      );
    },

    markFailed(scope, sentMailId, errorCode) {
      return moveTo(scope, { id: sentMailId }, { from: 'sending', to: 'failed' }, { errorCode });
    },

    markSentByRfcMessageId(scope, rfcMessageId, { gmailMessageId, gmailThreadId }) {
      return moveTo(
        scope,
        { rfcMessageId },
        { from: 'sending', to: 'sent' },
        { gmailMessageId, gmailThreadId, errorCode: null },
      );
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
