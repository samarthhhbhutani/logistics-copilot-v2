import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';
import type { CurrentClassification } from '../emails/emailModels.js';
import {
  CLASSIFICATION_LABEL_BY_PRISMA_LABEL,
  CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE,
  PRISMA_LABEL_BY_CLASSIFICATION_LABEL,
  PRISMA_SOURCE_BY_CLASSIFICATION_SOURCE,
} from './classificationLabel.js';
import type { ClassificationLabel } from './classificationLabel.js';

export type AppendUserClassificationResult =
  | { outcome: 'appended'; classification: CurrentClassification }
  /** No email with that id in the scope's mailbox and tenant; the caller answers 404. */
  | { outcome: 'not_found' }
  /** The email is outbound (SENT); only inbound mail is classified. The caller answers 409. */
  | { outcome: 'not_inbound' };

/** Operator corrections to a mail's label. Rows are appended, never rewritten: the table is the label's history. */
export interface EmailClassificationRepository {
  /**
   * Appends a `source = user` row with the given label and returns it as the mail's current classification.
   * Appends even when the label equals the current one: a confirmation is a signal in its own right.
   */
  appendUserClassification(
    scope: MailboxScope,
    emailId: string,
    label: ClassificationLabel,
  ): Promise<AppendUserClassificationResult>;
}

export function createPrismaEmailClassificationRepository(
  prismaClient: PrismaClient,
): EmailClassificationRepository {
  return {
    async appendUserClassification({ mailboxId, tenantId }, emailId, label) {
      // Read then insert without a transaction: emails are only ever inserted, never updated or deleted,
      // so neither the row nor its gmail_label can change in between. Revisit if an email delete path lands.
      const email = await prismaClient.email.findFirst({
        where: { id: emailId, mailboxId, tenantId },
        select: { gmailLabel: true },
      });
      if (!email) return { outcome: 'not_found' };
      if (email.gmailLabel !== 'INBOX') return { outcome: 'not_inbound' };
      const row = await prismaClient.classification.create({
        data: {
          tenantId,
          emailId,
          label: PRISMA_LABEL_BY_CLASSIFICATION_LABEL[label],
          source: PRISMA_SOURCE_BY_CLASSIFICATION_SOURCE.user,
        },
        select: { label: true, source: true, confidence: true, classifiedAt: true },
      });
      return {
        outcome: 'appended',
        classification: {
          label: CLASSIFICATION_LABEL_BY_PRISMA_LABEL[row.label],
          source: CLASSIFICATION_SOURCE_BY_PRISMA_SOURCE[row.source],
          confidence: row.confidence,
          classifiedAt: row.classifiedAt,
        },
      };
    },
  };
}
