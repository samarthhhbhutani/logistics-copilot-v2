import { randomUUID } from 'node:crypto';
import type {
  MailboxConnection,
  MailboxConnectionRepository,
  MailboxCredentials,
  MailboxCredentialsRepository,
  TenantGoogleClient,
  TenantRepository,
} from '@lc/core';

/** Test doubles with the same contracts as the Prisma repositories, no database. */
export function createInMemoryRepositories(): {
  tenantRepository: TenantRepository;
  mailboxCredentialsRepository: MailboxCredentialsRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
} {
  const googleClientByTenantId = new Map<string, TenantGoogleClient>();
  const credentialsByEmail = new Map<string, MailboxCredentials>();
  const connectionByMailboxId = new Map<string, MailboxConnection>();

  function findInTenant(scope: { mailboxId: string; tenantId: string }) {
    const connection = connectionByMailboxId.get(scope.mailboxId);
    return connection?.tenantId === scope.tenantId ? connection : undefined;
  }

  return {
    tenantRepository: {
      async createTenant({ googleClientId, encryptedGoogleClientSecret }) {
        const tenantId = randomUUID();
        googleClientByTenantId.set(tenantId, {
          clientId: googleClientId,
          encryptedClientSecret: encryptedGoogleClientSecret,
        });
        return { tenantId };
      },
      async tenantExists(tenantId) {
        return googleClientByTenantId.has(tenantId);
      },
      async findTenantGoogleClient(tenantId) {
        return googleClientByTenantId.get(tenantId);
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
        });
        return credentials;
      },
    },
    mailboxConnectionRepository: {
      async findMailboxConnection(scope) {
        return findInTenant(scope);
      },
      async saveGmailConnection(scope, encryptedRefreshToken) {
        const connection = findInTenant(scope);
        if (!connection) return;
        connection.encryptedRefreshToken = encryptedRefreshToken;
        connection.gmailConnectionStatus = 'connected';
        connection.gmailConnectedAt = new Date();
      },
      async clearGmailConnection(scope) {
        const connection = findInTenant(scope);
        if (!connection) return;
        connection.encryptedRefreshToken = null;
        connection.gmailConnectionStatus = 'not_connected';
        connection.gmailConnectedAt = null;
      },
    },
  };
}
