import type { PrismaClient } from '../../db/prismaClient.js';
import type { GmailConnectionStatus as PrismaGmailConnectionStatus } from '../../db/generated/client.js';

export type GmailConnectionStatus = 'not_connected' | 'connected' | 'needs_reconnect';

/** A mailbox as the connect flow sees it: whose inbox, and whether we hold a working token. */
export interface MailboxConnection {
  mailboxId: string;
  tenantId: string;
  emailAddress: string;
  gmailConnectionStatus: GmailConnectionStatus;
  gmailConnectedAt: Date | null;
  encryptedRefreshToken: string | null;
  /** When the current Gmail watch lapses; null when not connected. */
  watchExpiresAt: Date | null;
  /** Plain text appended to every mail sent from this mailbox; null when none is set. */
  signature: string | null;
}

/** Everything a successful connect produces: the token and the watch it started. */
export interface GmailConnectionToSave {
  encryptedRefreshToken: string;
  /** Cursor for the first history.list, from the users.watch response. */
  lastHistoryId: bigint;
  watchExpiresAt: Date;
}

/** Every lookup carries the session's tenantId: a mailbox outside the tenant is simply not found. */
export interface MailboxScope {
  mailboxId: string;
  tenantId: string;
}

export interface MailboxConnectionRepository {
  findMailboxConnection(scope: MailboxScope): Promise<MailboxConnection | undefined>;
  saveGmailConnection(scope: MailboxScope, connection: GmailConnectionToSave): Promise<void>;
  /** The refresh token stopped working (invalid_grant): keep the row, ask the owner to reconnect. */
  markGmailNeedsReconnect(scope: MailboxScope): Promise<void>;
  clearGmailConnection(scope: MailboxScope): Promise<void>;
  /** Replace the stored signature; null removes it. */
  updateSignature(scope: MailboxScope, signature: string | null): Promise<void>;
}

// Prisma generates UPPER_CASE enum members; the API and the column speak snake_case.
const SNAKE_CASE_STATUS_BY_PRISMA_ENUM: Record<PrismaGmailConnectionStatus, GmailConnectionStatus> =
  {
    NOT_CONNECTED: 'not_connected',
    CONNECTED: 'connected',
    NEEDS_RECONNECT: 'needs_reconnect',
  };

export function mapToSnakeCaseStatus(
  prismaStatus: PrismaGmailConnectionStatus,
): GmailConnectionStatus {
  return SNAKE_CASE_STATUS_BY_PRISMA_ENUM[prismaStatus];
}

export function createPrismaMailboxConnectionRepository(
  prismaClient: PrismaClient,
): MailboxConnectionRepository {
  return {
    async findMailboxConnection({ mailboxId, tenantId }) {
      const mailbox = await prismaClient.mailbox.findFirst({
        where: { id: mailboxId, tenantId },
        select: {
          id: true,
          tenantId: true,
          emailAddress: true,
          gmailConnectionStatus: true,
          gmailConnectedAt: true,
          encryptedRefreshToken: true,
          watchExpiresAt: true,
          signature: true,
        },
      });
      if (!mailbox) return undefined;
      return {
        mailboxId: mailbox.id,
        tenantId: mailbox.tenantId,
        emailAddress: mailbox.emailAddress,
        gmailConnectionStatus: mapToSnakeCaseStatus(mailbox.gmailConnectionStatus),
        gmailConnectedAt: mailbox.gmailConnectedAt,
        encryptedRefreshToken: mailbox.encryptedRefreshToken,
        watchExpiresAt: mailbox.watchExpiresAt,
        signature: mailbox.signature,
      };
    },

    // updateMany (not update) so tenantId can sit in the where clause: a mailbox outside the
    // tenant matches zero rows instead of throwing, the same "not found" shape as the lookup.
    async saveGmailConnection(
      { mailboxId, tenantId },
      { encryptedRefreshToken, lastHistoryId, watchExpiresAt },
    ) {
      await prismaClient.mailbox.updateMany({
        where: { id: mailboxId, tenantId },
        data: {
          encryptedRefreshToken,
          gmailConnectionStatus: 'CONNECTED',
          gmailConnectedAt: new Date(),
          lastHistoryId,
          watchExpiresAt,
        },
      });
    },

    async markGmailNeedsReconnect({ mailboxId, tenantId }) {
      await prismaClient.mailbox.updateMany({
        where: { id: mailboxId, tenantId },
        data: { gmailConnectionStatus: 'NEEDS_RECONNECT' },
      });
    },

    async clearGmailConnection({ mailboxId, tenantId }) {
      await prismaClient.mailbox.updateMany({
        where: { id: mailboxId, tenantId },
        data: {
          encryptedRefreshToken: null,
          gmailConnectionStatus: 'NOT_CONNECTED',
          gmailConnectedAt: null,
          // Sync state from the old connection would be wrong for the next one.
          lastHistoryId: null,
          watchExpiresAt: null,
        },
      });
    },

    async updateSignature({ mailboxId, tenantId }, signature) {
      await prismaClient.mailbox.updateMany({
        where: { id: mailboxId, tenantId },
        data: { signature },
      });
    },
  };
}
