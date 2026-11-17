import { Prisma } from '../db/generated/client.js';
import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import { CURRENT_CLASSIFICATION_SELECT, toCurrentClassification } from '../emails/emailModels.js';
import { RFQ_STATUS_BY_PRISMA_ENUM } from './rfqModels.js';
import type { Rfq, RfqListItem } from './rfqModels.js';
import type { RfqListPosition } from './rfqListCursor.js';

export interface RfqToCreate {
  /** Client-generated UUID; the idempotency key. */
  id: string;
  sourceEmailId: string;
  originPort: string;
  destinationPort: string;
  incoterm: string | null;
}

export type CreateRfqResult =
  | { outcome: 'created'; rfq: Rfq }
  /** The same id was already written by this mailbox: an idempotent replay of the send request. */
  | { outcome: 'already_exists'; rfq: Rfq }
  /** The id exists but belongs to another mailbox or tenant; the client must pick a new one. */
  | { outcome: 'id_taken' };

export interface ListRfqsQuery {
  limit: number;
  /** Rows strictly before this position in (created_at desc, id desc) order; the first page omits it. */
  before?: RfqListPosition;
}

/** RFQs of the session's mailbox and tenant; every method is scoped to both. */
export interface RfqRepository {
  /**
   * The mailbox's RFQs newest first, each with the customer mail it answers and how many of its
   * vendors have come back. One query: the source mail rides along as a relation and the counts
   * come from each RFQ's mails with their newest linked reply (take 1) and its current label.
   */
  listRfqs(scope: MailboxScope, query: ListRfqsQuery): Promise<RfqListItem[]>;
  createRfq(scope: MailboxScope, rfq: RfqToCreate): Promise<CreateRfqResult>;
  findRfq(scope: MailboxScope, rfqId: string): Promise<Rfq | undefined>;
  /**
   * The newest RFQ sent from a customer mail; undefined when none was. A mail processed twice has two
   * RFQs (source_email_id is indexed, not unique), and the thread view shows the latest.
   */
  findRfqBySourceEmail(scope: MailboxScope, sourceEmailId: string): Promise<Rfq | undefined>;
}

const RFQ_SELECT = {
  id: true,
  sourceEmailId: true,
  originPort: true,
  destinationPort: true,
  incoterm: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RfqSelect;

type RfqRow = Prisma.RfqGetPayload<{ select: typeof RFQ_SELECT }>;

/** RFQ_SELECT plus what the list needs: the customer mail and, per vendor mail, whether a reply came and what it was. */
const RFQ_LIST_ITEM_SELECT = {
  ...RFQ_SELECT,
  sourceEmail: {
    select: { id: true, senderName: true, senderEmail: true, subject: true, receivedAt: true },
  },
  sentMails: {
    select: {
      status: true,
      repliesReceived: {
        orderBy: [{ receivedAt: 'desc' as const }, { id: 'desc' as const }],
        take: 1,
        select: { classifications: CURRENT_CLASSIFICATION_SELECT },
      },
    },
  },
} satisfies Prisma.RfqSelect;

type RfqListItemRow = Prisma.RfqGetPayload<{ select: typeof RFQ_LIST_ITEM_SELECT }>;

export function toRfqListItem(row: RfqListItemRow): RfqListItem {
  const reachableMails = row.sentMails.filter((sentMail) => sentMail.status !== 'FAILED');
  const latestReplyLabels = reachableMails.map(
    (sentMail) =>
      toCurrentClassification(sentMail.repliesReceived[0]?.classifications ?? [])?.label,
  );
  return {
    rfq: toRfq(row),
    sourceEmail: {
      id: row.sourceEmail.id,
      senderName: row.sourceEmail.senderName,
      senderEmail: row.sourceEmail.senderEmail,
      subject: row.sourceEmail.subject,
      receivedAt: row.sourceEmail.receivedAt,
    },
    replies: {
      contactCount: reachableMails.length,
      repliedCount: reachableMails.filter((sentMail) => sentMail.repliesReceived.length > 0).length,
      quoteCount: latestReplyLabels.filter((label) => label === 'vendor_quote').length,
    },
  };
}

export function toRfq(row: RfqRow): Rfq {
  return {
    id: row.id,
    sourceEmailId: row.sourceEmailId,
    originPort: row.originPort,
    destinationPort: row.destinationPort,
    incoterm: row.incoterm,
    status: RFQ_STATUS_BY_PRISMA_ENUM[row.status],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPrismaRfqRepository(prismaClient: PrismaClient): RfqRepository {
  async function findInScope({ mailboxId, tenantId }: MailboxScope, rfqId: string) {
    const row = await prismaClient.rfq.findFirst({
      where: { id: rfqId, mailboxId, tenantId },
      select: RFQ_SELECT,
    });
    return row ? toRfq(row) : undefined;
  }

  return {
    async listRfqs({ mailboxId, tenantId }, { limit, before }) {
      const rows = await prismaClient.rfq.findMany({
        where: {
          mailboxId,
          tenantId,
          // (created_at, id) < (before.createdAt, before.id), spelled out for Prisma.
          ...(before
            ? {
                OR: [
                  { createdAt: { lt: before.createdAt } },
                  { createdAt: before.createdAt, id: { lt: before.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: RFQ_LIST_ITEM_SELECT,
      });
      return rows.map(toRfqListItem);
    },

    async createRfq(scope, rfq) {
      try {
        const row = await prismaClient.rfq.create({
          data: {
            id: rfq.id,
            tenantId: scope.tenantId,
            mailboxId: scope.mailboxId,
            sourceEmailId: rfq.sourceEmailId,
            originPort: rfq.originPort,
            destinationPort: rfq.destinationPort,
            incoterm: rfq.incoterm,
          },
          select: RFQ_SELECT,
        });
        return { outcome: 'created', rfq: toRfq(row) };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Insert first, look up on conflict: two concurrent requests with the same id cannot both create.
        const existing = await findInScope(scope, rfq.id);
        return existing ? { outcome: 'already_exists', rfq: existing } : { outcome: 'id_taken' };
      }
    },

    findRfq: findInScope,

    async findRfqBySourceEmail({ mailboxId, tenantId }, sourceEmailId) {
      const row = await prismaClient.rfq.findFirst({
        where: { sourceEmailId, mailboxId, tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: RFQ_SELECT,
      });
      return row ? toRfq(row) : undefined;
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
