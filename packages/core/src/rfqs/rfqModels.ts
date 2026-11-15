import type { RfqStatus as PrismaRfqStatus } from '../db/generated/client.js';

/** open: sent to vendors, quotes may still arrive. closed: the operator is done with it. */
export type RfqStatus = 'open' | 'closed';

/**
 * One customer request turned into vendor mails. Only the ports and incoterm are columns; the rest
 * of the shipment details live on in the mails (sent_mails by rfqId). The same customer mail may be
 * processed more than once, each time as its own RFQ.
 */
export interface Rfq {
  /** Client-generated; the idempotency key for the send request. */
  id: string;
  sourceEmailId: string;
  originPort: string;
  destinationPort: string;
  incoterm: string | null;
  status: RfqStatus;
  createdAt: Date;
  updatedAt: Date;
}

// Prisma generates UPPER_CASE enum members; the API and the column speak lowercase.
export const PRISMA_ENUM_BY_RFQ_STATUS: Record<RfqStatus, PrismaRfqStatus> = {
  open: 'OPEN',
  closed: 'CLOSED',
};
export const RFQ_STATUS_BY_PRISMA_ENUM: Record<PrismaRfqStatus, RfqStatus> = {
  OPEN: 'open',
  CLOSED: 'closed',
};
