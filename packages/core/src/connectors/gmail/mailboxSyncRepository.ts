import type { PrismaClient } from '../../db/prismaClient.js';
import type { GmailConnectionStatus, MailboxScope } from './mailboxConnectionRepository.js';
import { mapToSnakeCaseStatus } from './mailboxConnectionRepository.js';

/** What the push receiver needs to act on a Gmail notification for one address. */
export interface MailboxForPush extends MailboxScope {
  gmailConnectionStatus: GmailConnectionStatus;
  encryptedRefreshToken: string | null;
  lastHistoryId: bigint | null;
  /** From the tenant: the identity the push token must carry. Null until onboarding part C. */
  pushServiceAccountEmail: string | null;
}

/** What the processor needs to fetch one message for a mailbox named by id in a queue message. */
export interface MailboxForProcessing {
  gmailConnectionStatus: GmailConnectionStatus;
  encryptedRefreshToken: string | null;
}

/** A connected mailbox whose Gmail watch is about to lapse (or already has, or was never recorded). */
export interface MailboxForWatchRenewal extends MailboxScope {
  emailAddress: string;
  encryptedRefreshToken: string;
  watchExpiresAt: Date | null;
}

/**
 * Ingestion side of the mailbox row. The receiver looks up by Gmail address because a push names
 * the mailbox that way; the processor by id because the queue message carries the scope. The
 * tenant comes out of (or is checked against) the row and scopes every write.
 */
export interface MailboxSyncRepository {
  findMailboxForPush(emailAddress: string): Promise<MailboxForPush | undefined>;
  findMailboxForProcessing(scope: MailboxScope): Promise<MailboxForProcessing | undefined>;
  /** Connected mailboxes with a token whose watch expires before the deadline, is past, or is null. */
  findMailboxesWithWatchExpiringBefore(deadline: Date): Promise<MailboxForWatchRenewal[]>;
  /**
   * Records a renewed watch: only the expiry. The watch response's historyId is "now", and writing
   * it over the cursor would skip whatever a pending push has not listed yet.
   */
  saveWatchExpiry(scope: MailboxScope, expiresAt: Date): Promise<void>;
  /**
   * Moves the cursor forward only: concurrent receivers for one mailbox both succeed and the
   * higher id wins. Returns false when the stored cursor was already at or past historyId.
   */
  advanceHistoryCursor(scope: MailboxScope, historyId: bigint): Promise<boolean>;
  /** Gmail no longer has history from the stored cursor: restart from the push's id, gap accepted. */
  resetHistoryCursor(scope: MailboxScope, historyId: bigint): Promise<void>;
}

export function createPrismaMailboxSyncRepository(
  prismaClient: PrismaClient,
): MailboxSyncRepository {
  return {
    async findMailboxForPush(emailAddress) {
      const mailbox = await prismaClient.mailbox.findUnique({
        where: { emailAddress },
        select: {
          id: true,
          tenantId: true,
          gmailConnectionStatus: true,
          encryptedRefreshToken: true,
          lastHistoryId: true,
          tenant: { select: { pushServiceAccountEmail: true } },
        },
      });
      if (!mailbox) return undefined;
      return {
        mailboxId: mailbox.id,
        tenantId: mailbox.tenantId,
        gmailConnectionStatus: mapToSnakeCaseStatus(mailbox.gmailConnectionStatus),
        encryptedRefreshToken: mailbox.encryptedRefreshToken,
        lastHistoryId: mailbox.lastHistoryId,
        pushServiceAccountEmail: mailbox.tenant.pushServiceAccountEmail,
      };
    },

    async findMailboxForProcessing({ mailboxId, tenantId }) {
      const mailbox = await prismaClient.mailbox.findFirst({
        where: { id: mailboxId, tenantId },
        select: { gmailConnectionStatus: true, encryptedRefreshToken: true },
      });
      if (!mailbox) return undefined;
      return {
        gmailConnectionStatus: mapToSnakeCaseStatus(mailbox.gmailConnectionStatus),
        encryptedRefreshToken: mailbox.encryptedRefreshToken,
      };
    },

    async findMailboxesWithWatchExpiringBefore(deadline) {
      const mailboxes = await prismaClient.mailbox.findMany({
        where: {
          gmailConnectionStatus: 'CONNECTED',
          encryptedRefreshToken: { not: null },
          OR: [{ watchExpiresAt: { lt: deadline } }, { watchExpiresAt: null }],
        },
        select: {
          id: true,
          tenantId: true,
          emailAddress: true,
          encryptedRefreshToken: true,
          watchExpiresAt: true,
        },
        orderBy: { watchExpiresAt: 'asc' },
      });
      return mailboxes.flatMap((mailbox) =>
        mailbox.encryptedRefreshToken === null
          ? []
          : [
              {
                mailboxId: mailbox.id,
                tenantId: mailbox.tenantId,
                emailAddress: mailbox.emailAddress,
                encryptedRefreshToken: mailbox.encryptedRefreshToken,
                watchExpiresAt: mailbox.watchExpiresAt,
              },
            ],
      );
    },

    async saveWatchExpiry({ mailboxId, tenantId }, expiresAt) {
      await prismaClient.mailbox.updateMany({
        where: { id: mailboxId, tenantId },
        data: { watchExpiresAt: expiresAt },
      });
    },

    async advanceHistoryCursor({ mailboxId, tenantId }, historyId) {
      const result = await prismaClient.mailbox.updateMany({
        where: { id: mailboxId, tenantId, lastHistoryId: { lt: historyId } },
        data: { lastHistoryId: historyId },
      });
      return result.count === 1;
    },

    async resetHistoryCursor({ mailboxId, tenantId }, historyId) {
      await prismaClient.mailbox.updateMany({
        where: { id: mailboxId, tenantId },
        data: { lastHistoryId: historyId },
      });
    },
  };
}
