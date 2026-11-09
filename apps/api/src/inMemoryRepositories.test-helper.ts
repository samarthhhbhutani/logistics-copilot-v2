import { randomUUID } from 'node:crypto';
import type {
  EmailRepository,
  EmailSummary,
  MailboxConnection,
  MailboxConnectionRepository,
  MailboxCredentials,
  MailboxCredentialsRepository,
  TenantGoogleClient,
  TenantPubsubPush,
  TenantRepository,
} from '@lc/core';

/** Test doubles with the same contracts as the Prisma repositories, no database. */
export function createInMemoryRepositories(): {
  tenantRepository: TenantRepository;
  mailboxCredentialsRepository: MailboxCredentialsRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  emailRepository: EmailRepository;
  /** Seeds the inbox list directly; the processor's insert path is not part of the API. */
  addEmail(email: EmailSummary & { mailboxId: string; tenantId: string }): void;
} {
  const googleClientByTenantId = new Map<string, TenantGoogleClient>();
  const pubsubPushByTenantId = new Map<string, TenantPubsubPush>();
  const credentialsByEmail = new Map<string, MailboxCredentials>();
  const connectionByMailboxId = new Map<string, MailboxConnection>();
  const emails: (EmailSummary & { mailboxId: string; tenantId: string })[] = [];

  function findInTenant(scope: { mailboxId: string; tenantId: string }) {
    const connection = connectionByMailboxId.get(scope.mailboxId);
    return connection?.tenantId === scope.tenantId ? connection : undefined;
  }

  return {
    tenantRepository: {
      async createTenant({
        googleClientId,
        encryptedGoogleClientSecret,
        pubsubTopicName,
        pushServiceAccountEmail,
      }) {
        const tenantId = randomUUID();
        googleClientByTenantId.set(tenantId, {
          clientId: googleClientId,
          encryptedClientSecret: encryptedGoogleClientSecret,
        });
        pubsubPushByTenantId.set(tenantId, { topicName: pubsubTopicName, pushServiceAccountEmail });
        return { tenantId };
      },
      async tenantExists(tenantId) {
        return googleClientByTenantId.has(tenantId);
      },
      async findTenantGoogleClient(tenantId) {
        return googleClientByTenantId.get(tenantId);
      },
      async findTenantPubsubPush(tenantId) {
        return pubsubPushByTenantId.get(tenantId);
      },
    },
    mailboxCredentialsRepository: {
      async findMailboxCredentials(emailAddress) {
        return credentialsByEmail.get(emailAddress);
      },
      async createMailboxCredentials({ tenantId, emailAddress, passwordHash }) {
        const credentials = { mailboxId: randomUUID(), tenantId, passwordHash };
        credentialsByEmail.set(emailAddress, credentials);
        connectionByMailboxId.set(credentials.mailboxId, {
          mailboxId: credentials.mailboxId,
          tenantId,
          emailAddress,
          gmailConnectionStatus: 'not_connected',
          gmailConnectedAt: null,
          encryptedRefreshToken: null,
          watchExpiresAt: null,
        });
        return credentials;
      },
    },
    emailRepository: {
      async listEmails({ mailboxId, tenantId }, { limit, gmailLabel, before }) {
        return emails
          .filter((email) => email.mailboxId === mailboxId && email.tenantId === tenantId)
          .filter((email) => !gmailLabel || email.gmailLabel === gmailLabel)
          .filter(
            (email) =>
              !before ||
              email.receivedAt < before.receivedAt ||
              (email.receivedAt.getTime() === before.receivedAt.getTime() && email.id < before.id),
          )
          .sort(
            (left, right) =>
              right.receivedAt.getTime() - left.receivedAt.getTime() ||
              (right.id > left.id ? 1 : -1),
          )
          .slice(0, limit);
      },
      async emailExists() {
        throw new Error('not used by the API');
      },
      async insertEmailIfAbsent() {
        throw new Error('not used by the API');
      },
    },
    addEmail(email) {
      emails.push(email);
    },
    mailboxConnectionRepository: {
      async findMailboxConnection(scope) {
        return findInTenant(scope);
      },
      async saveGmailConnection(scope, { encryptedRefreshToken, watchExpiresAt }) {
        const connection = findInTenant(scope);
        if (!connection) return;
        connection.encryptedRefreshToken = encryptedRefreshToken;
        connection.gmailConnectionStatus = 'connected';
        connection.gmailConnectedAt = new Date();
        connection.watchExpiresAt = watchExpiresAt;
      },
      async markGmailNeedsReconnect(scope) {
        const connection = findInTenant(scope);
        if (connection) connection.gmailConnectionStatus = 'needs_reconnect';
      },
      async clearGmailConnection(scope) {
        const connection = findInTenant(scope);
        if (!connection) return;
        connection.encryptedRefreshToken = null;
        connection.gmailConnectionStatus = 'not_connected';
        connection.gmailConnectedAt = null;
        connection.watchExpiresAt = null;
      },
    },
  };
}
