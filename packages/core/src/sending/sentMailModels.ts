import type {
  SentMailKind as PrismaSentMailKind,
  SentMailStatus as PrismaSentMailStatus,
} from '../db/generated/client.js';
import type { CurrentClassification } from '../emails/emailModels.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';

/** reply: answers an inbound mail in its thread. rfq: starts a new thread with one vendor for an RFQ. */
export type SentMailKind = 'reply' | 'rfq';

/**
 * pending: row written, nothing sent. sending: messages.send in flight. sent: Gmail accepted it.
 * failed: Gmail refused it (errorCode says why). A row left in `sending` by a crash or timeout is
 * healed when its SENT copy is ingested (matched on mailbox + rfcMessageId), or retried by an operator.
 */
export type SentMailStatus = 'pending' | 'sending' | 'sent' | 'failed';

/**
 * One mail we sent or tried to send, as the API reads it.
 *
 * Naming rule: `id` / `sentMailId` is a row in `sent_mails`; every `...EmailId` is a row in `emails`
 * (the ingested mail store), never the other way round.
 */
export interface SentMail {
  /** Client-generated; the idempotency key for the send request. */
  id: string;
  kind: SentMailKind;
  status: SentMailStatus;
  inReplyToEmailId: string | null;
  /** The RFQ, vendor and contact an `rfq` mail was sent for; all null for a reply. */
  rfqId: string | null;
  vendorId: string | null;
  vendorContactId: string | null;
  gmailThreadId: string | null;
  /** `<id@mailbox-domain>`; what the SENT copy carries as its Message-ID. */
  rfcMessageId: string;
  toRecipients: EmailAddress[];
  ccRecipients: EmailAddress[];
  subject: string;
  bodyText: string;
  gmailMessageId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The newest inbound mail answering one RFQ mail of ours: what a row on the RFQ page shows before
 * the operator opens the thread. No body: the thread view loads that.
 */
export interface RfqLatestReply {
  emailId: string;
  senderName: string;
  senderEmail: string | null;
  receivedAt: Date;
  snippet: string;
  classification: CurrentClassification | null;
}

/** What came back for one RFQ mail, as emails.answers_sent_mail_id links it. */
export interface RfqMailReplies {
  count: number;
  /** Undefined until the vendor answers. */
  latest: RfqLatestReply | undefined;
}

/** An RFQ mail together with the replies it has drawn; what the RFQ page lists per contact. */
export interface RfqMailWithReplies extends SentMail {
  replies: RfqMailReplies;
}

// Prisma generates UPPER_CASE enum members; the API and the columns speak snake_case.
export const PRISMA_ENUM_BY_SENT_MAIL_STATUS: Record<SentMailStatus, PrismaSentMailStatus> = {
  pending: 'PENDING',
  sending: 'SENDING',
  sent: 'SENT',
  failed: 'FAILED',
};
export const SENT_MAIL_STATUS_BY_PRISMA_ENUM: Record<PrismaSentMailStatus, SentMailStatus> = {
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
};
export const PRISMA_ENUM_BY_SENT_MAIL_KIND: Record<SentMailKind, PrismaSentMailKind> = {
  reply: 'REPLY',
  rfq: 'RFQ',
};
export const SENT_MAIL_KIND_BY_PRISMA_ENUM: Record<PrismaSentMailKind, SentMailKind> = {
  REPLY: 'reply',
  RFQ: 'rfq',
};
