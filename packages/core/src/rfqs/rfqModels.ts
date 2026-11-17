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

/** The customer mail an RFQ was sent from, as the RFQ list shows it: who asked and what for, no body. */
export interface RfqSourceEmail {
  id: string;
  senderName: string;
  senderEmail: string | null;
  subject: string;
  receivedAt: Date;
}

/**
 * How far an RFQ has come, counted in vendors rather than messages: a vendor who writes twice is
 * one reply, and the desk's question is "how many have come back", not "how much mail arrived".
 */
export interface RfqReplyCounts {
  /** Contacts the RFQ reached or may still reach: every mail of the RFQ that is not `failed`. */
  contactCount: number;
  /** Contacts with at least one inbound mail linked to their RFQ mail. */
  repliedCount: number;
  /** Contacts whose newest reply is labelled vendor_quote. */
  quoteCount: number;
}

/** One row of the RFQ list; the mails themselves come from GET /rfqs/:rfqId when a row is opened. */
export interface RfqListItem {
  rfq: Rfq;
  sourceEmail: RfqSourceEmail;
  replies: RfqReplyCounts;
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
