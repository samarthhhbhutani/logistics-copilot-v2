import type {
  SentMailKind as PrismaSentMailKind,
  SentMailStatus as PrismaSentMailStatus,
} from '../db/generated/client.js';
import type { EmailAddress } from '../utils/mime/parsedEmail.js';

export type SentMailKind = 'reply';

/**
 * pending: row written, nothing sent. sending: messages.send in flight. sent: Gmail accepted it.
 * failed: Gmail refused it (errorCode says why). A row left in `sending` by a crash or timeout is
 * healed when its SENT copy is ingested, or retried by an operator.
 */
export type SentMailStatus = 'pending' | 'sending' | 'sent' | 'failed';

/** One mail we sent or tried to send, as the API reads it. */
export interface SentMail {
  /** Client-generated; the idempotency key for the send request. */
  id: string;
  kind: SentMailKind;
  status: SentMailStatus;
  inReplyToEmailId: string | null;
  gmailThreadId: string | null;
  /** `<id@mailbox-domain>`; what the SENT copy carries as its Message-ID. */
  rfcMessageId: string;
  toRecipients: EmailAddress[];
  ccRecipients: EmailAddress[];
  subject: string;
  bodyText: string;
  gmailMessageId: string | null;
  sentEmailId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
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
};
export const SENT_MAIL_KIND_BY_PRISMA_ENUM: Record<PrismaSentMailKind, SentMailKind> = {
  REPLY: 'reply',
};
